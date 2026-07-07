/**
 * expertise-indexer/candidate-gate.ts — orchestrator-side collector gate
 * that ingests the `EXPERTISE_CANDIDATES` transport payload emitted by
 * subagents and produces a strictly-projected, secret-scanned batch that
 * the orchestrator can safely surface to a human for approval
 * (pi_config issue #608, transport contract #600, epic #595).
 *
 * WHY THIS EXISTS
 * ---------------
 * Subagent output is UNTRUSTED. Without a gate, four failure modes fire:
 *   1. Terminal-scrollback secret leak — a secret embedded in a
 *      candidate body reaches the operator's terminal via the approval
 *      prompt BEFORE `expertise_create`'s scan fires.
 *   2. Prototype pollution — crafted `__proto__` / `constructor` /
 *      `prototype` keys in the parsed JSON tree.
 *   3. Approval-state bypass — a subagent embeds `approved: true` and
 *      hopes the orchestrator forwards it verbatim.
 *   4. Field-shape scan gap — the `expertise-client` scan iterates
 *      OWN properties of a `CreateParams` object, so unmapped keys
 *      arriving from a raw candidate JSON are not scanned.
 *
 * This module closes all four. It is a pure library — no I/O, no tool
 * registration — so #599 (orchestrator collector), #601 (CI audit),
 * and #604 (pre-push hook) can share the exact same gate semantics.
 *
 * FAIL-CLOSED SEMANTICS
 * ---------------------
 * Every check rejects with a structured `RejectionReason` code. The
 * `hint` field carries an offending key name or structural context but
 * NEVER carries a matched secret substring. Rejection reasons are
 * stable identifiers callable from CI assertions.
 */

import { isValidGitSha } from "./canonicalize.ts";
import { scanRawString } from "../expertise-client/lib/secret-scan.ts";

// ---------------------------------------------------------------------------
// Field allowlist (schema v1, from issue #600).
// ---------------------------------------------------------------------------

export const ENTRY_TYPES = ["IssueFix", "Caveat", "Requirement", "Pattern"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const SEVERITIES = ["Info", "Warning", "Critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * The projected shape produced by the gate. Anything outside this shape
 * is dropped (unknown-field) or rejected (approval-state / prototype).
 */
export interface ProjectedCandidate {
	readonly domain: string;
	readonly title: string;
	readonly body: string;
	readonly entryType: EntryType;
	readonly severity: Severity;
	readonly justification?: string;
	readonly tags?: readonly string[];
	readonly source?: string;
	readonly sourceVersion?: string;
	readonly proposedBy: string;
	readonly dedupeQuery: string;
	readonly canonical_blob_sha: string;
}

/**
 * Ordered field list of the projection. `Set` derived from this drives
 * the "unknown-field" check — deliberately not inferred from the
 * `ProjectedCandidate` interface so adding a field is a two-line change
 * (interface + this list) that fails a test if only one side moves.
 */
const REQUIRED_STRING_FIELDS = [
	"domain",
	"title",
	"body",
	"proposedBy",
	"dedupeQuery",
	"canonical_blob_sha",
] as const;

const OPTIONAL_STRING_FIELDS = ["source", "sourceVersion"] as const;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
	...REQUIRED_STRING_FIELDS,
	...OPTIONAL_STRING_FIELDS,
	"justification",
	"entryType",
	"severity",
	"tags",
]);

// Approval-state fields — explicit reject rather than silent strip, so a
// subagent that tries this gets a stable failure signal in the rejection
// log (auditable), instead of silently ~mostly-working.
const APPROVAL_STATE_FIELDS: ReadonlySet<string> = new Set<string>([
	"approved",
	"approvedBy",
	"approvalTimestamp",
	"approvalToken",
]);

// Prototype-poisoning keys. Node 18+ `JSON.parse` creates these as OWN
// enumerable properties (not on the prototype), so a downstream
// `Object.assign` or `for...in` still hits them. Reject at any depth.
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set<string>([
	"__proto__",
	"constructor",
	"prototype",
]);

// Maximum recursion depth for the prototype-poisoning walker. Realistic
// candidates are near-flat (~1–2 levels: root, tags array). V8 JSON.parse
// tolerates ~85k-deep input within the #600 512 KB Form B cap, which
// would blow the call stack via naive recursion. 256 is orders of
// magnitude beyond any legitimate shape and comfortably below Node's
// default call-stack ceiling (≥10k). Exceeding the cap is a structural
// rejection with the `prototype-poisoning` signal (fail-closed).
const MAX_POISON_WALK_DEPTH = 256;

