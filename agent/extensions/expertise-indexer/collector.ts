/**
 * expertise-indexer/collector.ts — pure primitives for the canonical expertise
 * pipeline (#599/#1055). The byte-level contracts are shared by the serial
 * sequence gate, subagent runtime wiring, CI audit, and approval loop.
 *
 * Pipeline: build one canonical search block for the ordered research sequence,
 * inject it identically into every independent child as user-role content, then
 * extract and coalesce returned candidates after all children complete. Human
 * approval remains outside this module.
 *
 * This module owns the string shapes and coalesce semantics. It does
 * NOT read files (Form A path validation returns the path; the caller
 * reads it inside its own trust boundary) and NOT call `expertise_search`
 * (that's a runtime concern owned by the orchestrator or by the wiring
 * in #611). Keeping it pure lets #601 / #604 share the exact same
 * semantics without dragging in tool infrastructure.
 *
 * SECURITY POSTURE
 * ----------------
 * Every consumer-visible string is either (a) a constant, (b) a value
 * from a bounded allowlist, or (c) routed through `acceptCandidates`
 * (which enforces the universal-first-scan invariant from #608, so
 * secret-shaped substrings never reach a rejection hint). Path
 * validation for Form A rejects anything outside the
 * `/tmp/subagent-expertise-<name>-<unix-ts>.candidates.json` shape —
 * no `..`, no null bytes, no double-slash, no non-ASCII. The consumer
 * is still responsible for `realpath` + O_NOFOLLOW-equivalent checks
 * before opening the file (documented in the rule and in #611).
 */

import { createHash } from "node:crypto";

import {
	acceptCandidates,
	type ProjectedCandidate,
	type RejectedCandidate,
} from "./candidate-gate.ts";
import { isValidGitSha, normalizeText } from "./canonicalize.ts";

// -----------------------------------------------------------------------------
// 1. Canonical query builder
// -----------------------------------------------------------------------------

/**
 * Canonical-query token cap. Matches the #599 issue body: "lowercase,
 * ≤12 tokens". The cap keeps the query stable across paraphrase noise
 * (short queries dedupe well against the vector index) and defends the
 * expertise-api's 10 req/min budget from bloated queries that would
 * otherwise blow the cache-key space.
 */
export const MAX_CANONICAL_QUERY_TOKENS = 12;

/**
 * Schema version for the injection block. Bumping this is
 * semver-breaking for every consumer (CI audit, pre-push hook,
 * subagent runtime wiring). Do not bump lightly.
 */
export const CANONICAL_RESULTS_SCHEMA_VERSION = 1;

/**
 * Structured inputs for `buildCanonicalQuery`. The issue names the
 * template `<domain> <technology> <task-type> <goal/symptom>`; we take
 * the pieces as separate fields so callers can populate what they know
 * without the module having to heuristically parse free-text briefs
 * (that heuristic would need per-domain tuning and would break the
 * "deterministic" contract).
 *
 * All fields optional so a caller with only 2 of 4 pieces still gets a
 * usable query. All-empty returns "".
 */
export interface CanonicalQueryInputs {
	readonly domain?: string;
	readonly technology?: string;
	readonly taskType?: string;
	readonly goalOrSymptom?: string;
}

/**
 * Build the canonical query string.
 *
 * Pipeline (in order):
 *   1. NFKC-normalize each field.
 *   2. Lowercase.
 *   3. Strip characters outside `[a-z0-9\-_./ ]` (URLs, punctuation,
 *      emoji, quote marks, backticks all disappear — noise for the
 *      vector index).
 *   4. Collapse whitespace runs to single spaces.
 *   5. Concatenate in fixed order: domain, technology, taskType,
 *      goalOrSymptom (order is part of the deterministic contract).
 *   6. Tokenize on whitespace, dedupe **adjacent** duplicates only
 *      (preserves `"kubernetes kubernetes"` → `"kubernetes"` from a
 *      double-populated field, but keeps `"kafka msk kafka"` intact —
 *      non-adjacent repetition may be semantically meaningful).
 *   7. Clamp to `MAX_CANONICAL_QUERY_TOKENS`.
 *
 * Returns "" iff no tokens survive — caller should skip
 * `expertise_search` in that case (avoids a garbage query eating the
 * rate-limit budget).
 */
