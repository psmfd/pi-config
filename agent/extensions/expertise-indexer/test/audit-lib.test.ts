/**
 * expertise-indexer — audit-lib.ts tests (#601 / ADR-0095, gap closed in #817).
 *
 * Covers the expertise-audit trust-boundary logic that previously had zero
 * coverage: arg parsing, changed-set derivation (driven by a fixture git
 * executor — no real subprocess), and the telemetry anchor cross-check that
 * catches a forged/displaced `candidateBlobSha`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	auditQuery,
	auditTelemetry,
	changedEntries,
	parseArgs,
	type GitExec,
} from "../audit-lib.ts";

const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const BLOB_A = "1".repeat(40);
const BLOB_B = "2".repeat(40);
const SHA64_A = "a".repeat(64);
const SHA64_B = "b".repeat(64);

// --- parseArgs ---------------------------------------------------------------

test("parseArgs: full valid argv", () => {
	const args = parseArgs(["--base-sha", BASE, "--head-sha", HEAD, "--out-dir", "/o"]);
	assert.deepEqual(args, { baseSha: BASE, headSha: HEAD, outDir: "/o" });
});

test("parseArgs: optional --telemetry-dir is captured", () => {
	const args = parseArgs([
		"--base-sha", BASE, "--head-sha", HEAD, "--out-dir", "/o", "--telemetry-dir", "/t",
	]);
	assert.equal(args?.telemetryDir, "/t");
});

test("parseArgs: missing a required flag → null", () => {
	assert.equal(parseArgs(["--base-sha", BASE, "--head-sha", HEAD]), null);
});

test("parseArgs: trailing key with no value → null", () => {
	assert.equal(parseArgs(["--base-sha", BASE, "--head-sha"]), null);
});

test("parseArgs: unknown flag → null", () => {
	assert.equal(
		parseArgs(["--base-sha", BASE, "--head-sha", HEAD, "--out-dir", "/o", "--bogus", "x"]),
		null,
	);
});

// --- changedEntries (fixture git) --------------------------------------------

function fixtureGit(spec: {
	diffOk?: boolean;
	paths?: string[];
	rev?: Record<string, { ok: boolean; sha: string }>;
}): GitExec {
	return (args) => {
		if (args[0] === "diff") {
			return { ok: spec.diffOk ?? true, stdout: (spec.paths ?? []).join("\n") };
		}
		if (args[0] === "rev-parse") {
			const path = String(args[1]).slice(HEAD.length + 1); // strip "<head>:"
			const r = spec.rev?.[path];
			return r ? { ok: r.ok, stdout: `${r.sha}\n` } : { ok: false, stdout: "" };
		}
		return { ok: false, stdout: "" };
	};
}

test("changedEntries: happy path returns sorted entries with blob shas", () => {
	const git = fixtureGit({
		paths: ["agent/rules/z.md", "agent/extensions/a/index.ts"],
		rev: {
			"agent/rules/z.md": { ok: true, sha: BLOB_B },
			"agent/extensions/a/index.ts": { ok: true, sha: BLOB_A },
		},
	});
	const entries = changedEntries(BASE, HEAD, git);
	assert.deepEqual(entries, [
		{ path: "agent/extensions/a/index.ts", blobSha: BLOB_A },
		{ path: "agent/rules/z.md", blobSha: BLOB_B },
	]);
});

test("changedEntries: git diff failure → null", () => {
	assert.equal(changedEntries(BASE, HEAD, fixtureGit({ diffOk: false })), null);
});

test("changedEntries: rev-parse failure for a path skips it (deleted-at-head tolerance)", () => {
	const git = fixtureGit({
		paths: ["agent/rules/kept.md", "agent/rules/gone.md"],
		rev: {
			"agent/rules/kept.md": { ok: true, sha: BLOB_A },
			"agent/rules/gone.md": { ok: false, sha: "" },
		},
	});
	assert.deepEqual(changedEntries(BASE, HEAD, git), [
		{ path: "agent/rules/kept.md", blobSha: BLOB_A },
	]);
});

test("changedEntries: a malformed blob sha is skipped", () => {
	const git = fixtureGit({
		paths: ["agent/rules/x.md"],
		rev: { "agent/rules/x.md": { ok: true, sha: "not-a-sha" } },
	});
	assert.deepEqual(changedEntries(BASE, HEAD, git), []);
});

// --- auditQuery --------------------------------------------------------------

test("auditQuery: derives area + basename tokens deterministically", () => {
	const q = auditQuery([
		{ path: "agent/extensions/foo/index.ts", blobSha: BLOB_A },
		{ path: "agent/rules/bar.md", blobSha: BLOB_B },
	]);
	assert.ok(q.length > 0);
	assert.match(q, /extensions/);
	assert.match(q, /rules/);
	// Stable across calls with identical input.
	assert.equal(
		q,
		auditQuery([
			{ path: "agent/rules/bar.md", blobSha: BLOB_B },
			{ path: "agent/extensions/foo/index.ts", blobSha: BLOB_A },
		]),
	);
});

// --- auditTelemetry ----------------------------------------------------------

function telemetryDirWith(name: string, lines: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "audit-lib-tel-"));
	writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
	return dir;
}

test("auditTelemetry: absent dir is a clean no-op", () => {
	const r = auditTelemetry(join(tmpdir(), "audit-lib-does-not-exist-xyz"));
	assert.deepEqual(r, { ok: true, lines: 0, problems: [] });
});

test("auditTelemetry: inject then matching approve is consistent", () => {
	const dir = telemetryDirWith("2026-07-21.jsonl", [
		JSON.stringify({ event: "inject", canonicalBlobSha: SHA64_A }),
		JSON.stringify({ event: "approve", candidateBlobSha: SHA64_A }),
	]);
	const r = auditTelemetry(dir);
	assert.equal(r.ok, true);
	assert.equal(r.lines, 2);
	assert.deepEqual(r.problems, []);
});

test("auditTelemetry: forged/displaced anchor is caught", () => {
	// An approve whose candidateBlobSha never appeared in an earlier inject row.
	const dir = telemetryDirWith("2026-07-21.jsonl", [
		JSON.stringify({ event: "inject", canonicalBlobSha: SHA64_A }),
		JSON.stringify({ event: "approve", candidateBlobSha: SHA64_B }),
	]);
	const r = auditTelemetry(dir);
	assert.equal(r.ok, false);
	assert.equal(r.problems.length, 1);
	assert.match(r.problems[0], /no matching earlier inject row \(forged or displaced anchor\)/);
});

test("auditTelemetry: anchor cross-check is per-file (no cross-file leakage)", () => {
	const dir = mkdtempSync(join(tmpdir(), "audit-lib-tel-"));
	writeFileSync(join(dir, "a.jsonl"), `${JSON.stringify({ event: "inject", canonicalBlobSha: SHA64_A })}\n`);
	// The approve is in a DIFFERENT file; the inject anchor must not carry over.
	writeFileSync(join(dir, "b.jsonl"), `${JSON.stringify({ event: "approve", candidateBlobSha: SHA64_A })}\n`);
	const r = auditTelemetry(dir);
	assert.equal(r.ok, false);
	assert.match(r.problems[0], /forged or displaced anchor/);
});

test("auditTelemetry: malformed JSON, unknown event, and bad sha shapes are flagged", () => {
	const dir = telemetryDirWith("2026-07-21.jsonl", [
		"{not json",
		JSON.stringify({ event: "teleport" }),
		JSON.stringify({ event: "inject", canonicalBlobSha: "short" }),
		JSON.stringify({ event: "reject", candidateBlobSha: "also-bad" }),
	]);
	const r = auditTelemetry(dir);
	assert.equal(r.ok, false);
	assert.equal(r.lines, 4);
	assert.match(r.problems.join("\n"), /not valid JSON/);
	assert.match(r.problems.join("\n"), /unknown event 'teleport'/);
	assert.match(r.problems.join("\n"), /malformed canonicalBlobSha/);
	assert.match(r.problems.join("\n"), /malformed candidateBlobSha/);
});