// ---------------------------------------------------------------------------
// Rejection contract
// ---------------------------------------------------------------------------

export type RejectionReason =
	| "invalid-json"
	| "payload-not-object"
	| "invalid-schema-version"
	| "candidates-not-array"
	| "unknown-top-level-key"
	| "candidate-not-object"
	| "prototype-poisoning"
	| "approval-state-field"
	| "unknown-field"
	| "missing-required-field"
	| "wrong-type"
	| "invalid-enum-value"
	| "info-severity-requires-justification"
	| "secret-detected";

export interface RejectedCandidate {
	/** Zero-based index into the input `candidates` array. `-1` for payload-level rejections. */
	readonly index: number;
	readonly reason: RejectionReason;
	/**
	 * Structured, stable-across-runs context (offending key name, field
	 * name, matched secret CATEGORIES, etc.). NEVER carries a matched
	 * secret substring. Safe to log and to include in CI assertions.
	 */
	readonly hint?: string;
}

export interface CandidateGateResult {
	readonly accepted: readonly ProjectedCandidate[];
	readonly rejected: readonly RejectedCandidate[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Ingest a raw `EXPERTISE_CANDIDATES` JSON payload (Form B inline or the
 * contents of a Form A file). Returns `{ accepted, rejected }` — never
 * throws for user-input errors; only structural bugs escape.
 */
export function acceptCandidates(rawJson: string): CandidateGateResult {
	// Step 1 — safe JSON.parse (Node 18+ does not honor `__proto__` at parse time).
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		// Intentionally NO hint. V8's SyntaxError.message in Node 20+ quotes
		// a slice of the offending input ("Unexpected token 'A', \"AKIA...\"
		// is not valid JSON"), which would echo an attacker-controlled
		// credential into the rejection surface (operator terminal / logs /
		// PR comment). Position/type of the parse error is rarely
		// operator-actionable anyway; the fail-closed signal is sufficient.
		return { accepted: [], rejected: [{ index: -1, reason: "invalid-json" }] };
	}

	// Step 2 — payload must be a plain object with exactly {schemaVersion, candidates}.
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { accepted: [], rejected: [{ index: -1, reason: "payload-not-object" }] };
	}

	const payload = parsed as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(payload)) {
		if (key !== "schemaVersion" && key !== "candidates") {
			return {
				accepted: [],
				rejected: [
					{ index: -1, reason: "unknown-top-level-key", hint: safeHint("key", key) },
				],
			};
		}
	}
	if (payload.schemaVersion !== 1) {
		return {
			accepted: [],
			rejected: [
				{
					index: -1,
					reason: "invalid-schema-version",
					hint: `${safeHint("got", JSON.stringify(payload.schemaVersion) ?? "undefined")} expected=1`,
				},
			],
		};
	}
	if (!Array.isArray(payload.candidates)) {
		return { accepted: [], rejected: [{ index: -1, reason: "candidates-not-array" }] };
	}

	// Step 3 — per-candidate projection + validation.
	const accepted: ProjectedCandidate[] = [];
	const rejected: RejectedCandidate[] = [];
	for (let i = 0; i < payload.candidates.length; i++) {
		const outcome = projectCandidate(payload.candidates[i], i);
		if (outcome.ok) {
			accepted.push(outcome.value);
		} else {
			rejected.push(outcome.reject);
		}
	}
	return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Per-candidate pipeline
// ---------------------------------------------------------------------------

type ProjectOutcome =
	| { ok: true; value: ProjectedCandidate }
	| { ok: false; reject: RejectedCandidate };

