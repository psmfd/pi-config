/**
 * prefill-meter/state.ts — append-only JSONL ledger + reader (ADR-0125).
 *
 * Records land at ~/.pi/agent/extensions/prefill-meter/spawns.jsonl (the
 * per-extension subtree, reached in a dev checkout via the setup.sh
 * `~/.pi → repo` symlink and gitignored). `agentDir` is injectable so the I/O
 * unit-tests against a temp dir.
 *
 * Fixed basename, append-only: a probe run spawns parallel subagent processes
 * that all append to the one file. A single `fs.appendFile` is one `write()`
 * on an O_APPEND fd — interleaving-safe across processes (same rationale as
 * token-meter, ADR-0073). Aggregation happens on read (jq), never in-place.
 * No rotation: the meter is inert by default and armed only for probe runs.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type PrefillRecord, toJsonl } from "./record.ts";

const NAMESPACE = "prefill-meter";
const LOG_BASENAME = "spawns.jsonl";

/** Resolve the ledger path. */
export function logPath(agentDir?: string): string {
	const base = agentDir ?? join(homedir(), ".pi", "agent");
	return join(base, "extensions", NAMESPACE, LOG_BASENAME);
}

/** Append one record as a JSONL line, creating the directory as needed. */
export async function appendRecord(record: PrefillRecord, agentDir?: string): Promise<void> {
	const file = logPath(agentDir);
	await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
	await fs.appendFile(file, toJsonl(record), "utf8");
}

/**
 * Read + parse the ledger. Skips any malformed/partial line (a mid-line append
 * interrupted by a process kill) rather than throwing, and returns [] when no
 * ledger exists yet.
 */
export async function readRecords(agentDir?: string): Promise<Partial<PrefillRecord>[]> {
	let raw: string;
	try {
		raw = await fs.readFile(logPath(agentDir), "utf8");
	} catch {
		return [];
	}
	const out: Partial<PrefillRecord>[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (t === "") continue;
		try {
			const rec = JSON.parse(t) as Partial<PrefillRecord>;
			if (rec && typeof rec === "object") out.push(rec);
		} catch {
			// Skip a corrupt/partial trailing line; never throw on read.
		}
	}
	return out;
}
