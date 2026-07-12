/**
 * LOCAL PATCH #6 sibling module (pi_config #611, epic #595).
 *
 * Wires the pure-library collector primitives from
 * `../expertise-indexer/collector.ts` into the vendored subagent
 * extension's runtime dispatch path. Kept as a separate file (same
 * pattern as `sanitize-env.ts` and `model-pin.ts`) so the vendored
 * `index.ts` diff stays minimal for the drift-audit surface tracked
 * by `scripts/validate-subagent-drift.sh`.
 *
 * Scope ("Option A" per plan on #611): this module implements
 * INJECTION + COLLECTION + COALESCE only. The `expertise_search`
 * calls (canonical pre-fetch + per-candidate dedupe) remain
 * orchestrator-driven; the model calls the tool it already has and
 * passes the pre-built canonical block via the new
 * `expertiseInjection` task-schema field. Full autonomous wiring
 * (search inside the extension, 429 backoff, deadline) is deferred
 * to #613 to keep this PR's boundary escalation minimal.
 *
 * Trust boundary (ADR-0028, agent/rules/no-mcp-servers.md):
 *   - Injection is prepended to the child's user-role `Task:` framing,
 *     NEVER to `--append-system-prompt`.
 *   - Extracted candidate payloads are UNTRUSTED child output; every
 *     one flows through `coalesceCandidates` which internally calls
 *     the #608 candidate-gate `acceptCandidates` (universal-first
 *     secret scan, closed-set rejection reasons).
 *   - `proposedBy` on `CoalesceInput` is sourced from the ORCHESTRATOR-
 *     supplied `SingleResult.agent` (not any candidate-payload field)
 *     so attribution cannot be forged by a subagent.
 *   - Form A (REPORT_FILE) payloads are read through the hardened
 *     `expertise-indexer/form-a-reader.ts` (#600, ADR-0095): O_NOFOLLOW
 *     open, fstat on the opened fd (regular file, ≤512 KB, own uid,
 *     mode 0600), canonical parent == canonical /tmp. Any violation
 *     drops the payload with a one-line stderr warning naming the
 *     structured reason (fail-open at extraction, fail-closed at
 *     ingestion — the closed #599 security-review TOCTOU deferral).
 */

import {
	coalesceCandidates,
	type CoalesceInput,
	type CoalesceResult,
	extractCandidatePayloads,
} from "../expertise-indexer/collector.ts";
import { readCandidatesFile } from "../expertise-indexer/form-a-reader.ts";

/**
 * Build the child's task string with optional expertise-block prefix.
 *
 * When `injection` is a non-empty string, the returned string is:
 *   `${injection}\n\nTask: ${task}`
 * When absent/empty, the returned string is the pass-through
 * `Task: ${task}`.
 *
 * Split out as a pure function so the wiring is unit-testable
 * without spawning a real `pi` child.
 */
export function buildInjectedTaskArg(task: string, injection: string | undefined): string {
	if (typeof injection === "string" && injection.length > 0) {
		return `${injection}\n\nTask: ${task}`;
	}
	return `Task: ${task}`;
}

/**
 * Extract `EXPERTISE_CANDIDATES` payloads from a child's final
 * assistant output. Returns the raw JSON strings ready to feed to
 * `coalesceCandidates`. Form B payloads are inline; Form A
 * (`REPORT_FILE:`) payloads are read through the hardened reader —
 * a validation failure drops that payload with a one-line stderr
 * warning naming the structured reason.
 *
 * Fail-open: any error during extraction yields an empty array, so a
 * garbage-emitting subagent never blocks the fanout return.
 */
export function extractFormBRawPayloads(childOutput: string): string[] {
	let payloads: ReturnType<typeof extractCandidatePayloads>;
	try {
		payloads = extractCandidatePayloads(childOutput);
	} catch {
		return [];
	}
	const rawJson: string[] = [];
	for (const p of payloads) {
		if (p.form === "B") {
			rawJson.push(p.rawJson);
		} else {
			const read = readCandidatesFile(p.reportFile);
			if (read.ok) {
				rawJson.push(read.rawJson);
			} else {
				process.stderr.write(
					`[subagent] Form A EXPERTISE_CANDIDATES rejected (${read.reason}${read.detail ? `: ${read.detail}` : ""}). Path: ${p.reportFile}\n`,
				);
			}
		}
	}
	return rawJson;
}

/**
 * Per-child bag of extracted Form B payloads, carried on
 * `SingleResult.extractedExpertisePayloads` so the finalizer for
 * single/parallel/chain can coalesce across all children uniformly.
 */
export interface ExtractedExpertise {
	/** Form B rawJson blobs, in source-order of the child's output. */
	readonly formBRawJson: readonly string[];
}

/**
 * Called once per child on `runSingleAgent` completion. Returns
 * `undefined` when the child produced no EXPERTISE_CANDIDATES blocks,
 * so the field is absent on `SingleResult` in the common case.
 */
export function extractExpertiseFromChildOutput(childOutput: string): ExtractedExpertise | undefined {
	const formBRawJson = extractFormBRawPayloads(childOutput);
	if (formBRawJson.length === 0) return undefined;
	return { formBRawJson };
}

/**
 * Coalesce candidates across every child in a single/parallel/chain
 * finalizer. Returns `undefined` when no child produced any
 * candidates, so `SubagentDetails.expertiseCandidates` stays absent
 * in the common case (the vast majority of fanouts do not surface
 * expertise).
 *
 * `proposedBy` is the ORCHESTRATOR-attributed subagent name — the
 * `agent` field on each `SingleResult` — never any field lifted from
 * an untrusted candidate payload. This preserves the provenance-
 * forgery defense confirmed by the security-review on #599.
 */
export function collectCoalescedExpertise(
	results: ReadonlyArray<{ agent: string; extractedExpertisePayloads?: ExtractedExpertise }>,
): CoalesceResult | undefined {
	const inputs: CoalesceInput[] = [];
	for (const r of results) {
		if (!r.extractedExpertisePayloads) continue;
		for (const rawJson of r.extractedExpertisePayloads.formBRawJson) {
			inputs.push({ rawJson, proposedBy: r.agent });
		}
	}
	if (inputs.length === 0) return undefined;
	try {
		return coalesceCandidates(inputs);
	} catch {
		// Fail-open per module docstring — collector primitives already
		// gate every candidate through acceptCandidates, so a throw here
		// would indicate an internal bug rather than an attack. Dropping
		// the envelope is safer than crashing the fanout return.
		return undefined;
	}
}