function projectCandidate(raw: unknown, index: number): ProjectOutcome {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return rej(index, "candidate-not-object");
	}

	// Secret scan runs FIRST on the entire raw candidate. This is the
	// universal fail-closed gate that prevents ANY hint site downstream
	// from echoing a secret — whether the secret sits in a value, in a key
	// NAME, in a soon-to-be-dropped unknown field, or in a nested position
	// that a later rejection would surface. `scanRawString` returns
	// category names only, never the matched text. Reordering ANY check
	// above this line reopens a rejection-surface leak class — do not.
	const rawSerialized = safeStringify(raw);
	if (rawSerialized !== null) {
		const cats = scanRawString(rawSerialized);
		if (cats.length > 0) {
			return rej(index, "secret-detected", `categories=${cats.sort().join(",")}`);
		}
	}

	// Prototype-poisoning check — walks the entire subtree of the parsed
	// candidate object. Deliberately does NOT recurse INTO strings (a body
	// legitimately mentioning `__proto__` is fine); a raw JSON string
	// smuggled in the body is opaque data to us. Matches the intent of the
	// #608 test matrix "nested body-string-parseable-as-JSON" case.
	//
	// Depth-bounded (MAX_POISON_WALK_DEPTH) so deeply-nested adversarial
	// JSON within the #600 512 KB Form B cap cannot stack-overflow.
	//
	// The hint carries only the terminal PROTOTYPE_KEYS member, NOT the
	// path to reach it — the path segments concatenate attacker-controlled
	// intermediate key names, which even after the secret scan above we
	// treat as untrusted-and-not-worth-echoing (defense in depth: if the
	// scan ever misses a novel credential shape, the poisoning hint still
	// carries no attacker-controlled text).
	const poisonHit = findPrototypeKey(raw, 0);
	if (poisonHit) {
		return rej(index, "prototype-poisoning", `key=${poisonHit}`);
	}

	const obj = raw as Record<string, unknown>;

	// Approval-state reject BEFORE unknown-field reject: a subagent that
	// sets both should get the more specific signal.
	for (const key of Object.getOwnPropertyNames(obj)) {
		if (APPROVAL_STATE_FIELDS.has(key)) {
			return rej(index, "approval-state-field", `field='${key}'`);
		}
	}
	for (const key of Object.getOwnPropertyNames(obj)) {
		if (!ALLOWED_FIELDS.has(key)) {
			return rej(index, "unknown-field", `field='${key}'`);
		}
	}

	// Required string fields — presence + type.
	for (const f of REQUIRED_STRING_FIELDS) {
		if (!(f in obj)) return rej(index, "missing-required-field", `field='${f}'`);
		if (typeof obj[f] !== "string") return rej(index, "wrong-type", `field='${f}' expected=string`);
	}
	// Optional string fields — type only if present.
	for (const f of OPTIONAL_STRING_FIELDS) {
		if (f in obj && typeof obj[f] !== "string") {
			return rej(index, "wrong-type", `field='${f}' expected=string`);
		}
	}

	// Enums.
	if (!("entryType" in obj)) return rej(index, "missing-required-field", "field='entryType'");
	if (typeof obj.entryType !== "string" || !(ENTRY_TYPES as readonly string[]).includes(obj.entryType)) {
		return rej(index, "invalid-enum-value", `field='entryType' allowed=${ENTRY_TYPES.join("|")}`);
	}
	if (!("severity" in obj)) return rej(index, "missing-required-field", "field='severity'");
	if (typeof obj.severity !== "string" || !(SEVERITIES as readonly string[]).includes(obj.severity)) {
		return rej(index, "invalid-enum-value", `field='severity' allowed=${SEVERITIES.join("|")}`);
	}

	// Info severity ⇒ justification required and non-empty. Owned here
	// end-to-end (not in OPTIONAL_STRING_FIELDS) so that
	// {severity: "Info", justification: null} yields the specific
	// info-severity-requires-justification signal, not a generic wrong-type.
	if (obj.severity === "Info") {
		if (!("justification" in obj)) {
			return rej(index, "info-severity-requires-justification");
		}
		if (typeof obj.justification !== "string" || obj.justification.trim().length === 0) {
			return rej(index, "info-severity-requires-justification");
		}
	} else if ("justification" in obj && typeof obj.justification !== "string") {
		// Non-Info severity with a present-but-wrong-type justification.
		return rej(index, "wrong-type", "field='justification' expected=string");
	}

	// canonical_blob_sha shape — delegates to isValidGitSha (canonicalize.ts)
	// so any future tightening (prefix, length, encoding) tracks the anchor
	// authoritatively rather than drifting in a duplicated local regex.
	if (!isValidGitSha(obj.canonical_blob_sha as string)) {
		return rej(index, "wrong-type", "field='canonical_blob_sha' expected=hex(40|64)");
	}

	// tags validation moved here — must run AFTER the Info-severity block so
	// {severity:"Info", tags:"bad"} still reports the more specific Info
	// signal first. Optional string[]; reject non-string elements.
	if ("tags" in obj) {
		const t = obj.tags;
		if (!Array.isArray(t)) return rej(index, "wrong-type", "field='tags' expected=string[]");
		for (let j = 0; j < t.length; j++) {
			if (typeof t[j] !== "string") {
				return rej(index, "wrong-type", `field='tags[${j}]' expected=string`);
			}
		}
	}

	// Build the projected value. Use `Object.create(null)` NOT to defeat any
	// remaining pollution (we already rejected prototype keys above), but
	// to give the orchestrator an object that will not surprise a `hasOwn`
	// or `for...in` consumer downstream with inherited Object.prototype
	// methods showing up under `Reflect.ownKeys`.
	const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const f of REQUIRED_STRING_FIELDS) projected[f] = obj[f];
	projected.entryType = obj.entryType;
	projected.severity = obj.severity;
	if ("justification" in obj) projected.justification = obj.justification;
	if ("source" in obj) projected.source = obj.source;
	if ("sourceVersion" in obj) projected.sourceVersion = obj.sourceVersion;
	if ("tags" in obj) projected.tags = Object.freeze([...(obj.tags as readonly string[])]);
	Object.freeze(projected);

	return { ok: true, value: projected as unknown as ProjectedCandidate };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rej(index: number, reason: RejectionReason, hint?: string): ProjectOutcome {
	return { ok: false, reject: hint === undefined ? { index, reason } : { index, reason, hint } };
}

