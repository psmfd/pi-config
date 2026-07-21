/**
 * expertise-fanout-gate — in-session approval ledger + pending queue
 * (#605, ADR-0095).
 *
 * The ledger is the ONLY writer-side input the `expertise_create` gate
 * trusts: an entry exists iff a real `ctx.ui.confirm` resolution recorded
 * it. It is deliberately in-memory and session-scoped — persistence would
 * turn an approval into a durable capability a later session (or a file
 * write) could replay; single-use consumption prevents replay within the
 * session.
 *
 * The pending queue is the headless-session fallback (fail-closed
 * posture): candidates surfaced when `!ctx.hasUI` — or whose divergent
 * variants cannot be inspected in-dialog — are appended to a local JSONL
 * file for a later interactive review. Queue entries are informational;
 * they never feed the ledger.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { CoalescedGroup } from "../../expertise-indexer/collector.ts";
import { scanRawString } from "../../shared/secret-scan.ts";
import { stateDir } from "../../shared/state.ts";
import { sanitizeField, TELEMETRY_NAMESPACE } from "./telemetry.ts";

export interface ApprovalLedger {
	/** Record a human approval for the given approval hash. */
	record(hash: string): void;
	/** Consume (single-use) an approval; true iff it existed. */
	consume(hash: string): boolean;
	/** Number of unconsumed approvals (tests/telemetry). */
	size(): number;
}

export function makeLedger(): ApprovalLedger {
	// A Set keys approvals by full-field hash, so approval is single-use PER
	// CONTENT: two separate approvals of candidates that serialize to the same
	// ApprovalFields grant exactly one create, not two. This is intentional —
	// identical expertise content only ever needs to be written once, and
	// collapsing duplicates keeps the gate's "exactly the approved field set"
	// contract simple. Switch to a Map<hash,count> only if N distinct approvals
	// of identical content must permit N creates (not a current requirement).
	const hashes = new Set<string>();
	return {
		record(hash) {
			hashes.add(hash);
		},
		consume(hash) {
			return hashes.delete(hash);
		},
		size() {
			return hashes.size;
		},
	};
}

export function pendingDir(agentDir?: string): string {
	return join(stateDir(TELEMETRY_NAMESPACE, agentDir), "pending");
}

/**
 * Append surfaced-but-unapproved groups to the pending JSONL file.
 * Best-effort (a queue write failure must not fail the fanout return);
 * returns true when the write landed.
 */
export type PendingReason = "headless" | "divergent-variants" | "secret-detected";

export function queuePending(
	groups: readonly CoalescedGroup[],
	reason: PendingReason,
	opts: { agentDir?: string; now?: Date } = {},
): boolean {
	try {
		const now = opts.now ?? new Date();
		const dir = pendingDir(opts.agentDir);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const day = now.toISOString().slice(0, 10);
		const lines = groups
			.map((g) =>
				JSON.stringify({
					ts: now.toISOString(),
					reason,
					fingerprint: g.fingerprint,
					// Redact any candidate carrying secret-shaped content, regardless
					// of WHY it was queued. The "headless" and "divergent-variants"
					// paths reach this writer WITHOUT the interactive display scan, so a
					// reason-scoped check wrote real credentials raw to the pending JSONL
					// (#815). Scan every queued candidate: a clean one is written in full
					// (the later reviewer needs the whole body), a secret-bearing one is
					// field-wise redacted. Fingerprint + body hashes still identify it.
					candidate: candidateHasSecret(g.candidate)
						? redactCandidate(g.candidate)
						: g.candidate,
					proposedByList: g.proposedByList,
					proposalCount: g.proposalCount,
					variantCount: g.variantCount,
					...(g.bodyHashesByProposer ? { bodyHashesByProposer: g.bodyHashesByProposer } : {}),
				}),
			)
			.join("\n");
		appendFileSync(join(dir, `${day}.jsonl`), `${lines}\n`, { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

/** True when any string field (or string array element) of a candidate carries
 * secret-shaped content. Gates redaction on actual secret presence rather than
 * on the queue `reason`, so the headless and divergent-variant paths — which
 * never pass the interactive display scan — are protected too (#815). */
function candidateHasSecret(candidate: CoalescedGroup["candidate"]): boolean {
	for (const value of Object.values(candidate)) {
		if (typeof value === "string") {
			if (scanRawString(value).length > 0) return true;
		} else if (Array.isArray(value)) {
			for (const v of value) {
				if (typeof v === "string" && scanRawString(v).length > 0) return true;
			}
		}
	}
	return false;
}

/** Field-wise redaction of a candidate's free-text values (used whenever
 * candidateHasSecret flags a candidate — every string runs through the shared
 * pattern scan). */
function redactCandidate(candidate: CoalescedGroup["candidate"]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(candidate)) {
		if (typeof value === "string") out[key] = sanitizeField(value);
		else if (Array.isArray(value))
			out[key] = (value as unknown[]).map((v): unknown =>
				typeof v === "string" ? sanitizeField(v) : v,
			);
		// Every ProjectedCandidate field is a string / string[] today, so this
		// branch is unreachable under the current schema — kept as defensive
		// pass-through in case a non-string field is added later (#815).
		else out[key] = value;
	}
	return out;
}
