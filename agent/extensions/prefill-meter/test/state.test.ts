/**
 * prefill-meter ledger I/O — hermetic against a temp agentDir.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { UsageRecord } from "../record.ts";
import { appendRecord, logPath, readRecords } from "../state.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prefill-meter-test-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function usageRec(pid: number): UsageRecord {
	return {
		ts: "2026-07-26T00:00:00.000Z",
		kind: "first_usage",
		label: "t",
		pid,
		depth: 0,
		model: "m",
		provider: "p",
		input: 1,
		cacheRead: 2,
		cacheWrite: 3,
		output: 4,
	};
}

test("appendRecord creates the tree and appends one line per record", async () => {
	await appendRecord(usageRec(1), dir);
	await appendRecord(usageRec(2), dir);
	const raw = await fs.readFile(logPath(dir), "utf8");
	const lines = raw.split("\n").filter((l) => l !== "");
	assert.equal(lines.length, 2);
	assert.equal((JSON.parse(lines[1]) as UsageRecord).pid, 2);
});

test("readRecords returns [] with no ledger and skips corrupt lines", async () => {
	assert.deepEqual(await readRecords(dir), []);
	await appendRecord(usageRec(7), dir);
	// Simulate a mid-append kill: partial trailing line.
	await fs.appendFile(logPath(dir), '{"kind":"spawn","pid":9', "utf8");
	const recs = await readRecords(dir);
	assert.equal(recs.length, 1);
	assert.equal(recs[0].pid, 7);
});

test("ledger directory is created 0700", async () => {
	await appendRecord(usageRec(1), dir);
	const st = await fs.stat(join(dir, "extensions", "prefill-meter"));
	// eslint-disable-next-line no-bitwise
	assert.equal(st.mode & 0o777, 0o700);
});
