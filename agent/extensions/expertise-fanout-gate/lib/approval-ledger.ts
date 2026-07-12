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
import { stateDir } from "../../shared/state.ts";
import { TELEMETRY_NAMESPACE } from "./telemetry.ts";

export interface ApprovalLedger {
	/** Record a human approval for the given approval hash. */
	record(hash: string): void;
	/** Consume (single-use) an approval; true iff it existed. */
	consume(hash: string): boolean;
	/** Number of unconsumed approvals (tests/telemetry). */
	size(): number;
}

export function makeLedger(): ApprovalLedger {
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
export type PendingReason = "headless" | "divergent-variants" | "secret-detected" | "declined";

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
					candidate: g.candidate,
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