/**
 * Union of the fixed labels ever passed to `safeHint`. Narrowing the
 * label parameter to a closed set prevents a future caller from
 * accidentally forwarding attacker-controlled input as the label side
 * of the hint (which would bypass the value-side redaction).
 */
type SafeHintLabel = "key" | "got";

/**
 * Build a hint fragment `label=<value>` while defending the rejection
 * surface against secret leaks. If the raw value matches any
 * SECRET_PATTERN, the value is replaced with a category-name marker
 * (never the matched substring). Otherwise the value is truncated to a
 * safe cap. Used for hints where the input is user-controlled and lives
 * OUTSIDE the per-candidate raw-serialization scan (payload-level keys,
 * schema-version values, etc.).
 */
function safeHint(label: SafeHintLabel, rawValue: string): string {
	const cats = scanRawString(rawValue);
	if (cats.length > 0) {
		return `${label}=<redacted:categories=${cats.sort().join(",")}>`;
	}
	return `${label}='${truncateForHint(rawValue)}'`;
}

function truncateForHint(s: string): string {
	const MAX = 120;
	return s.length <= MAX ? s : `${s.slice(0, MAX)}…`;
}

/**
 * Recursively search `node` for any own property named `__proto__`,
 * `constructor`, or `prototype`. Descends into arrays and plain objects
 * only — never into strings, numbers, or booleans. Returns the terminal
 * offending key name on hit, or null.
 *
 * The returned value is JUST the terminal key (`__proto__` /
 * `constructor` / `prototype`) or the synthetic marker
 * `<depth-exceeded>` — never a path composed of attacker-controlled
 * intermediate key names. This keeps the rejection surface secret-safe
 * even if the pre-walk raw-serialization scan ever misses a novel
 * credential shape (defense in depth).
 *
 * Depth-bounded (MAX_POISON_WALK_DEPTH) — an adversarial ~85k-deep
 * `{"a":{"a":…}}` fitting in the #600 512 KB Form B cap would otherwise
 * stack-overflow.
 */
function findPrototypeKey(node: unknown, depth: number): string | null {
	if (node === null || typeof node !== "object") return null;
	if (depth >= MAX_POISON_WALK_DEPTH) return "<depth-exceeded>";
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			const r = findPrototypeKey(node[i], depth + 1);
			if (r) return r;
		}
		return null;
	}
	for (const key of Object.getOwnPropertyNames(node)) {
		if (PROTOTYPE_KEYS.has(key)) return key;
		// Read via descriptor so `__proto__` as own property returns its
		// stored value, not the prototype chain. Accessor descriptors
		// (get/set) cannot be produced by JSON.parse and are skipped by
		// the `value in desc` guard — acceptable for the JSON-only input
		// contract; if this walker is ever reused for non-JSON callers,
		// treat accessor descriptors as inherently hostile.
		const desc = Object.getOwnPropertyDescriptor(node, key);
		if (desc && "value" in desc) {
			const r = findPrototypeKey(desc.value, depth + 1);
			if (r) return r;
		}
	}
	return null;
}

/**
 * Stringify for scanning. Returns null on structural failure (circular
 * refs cannot occur in JSON.parse output, but guard for safety). Uses
 * a stable enough serialization for pattern matching — key ordering
 * does not matter to any SECRET_PATTERN regex.
 */
function safeStringify(v: unknown): string | null {
	try {
		return JSON.stringify(v);
	} catch {
		return null;
	}
}

// Internals exposed only for testing.
export const __testing = {
	ALLOWED_FIELDS,
	APPROVAL_STATE_FIELDS,
	PROTOTYPE_KEYS,
	MAX_POISON_WALK_DEPTH,
	findPrototypeKey,
	safeHint,
};
