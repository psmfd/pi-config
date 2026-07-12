/**
 * expertise-fanout-gate — local-only JSONL telemetry (#605, ADR-0095).
 *
 * One line per gate decision (inject / skip / error), appended to a per-day
 * file under the extension's ADR-0019 data subtree:
 *
 *   ~/.pi/agent/extensions/expertise-fanout-gate/telemetry/<YYYY-MM-DD>.jsonl
 *
 * This log is the FIRST-PARTY audit artifact the #601 CI audit consumes —
 * unlike a transcript scan, it is written by extension code, not model
 * output. It is local-only (never synced, never shipped) and secret-safe:
 * free-text fields are scanned with the shared secret-pattern set and
 * redacted to category names on a match; refusal reasons are length-bounded.
 *
 * Best-effort by contract: every write failure is swallowed. Telemetry must
 * never fail a fanout (the tool_call hook it serves is fail-open).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { scanRawString } from "../../shared/secret-scan.ts";
import { stateDir } from "../../shared/state.ts";

export const TELEMETRY_NAMESPACE = "expertise-fanout-gate";

/** Bounded free-text field length (refusal reasons etc.). */
export const MAX_FIELD_CHARS = 300;

export interface TelemetryRecord {
	/** Decision kind — pre-fetch (`inject`/`skip`/`error`), approval loop
	 * (`approve`/`reject`/`queue`), or create gate (`create-allow`/
	 * `create-block`). */
	readonly event:
		| "inject"
		| "skip"
		| "error"
		| "approve"
		| "reject"
		| "queue"
		| "create-allow"
		| "create-block";
	/** Stable machine-readable cause for `skip`/`error`/`queue`/block rows. */
	readonly reason?: string;
	/** Coalesce-group fingerprint for approval-loop rows. */
	readonly fingerprint?: string;
	/** The candidate's own canonical anchor (approval-loop rows) — the #601
	 * audit cross-checks it against an earlier inject row's sha. */
	readonly candidateBlobSha?: string;
	/** Approval hash (full-field, ADR-0095) for approve/create rows. */
	readonly approvalHash?: string;
	/** Canonical query actually sent (redacted on secret match). */
	readonly query?: string;
	/** Anchor sha of the injected block. */
	readonly canonicalBlobSha?: string;
	/** Result count injected. */
	readonly resultCount?: number;
	/** Requested agent names (sorted, de-duplicated). */
	readonly agents?: readonly string[];
	/** Parallel-task count of the fanout. */
	readonly taskCount?: number;
	/** Bounded human-readable detail (redacted on secret match). */
	readonly detail?: string;
}

/** Redact + bound a free-text field for the log line. */
export function sanitizeField(value: string): string {
	const bounded = value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
	const categories = scanRawString(bounded);
	if (categories.length > 0) return `[redacted:${categories.join(",")}]`;
	return bounded;
}

export function telemetryDir(agentDir?: string): string {
	return join(stateDir(TELEMETRY_NAMESPACE, agentDir), "telemetry");
}

/**
 * Append one record as a JSON line. `now` is injectable for tests (drives
 * both the `ts` field and the per-day filename).
 */
export function appendTelemetry(
	record: TelemetryRecord,
	opts: { agentDir?: string; now?: Date } = {},
): void {
	try {
		const now = opts.now ?? new Date();
		const dir = telemetryDir(opts.agentDir);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const day = now.toISOString().slice(0, 10);
		const line: Record<string, unknown> = {
			ts: now.toISOString(),
			event: record.event,
		};
		if (record.reason !== undefined) line.reason = record.reason;
		if (record.fingerprint !== undefined) line.fingerprint = record.fingerprint;
		if (record.candidateBlobSha !== undefined) line.candidateBlobSha = record.candidateBlobSha;
		if (record.approvalHash !== undefined) line.approvalHash = record.approvalHash;
		if (record.query !== undefined) line.query = sanitizeField(record.query);
		if (record.canonicalBlobSha !== undefined) line.canonicalBlobSha = record.canonicalBlobSha;
		if (record.resultCount !== undefined) line.resultCount = record.resultCount;
		if (record.agents !== undefined) line.agents = [...record.agents];
		if (record.taskCount !== undefined) line.taskCount = record.taskCount;
		if (record.detail !== undefined) line.detail = sanitizeField(record.detail);
		appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
	} catch {
		/* best-effort by contract */
	}
}
