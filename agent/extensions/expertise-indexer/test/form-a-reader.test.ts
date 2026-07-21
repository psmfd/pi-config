/**
 * form-a-reader tests — hardened Form A constraint set (#600, ADR-0095).
 *
 * These tests write real files under literal /tmp (the transport contract's
 * anchored prefix — os.tmpdir() is NOT /tmp on macOS) and clean up after
 * themselves.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { MAX_FORM_A_BYTES, readCandidatesFile } from "../form-a-reader.ts";

let seq = Date.now();
function tmpPath(): string {
	seq += 1;
	return `/tmp/subagent-expertise-test-agent-${seq}.candidates.json`;
}

test("valid 0600 file in /tmp reads back its content", () => {
	const p = tmpPath();
	fs.writeFileSync(p, '{"schemaVersion":1,"candidates":[]}', { mode: 0o600 });
	try {
		const r = readCandidatesFile(p);
		assert.ok(r.ok);
		assert.equal(r.rawJson, '{"schemaVersion":1,"candidates":[]}');
	} finally {
		fs.unlinkSync(p);
	}
});

test("path-shape violations are rejected before any I/O", () => {
	for (const bad of [
		"/var/tmp/subagent-expertise-a-1.candidates.json",
		"/tmp/../etc/subagent-expertise-a-1.candidates.json",
		"/tmp/other-name-1.json",
		"/tmp/subagent-expertise-UPPER-1.candidates.json",
	]) {
		const r = readCandidatesFile(bad);
		assert.ok(!r.ok);
		assert.ok(r.reason === "bad-path-shape" || r.reason === "parent-escape", `${bad} → ${r.reason}`);
	}
});

test("validly-named file one real subdir below /tmp is rejected parent-escape (#817)", () => {
	// A validly-named file that PASSES the up-front string-shape check but sits
	// one real directory below /tmp, so only the realpath(dirname)==realpath(/tmp)
	// comparison can catch it — exercising that check on its own merits.
	const dir = fs.mkdtempSync("/tmp/form-a-escape-");
	const p = `${dir}/subagent-expertise-escape-1.candidates.json`;
	fs.writeFileSync(p, "{}", { mode: 0o600 });
	try {
		const r = readCandidatesFile(p);
		assert.ok(!r.ok && r.reason === "parent-escape", `expected parent-escape, got ${r.ok ? "ok" : r.reason}`);
	} finally {
		fs.unlinkSync(p);
		fs.rmdirSync(dir);
	}
});

test("missing file fails open-failed", () => {
	const r = readCandidatesFile(tmpPath());
	assert.ok(!r.ok && r.reason === "open-failed");
});

test("symlink at the leaf is rejected (O_NOFOLLOW)", () => {
	const target = tmpPath();
	const link = tmpPath();
	fs.writeFileSync(target, "{}", { mode: 0o600 });
	fs.symlinkSync(target, link);
	try {
		const r = readCandidatesFile(link);
		assert.ok(!r.ok && r.reason === "open-failed");
	} finally {
		fs.unlinkSync(link);
		fs.unlinkSync(target);
	}
});

test("wrong permissions (0644) are rejected", () => {
	const p = tmpPath();
	fs.writeFileSync(p, "{}", { mode: 0o644 });
	try {
		const r = readCandidatesFile(p);
		assert.ok(!r.ok && r.reason === "wrong-permissions");
		assert.equal(r.detail, "0644");
	} finally {
		fs.unlinkSync(p);
	}
});

test("oversized file is rejected", () => {
	const p = tmpPath();
	fs.writeFileSync(p, "x".repeat(MAX_FORM_A_BYTES + 1), { mode: 0o600 });
	try {
		const r = readCandidatesFile(p);
		assert.ok(!r.ok && r.reason === "too-large");
	} finally {
		fs.unlinkSync(p);
	}
});