export function buildCanonicalQuery(inputs: CanonicalQueryInputs): string {
	const norm = (s: string | undefined): string => {
		if (!s) return "";
		return normalizeText(s)
			.toLowerCase()
			.replace(/[^a-z0-9\-_./ \t\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	};

	const parts = [
		norm(inputs.domain),
		norm(inputs.technology),
		norm(inputs.taskType),
		norm(inputs.goalOrSymptom),
	].filter((s) => s.length > 0);

	const joined = parts.join(" ");
	if (!joined) return "";

	const tokens = joined.split(" ");
	const deduped: string[] = [];
	for (const t of tokens) {
		if (deduped.length === 0 || deduped[deduped.length - 1] !== t) {
			deduped.push(t);
		}
	}

	return deduped.slice(0, MAX_CANONICAL_QUERY_TOKENS).join(" ");
}

// -----------------------------------------------------------------------------
// 2. Canonical results injection block
// -----------------------------------------------------------------------------

/**
 * A single result row emitted by `expertise_search` for injection.
 * Field set is deliberately a SUBSET of the full expertise-api entry —
 * approval fields, timestamps, and internal identifiers are excluded
 * because they are neither useful to the subagent nor safe to place in
 * the brief.
 */
export interface CanonicalResultEntry {
	readonly id: string;
	readonly domain: string;
	readonly title: string;
	readonly body: string;
	readonly entryType: string;
	readonly severity: string;
	readonly source?: string;
	readonly sourceVersion?: string;
	readonly tags?: readonly string[];
}

export const CANONICAL_RESULTS_BEGIN_MARKER = "<!-- BEGIN CANONICAL_EXPERTISE_RESULTS";
export const CANONICAL_RESULTS_END_MARKER = "<!-- END CANONICAL_EXPERTISE_RESULTS -->";

/**
 * Per-result body byte cap for the injection block. A subagent brief
 * is bounded (the parent's per-child prompt is subject to the same
 * per-tool-result cap that gate the sequence), so we cap each result
 * body to keep the block from blowing out that budget on a single
 * verbose expertise entry.
 */
export const MAX_INJECTED_BODY_BYTES = 4096;

/**
 * Overall injection-block byte cap. Sizing rationale: at ≤5 results ×
 * ≤4 KB each plus envelope, this keeps the block under 24 KB, well
 * below the #600 32 KB Form-B-to-Form-A threshold that governs the
 * sibling `EXPERTISE_CANDIDATES` transport. If a caller passes a
 * result set that exceeds this cap, the block is truncated
 * result-by-result from the tail and a `truncated: true` flag is set
 * in the envelope (never mid-result — that would break JSON round-trip).
 */
export const MAX_INJECTION_BLOCK_BYTES = 24 * 1024;

/**
 * Render the canonical results block for injection into a subagent
 * brief. Format:
 *
 *   <!-- BEGIN CANONICAL_EXPERTISE_RESULTS canonical_blob_sha=<sha> schemaVersion=1 -->
 *   {"schemaVersion":1,"canonical_blob_sha":"<sha>","truncated":false,"results":[...]}
 *   <!-- END CANONICAL_EXPERTISE_RESULTS -->
 *
 * The JSON payload is machine-parseable via `parseCanonicalResultsBlock`
 * (round-trip locked by test). Prose is deliberately absent — a
 * subagent that wants to render prose should do so downstream from
 * this structured input, not upstream where format drift would break
 * every consumer.
 *
 * Throws `TypeError` if `canonicalBlobSha` fails `isValidGitSha`
 * (defensive — a malformed anchor would leak into every child brief).
 */
export function renderCanonicalResultsBlock(
	results: readonly CanonicalResultEntry[],
	canonicalBlobSha: string,
): string {
	if (!isValidGitSha(canonicalBlobSha)) {
		throw new TypeError(
			`renderCanonicalResultsBlock: canonicalBlobSha is not a valid git SHA (40 or 64 hex lowercase)`,
		);
	}

	// Project each result — strip prototype, cap body, drop optional
	// keys when absent (keeps the JSON small and stable).
	const project = (r: CanonicalResultEntry): Record<string, unknown> => {
		const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		out.id = String(r.id);
		out.domain = String(r.domain);
		out.title = String(r.title);
		out.body = capBody(String(r.body));
		out.entryType = String(r.entryType);
		out.severity = String(r.severity);
		if (r.source !== undefined) out.source = String(r.source);
		if (r.sourceVersion !== undefined) out.sourceVersion = String(r.sourceVersion);
		if (r.tags !== undefined) out.tags = r.tags.map((t) => String(t));
		return out;
	};

	// Truncate result-by-result from the tail until the whole block
	// fits `MAX_INJECTION_BLOCK_BYTES`. Never truncate mid-result.
	let projected = results.map(project);
	let truncated = false;
	let block = buildBlockString(projected, canonicalBlobSha, truncated);
	while (Buffer.byteLength(block, "utf8") > MAX_INJECTION_BLOCK_BYTES && projected.length > 0) {
		projected = projected.slice(0, -1);
		truncated = true;
		block = buildBlockString(projected, canonicalBlobSha, truncated);
	}

	return block;
}

function buildBlockString(
	results: readonly Record<string, unknown>[],
	canonicalBlobSha: string,
	truncated: boolean,
): string {
	const payload = {
		schemaVersion: CANONICAL_RESULTS_SCHEMA_VERSION,
		canonical_blob_sha: canonicalBlobSha,
		truncated,
		results,
	};
	const header = `${CANONICAL_RESULTS_BEGIN_MARKER} canonical_blob_sha=${canonicalBlobSha} schemaVersion=${CANONICAL_RESULTS_SCHEMA_VERSION} -->`;
	// End-marker collision defense (per re-review of #599). `JSON.stringify`
	// does not escape `>`, so any user-controlled string field containing
	// literal `-->` (or, in the pathological case, the full END marker) would
	// slip verbatim into the payload and confuse the reciprocal `indexOf`
	// scan in `parseCanonicalResultsBlock`. We substitute `--\u003e` for every
	// `-->` in the serialized JSON; `JSON.parse` decodes `\u003e` back to `>`
	// natively, so round-trip is exact and no reciprocal replace on the parse
	// side is needed. The `indexOf(END_MARKER)` scan in the parser then finds
	// only the real terminator.
	const safeJson = JSON.stringify(payload).replace(/-->/g, "--\\u003e");
	return `${header}\n${safeJson}\n${CANONICAL_RESULTS_END_MARKER}`;
}

function capBody(body: string): string {
	const buf = Buffer.from(body, "utf8");
	if (buf.length <= MAX_INJECTED_BODY_BYTES) return body;
	// Reserve budget for the suffix so the RENDERED body (source + suffix)
	// fits `MAX_INJECTED_BODY_BYTES` — addresses the code-review Info finding
	// that the pre-hardening implementation allowed the returned body to
	// exceed the cap by ~24–30 suffix bytes. The suffix is a bounded-width
	// ASCII template `…[truncated <int> bytes]`; we compute its byte length
	// against the worst-case source-cut position and reserve that many bytes
	// up front.
	const worstCaseSuffix = `…[truncated ${buf.length} bytes]`;
	const suffixBudget = Buffer.byteLength(worstCaseSuffix, "utf8");
	let cut = Math.max(0, MAX_INJECTED_BODY_BYTES - suffixBudget);
	// Cut at a valid UTF-8 boundary: drop the last few bytes until
	// `Buffer.toString('utf8')` round-trips a valid string without
	// replacement characters at the boundary.
	while (cut > 0) {
		const slice = buf.subarray(0, cut).toString("utf8");
		if (!slice.endsWith("\uFFFD")) {
			return `${slice}…[truncated ${buf.length - cut} bytes]`;
		}
		cut -= 1;
	}
	return "…[truncated]";
}

/**
 * Parse a canonical-results block back into its payload. Used by CI
 * audit (#601) to validate that briefs actually carry the block, and
 * by the round-trip test. Returns null if the input contains no valid
 * block. Throws `TypeError` on any structural failure inside the block
 * (unclosed header, malformed JSON, non-object payload) — a single
 * exception type across all invalid-structure cases so callers can
 * write one `catch (e) { if (e instanceof TypeError) … }` branch.
 *
 * PROVENANCE CONTRACT (#631): callers MUST pass only the generated
 * artifact — the exact `renderCanonicalResultsBlock` output (equivalently
 * the `expertiseInjection` string) — never a transcript, child stdout, or
 * any buffer where untrusted content could precede the block. The parser
 * enforces the enforceable half of that contract: the BEGIN marker must
 * sit at the very start of the input (an optional BOM / leading
 * whitespace is tolerated). A marker present anywhere else fails closed
 * with `TypeError` — deliberately distinguishable from the benign
 * "no block present" null, so an audit consumer (#601) sees a forged or
 * displaced block as a failure, not a skip. Content after the first
 * block is ignored, so a child echoing the block back (quoted or
 * tampered) can never override the anchored one. The escape defense in
 * `buildBlockString` protects bytes the generator emitted; this anchor
 * protects against bytes upstream of it.
 */
export function parseCanonicalResultsBlock(input: string): CanonicalResultsPayload | null {
	// #631: anchor scan — skip an optional BOM/leading whitespace (JS `\s`
	// matches U+FEFF), then require the marker exactly there.
	let anchorIdx = 0;
	while (anchorIdx < input.length && /\s/.test(input[anchorIdx])) anchorIdx += 1;

	if (!input.startsWith(CANONICAL_RESULTS_BEGIN_MARKER, anchorIdx)) {
		if (input.includes(CANONICAL_RESULTS_BEGIN_MARKER)) {
			throw new TypeError(
				"canonical results BEGIN marker is present but not at the start of the input — " +
					"callers must pass only the generated artifact (provenance contract, #631)",
			);
		}
		return null;
	}
	const beginIdx = anchorIdx;
	const endMarkerIdx = input.indexOf(CANONICAL_RESULTS_END_MARKER, beginIdx);
	if (endMarkerIdx < 0) return null;
	// The opening marker line ends at the first `-->` after beginIdx.
	const headerCloseIdx = input.indexOf("-->", beginIdx);
	if (headerCloseIdx < 0 || headerCloseIdx > endMarkerIdx) return null;
	const jsonStart = headerCloseIdx + 3;
	const jsonRaw = input.slice(jsonStart, endMarkerIdx).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonRaw);
	} catch (e) {
		// Uniform error contract — rethrow SyntaxError as TypeError with the
		// original preserved as `cause` (per re-review Info finding).
		throw new TypeError(
			`canonical results payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
			{ cause: e },
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError("canonical results payload is not a plain object");
	}
	return parsed as CanonicalResultsPayload;
}

export interface CanonicalResultsPayload {
	readonly schemaVersion: number;
	readonly canonical_blob_sha: string;
	readonly truncated: boolean;
	readonly results: readonly Record<string, unknown>[];
}

// -----------------------------------------------------------------------------
// 3. EXPERTISE_CANDIDATES payload extraction
// -----------------------------------------------------------------------------

export const EXPERTISE_CANDIDATES_BEGIN_MARKER = "<!-- BEGIN EXPERTISE_CANDIDATES";
export const EXPERTISE_CANDIDATES_END_MARKER = "<!-- END EXPERTISE_CANDIDATES -->";

/**
 * Form-A REPORT_FILE path allowlist per #600. Matches exactly
 * `/tmp/subagent-expertise-<name>-<unix-ts>.candidates.json`:
 *   - `<name>`: 1+ chars from `[a-z0-9-]`
 *   - `<unix-ts>`: 1+ digits
 * Rejects: `..`, double-slash, null bytes, non-ASCII, any other
 * directory, any other filename shape.
 */
const FORM_A_PATH_RE =
	/^\/tmp\/subagent-expertise-[a-z0-9-]+-\d+\.candidates\.json$/;

export type ExtractedPayload =
	| {
			readonly form: "B";
			readonly rawJson: string;
			/**
			 * Byte offset in the source blob where the BEGIN marker was
			 * found. Debugging aid — do not treat as a stable API for
			 * ordering or slicing; ordering is provided by the array
			 * position in the return value, which reflects source-order.
			 */
			readonly origin: number;
	  }
	| {
			readonly form: "A";
			readonly reportFile: string;
			/** See `origin` note on the Form B branch. */
			readonly origin: number;
	  };

/**
 * Extract EXPERTISE_CANDIDATES payloads from a child subagent's raw
 * output blob. Returns:
 *   - Form B entries with `rawJson` set to the fenced-block payload
 *     text (caller feeds this into `acceptCandidates`).
 *   - Form A entries with `reportFile` set to the validated path
 *     (caller reads the file inside its own trust boundary — this
 *     module does no I/O).
 *
 * Multiple blocks in one output are allowed (a subagent may emit
 * candidates in stages). Malformed blocks (unclosed, path fails the
 * allowlist) are silently skipped — the transport rule (#600) is
 * fail-open at extraction and fail-closed at ingestion, so a subagent
 * that emits garbage simply contributes zero candidates rather than
 * blowing up the whole sequence.
 */
export function extractCandidatePayloads(childOutput: string): ExtractedPayload[] {
	const out: ExtractedPayload[] = [];

	// Form B: fenced blocks. Scan sequentially.
	let cursor = 0;
	while (cursor < childOutput.length) {
		const beginIdx = childOutput.indexOf(EXPERTISE_CANDIDATES_BEGIN_MARKER, cursor);
		if (beginIdx < 0) break;
		const endMarkerIdx = childOutput.indexOf(EXPERTISE_CANDIDATES_END_MARKER, beginIdx);
		if (endMarkerIdx < 0) break; // unclosed — skip rest
		const headerCloseIdx = childOutput.indexOf("-->", beginIdx);
		if (headerCloseIdx < 0 || headerCloseIdx > endMarkerIdx) {
			cursor = endMarkerIdx + EXPERTISE_CANDIDATES_END_MARKER.length;
			continue;
		}
		const jsonRaw = childOutput.slice(headerCloseIdx + 3, endMarkerIdx).trim();
		if (jsonRaw.length > 0) {
			out.push({ form: "B", rawJson: jsonRaw, origin: beginIdx });
		}
		cursor = endMarkerIdx + EXPERTISE_CANDIDATES_END_MARKER.length;
	}

	// Form A: REPORT_FILE lines. Line-anchored to avoid picking up
	// mentions inside prose (`the REPORT_FILE convention says…`).
	// Regex is line-anchored via a positive lookbehind on start-of-string
	// or newline; validated against the allowlist before acceptance.
	// Duplicate paths (same string emitted on two lines) are collapsed
	// at extraction so downstream `proposalCount` / `variantCount` are
	// not inflated by repetition of a single report file.
	const formARe = /(^|\n)REPORT_FILE:\s*([^\s\r\n]+)/g;
	const seenFormA = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = formARe.exec(childOutput)) !== null) {
		const rawPath = m[2];
		if (!rawPath) continue;
		if (rawPath.includes("\0")) continue;
		if (!FORM_A_PATH_RE.test(rawPath)) continue;
		if (seenFormA.has(rawPath)) continue;
		seenFormA.add(rawPath);
		out.push({ form: "A", reportFile: rawPath, origin: m.index + m[1].length });
	}

	return out;
}

// -----------------------------------------------------------------------------
// 4. Coalesce
// -----------------------------------------------------------------------------

export interface CoalesceInput {
	readonly rawJson: string;
	readonly proposedBy: string;
}

export interface CoalescedGroup {
	/** sha256 hex of the normalized `{domain, title}` fingerprint. */
	readonly fingerprint: string;
	/**
	 * Canonical candidate for the group. When multiple concrete
	 * candidates share a fingerprint but differ in body/tags/etc., the
	 * chosen representative is the one with the longest body (higher-
	 * information tie-breaker; deterministic because on true body-tie
	 * the input order breaks the tie).
	 *
	 * SECURITY: when `variantCount > 1` the approval UI (#605) MUST NOT
	 * present this single representative as "the consensus" — a longer
	 * body from ONE proposer would otherwise be attributed to every
	 * agent in `proposedByList`. The approval UI MUST render the
	 * per-proposer body hashes below and offer inspection of each
	 * concrete variant before approval. This is a design invariant
	 * layered ON TOP of the pure-lib output; the library exposes the
	 * necessary data via `bodyHashesByProposer` so consumers cannot
	 * accidentally miss the divergence.
	 */
	readonly candidate: ProjectedCandidate;
	/**
	 * All subagent names that proposed a candidate matching this
	 * fingerprint. Sorted lexicographically, de-duplicated. Sourced
	 * from `CoalesceInput.proposedBy` (orchestrator-supplied,
	 * out-of-band) NEVER from `candidate.proposedBy` — the untrusted
	 * candidate field cannot be used to forge attribution.
	 */
	readonly proposedByList: readonly string[];
	/**
	 * Number of concrete candidates that collapsed into this group.
	 * `> 1` means at least one duplicate proposal.
	 */
	readonly proposalCount: number;
	/**
	 * Number of DISTINCT concrete-candidate shapes in the group
	 * (fingerprint-collision ∩ non-fingerprint-field-divergence).
	 * Order-INDEPENDENT: computed via a Set of shape keys, so identical
	 * inputs in any permutation yield the same `variantCount`. `1`
	 * means every proposer contributed the same concrete shape;
	 * `> 1` triggers the SECURITY note on `candidate` above.
	 */
	readonly variantCount: number;
	/**
	 * SHA-256 hex of each proposer's body (per proposer identity in
	 * `proposedByList`). Present ONLY when `variantCount > 1` —
	 * uniform-group case omits it to keep the common output small.
	 * Enables the approval UI to enforce per-proposer body inspection
	 * without re-parsing the source payloads. If a single proposer
	 * contributed multiple concrete variants, the LAST-seen body's
	 * hash wins for that proposer (rare in practice; documented so
	 * consumers can defend if needed).
	 */
	readonly bodyHashesByProposer?: Readonly<Record<string, string>>;
}

export interface CoalesceRejection extends RejectedCandidate {
	readonly proposedBy: string;
}

export interface CoalesceResult {
	readonly groups: readonly CoalescedGroup[];
	readonly rejected: readonly CoalesceRejection[];
}

/**
 * Coalesce a set of subagent-emitted candidate payloads into a
 * deduplicated group list ready for human approval.
 *
 * Pipeline per input:
 *   1. `acceptCandidates(rawJson)` — gate through #608.
 *   2. Each accepted candidate is fingerprinted on the normalized
 *      `{domain, title}` pair (NFKC + lowercase + trim + collapse
 *      whitespace), hashed with SHA-256.
 *   3. Identical fingerprints merge into one group. `proposedByList`
 *      accumulates the input's `proposedBy` value; `proposalCount`
 *      counts total contributions; `variantCount` counts concrete
 *      candidates within the group that differ in any non-fingerprint
 *      field.
 *   4. Representative selection: longest body wins; on tie, first-seen
 *      wins (deterministic given a stable input order).
 *
 * Rejections carry the `proposedBy` value forward so the human
 * reviewer can attribute each failure to a specific subagent.
 *
 * Group order in the output: stable by first-seen fingerprint, so the
 * approval loop iterates in a predictable order.
 */
export function coalesceCandidates(inputs: readonly CoalesceInput[]): CoalesceResult {
	const groupsMap = new Map<
		string,
		{
			representative: ProjectedCandidate;
			proposers: Set<string>;
			proposalCount: number;
			/** Set of distinct non-fingerprint shape keys — order-independent. */
			distinctShapes: Set<string>;
			/** Per-proposer body SHA-256, keyed by proposedBy. */
			bodyHashesByProposer: Map<string, string>;
		}
	>();
	const rejected: CoalesceRejection[] = [];

	for (const input of inputs) {
		const { accepted, rejected: rej } = acceptCandidates(input.rawJson);
		for (const r of rej) {
			rejected.push({ ...r, proposedBy: input.proposedBy });
		}
		for (const c of accepted) {
			const fp = fingerprintCandidate(c);
			const variantKey = nonFingerprintKey(c);
			const bodyHash = createHash("sha256").update(c.body, "utf8").digest("hex");
			const existing = groupsMap.get(fp);
			if (!existing) {
				groupsMap.set(fp, {
					representative: c,
					proposers: new Set([input.proposedBy]),
					proposalCount: 1,
					distinctShapes: new Set([variantKey]),
					bodyHashesByProposer: new Map([[input.proposedBy, bodyHash]]),
				});
				continue;
			}
			existing.proposalCount += 1;
			existing.proposers.add(input.proposedBy);
			existing.distinctShapes.add(variantKey);
			// Last-writer-wins for per-proposer body hash — documented on
			// `bodyHashesByProposer` in `CoalescedGroup`.
			existing.bodyHashesByProposer.set(input.proposedBy, bodyHash);
			// Tie-break on longest body; strict `>` preserves first-seen
			// on equal length (deterministic).
			if (c.body.length > existing.representative.body.length) {
				existing.representative = c;
			}
		}
	}

	const groups: CoalescedGroup[] = [];
	for (const [fingerprint, g] of groupsMap) {
		const variantCount = g.distinctShapes.size;
		const base = {
			fingerprint,
			candidate: g.representative,
			proposedByList: Array.from(g.proposers).sort(),
			proposalCount: g.proposalCount,
			variantCount,
		};
		if (variantCount > 1) {
			const hashes: Record<string, string> = Object.create(null) as Record<string, string>;
			for (const [proposer, hash] of g.bodyHashesByProposer) hashes[proposer] = hash;
			groups.push({ ...base, bodyHashesByProposer: Object.freeze(hashes) });
		} else {
			groups.push(base);
		}
	}

	return { groups, rejected };
}

/**
 * Fingerprint: SHA-256 of the canonical JSON of the normalized
 * `{domain, title}` pair. Small deterministic serializer inlined here
 * to avoid pulling in the full `computeCanonicalBlob` (which needs
 * repo state — inappropriate at the coalesce boundary).
 */
function fingerprintCandidate(c: ProjectedCandidate): string {
	const normDomain = normFingerprintField(c.domain);
	const normTitle = normFingerprintField(c.title);
	// Manual serializer: two fixed keys, sorted lexicographically
	// (`domain` < `title`), values JSON-string-encoded. Locked byte
	// shape verified by test.
	const canonical = `{"domain":${JSON.stringify(normDomain)},"title":${JSON.stringify(normTitle)}}`;
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normFingerprintField(s: string): string {
	return normalizeText(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Serialize the concrete candidate excluding the fingerprint fields
 * so we can detect "same {domain,title} but different body/tags/etc."
 * as `variantCount > 1`. Not persisted anywhere — just an in-memory
 * comparison key.
 */
function nonFingerprintKey(c: ProjectedCandidate): string {
	const keys: Array<keyof ProjectedCandidate> = [
		"body",
		"entryType",
		"severity",
		"justification",
		"tags",
		"source",
		"sourceVersion",
		"dedupeQuery",
		"canonical_blob_sha",
	];
	const parts: string[] = [];
	for (const k of keys) {
		const v = c[k];
		parts.push(`${k}:${JSON.stringify(v ?? null)}`);
	}
	return parts.join("|");
}

// -----------------------------------------------------------------------------
// Test-only exports (do not consume outside test/)
// -----------------------------------------------------------------------------

export const __testing = {
	fingerprintCandidate,
	normFingerprintField,
	capBody,
	buildBlockString,
	FORM_A_PATH_RE,
};
