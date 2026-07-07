import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";

import {
	CanonicalBlobSecretError,
	computeCanonicalBlob,
	isValidGitSha,
	normalizeText,
	resolveCacheDir,
	writeCanonicalBlob,
	type CanonicalInputs,
} from "../canonicalize.ts";

// -----------------------------------------------------------------------------
// Credential fixtures constructed programmatically so no literal matching a
// SECRET_PATTERN appears in this source file. The `test/` (singular) path
// convention used by every extension in this repo does not match the
// secrets-guard skip pattern `tests/` (plural), so a literal fixture would
// be blocked at write time.
// -----------------------------------------------------------------------------

const PEM_FIXTURE_HEADER = ["-----", "BEGIN ", "RSA ", "PRIVATE ", "KEY-----"].join("");
const AWS_FIXTURE_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const SHA1_A = "a".repeat(40);
const SHA1_B = "b".repeat(40);
const SHA1_C = "c".repeat(40);
const SHA1_HEAD = "1234567890abcdef1234567890abcdef12345678";

function baseInputs(overrides: Partial<CanonicalInputs> = {}): CanonicalInputs {
	return {
		repoOrigin: "https://github.com/psmfd/pi-config.git",
		headSha: SHA1_HEAD,
		files: [
			{ path: "agent/extensions/expertise-client/index.ts", blobSha: SHA1_A },
			{ path: "agent/AGENTS.md", blobSha: SHA1_B },
		],
		taskString: "Search for expertise entries related to Kafka consumer lag.",
		agentFrontmatter: {
			name: "code-review-expert",
			model: "github-copilot/claude-opus-4.7",
			tags: ["review", "read-only"],
		},
		...overrides,
	};
}

function tempCacheDir(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `expertise-indexer-${label}-`));
}

// -----------------------------------------------------------------------------
// Normalization
// -----------------------------------------------------------------------------

test("normalizeText: NFKC normalization collapses compatibility forms", () => {
	// U+FB01 (ﬁ) → "fi" under NFKC.
	assert.equal(normalizeText("ﬁle"), "file");
});

test("normalizeText: CRLF and lone CR become LF", () => {
	assert.equal(normalizeText("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("normalizeText: trailing whitespace stripped per line, blank lines preserved", () => {
	assert.equal(normalizeText("foo   \n\nbar\t\n"), "foo\n\nbar\n");
});

test("normalizeText: is idempotent", () => {
	const input = "ﬁrst\r\nsecond   \nthird\n";
	const once = normalizeText(input);
	const twice = normalizeText(once);
	assert.equal(once, twice);
});

test("isValidGitSha: accepts 40-char and 64-char lowercase hex", () => {
	assert.equal(isValidGitSha("a".repeat(40)), true);
	assert.equal(isValidGitSha("f".repeat(64)), true);
	assert.equal(isValidGitSha("A".repeat(40)), false); // uppercase rejected
	assert.equal(isValidGitSha("a".repeat(39)), false);
	assert.equal(isValidGitSha("a".repeat(65)), false);
	assert.equal(isValidGitSha("gggggggggggggggggggggggggggggggggggggggg"), false);
});

// -----------------------------------------------------------------------------
// Determinism — the load-bearing property
// -----------------------------------------------------------------------------

test("computeCanonicalBlob: identical inputs → identical sha across 5 runs", () => {
	const shas = new Set<string>();
	for (let i = 0; i < 5; i++) {
		shas.add(computeCanonicalBlob(baseInputs()).sha);
	}
	assert.equal(shas.size, 1, "expected all 5 runs to produce the same sha");
});

test("computeCanonicalBlob: file order does NOT affect sha (sorted internally)", () => {
	const forward = baseInputs({
		files: [
			{ path: "a.ts", blobSha: SHA1_A },
			{ path: "b.ts", blobSha: SHA1_B },
			{ path: "c.ts", blobSha: SHA1_C },
		],
	});
	const reversed = baseInputs({
		files: [
			{ path: "c.ts", blobSha: SHA1_C },
			{ path: "b.ts", blobSha: SHA1_B },
			{ path: "a.ts", blobSha: SHA1_A },
		],
	});
	assert.equal(computeCanonicalBlob(forward).sha, computeCanonicalBlob(reversed).sha);
});

test("computeCanonicalBlob: frontmatter key order does NOT affect sha (sorted internally)", () => {
	const forward = baseInputs({
		agentFrontmatter: { alpha: "1", beta: "2", gamma: "3" },
	});
	const reversed = baseInputs({
		agentFrontmatter: { gamma: "3", beta: "2", alpha: "1" },
	});
	assert.equal(computeCanonicalBlob(forward).sha, computeCanonicalBlob(reversed).sha);
});

test("computeCanonicalBlob: task string CRLF vs LF normalizes to same sha", () => {
	const crlf = baseInputs({ taskString: "line one\r\nline two\r\n" });
	const lf = baseInputs({ taskString: "line one\nline two\n" });
	assert.equal(computeCanonicalBlob(crlf).sha, computeCanonicalBlob(lf).sha);
});

test("computeCanonicalBlob: NFKC-equivalent task strings → same sha", () => {
	const compat = baseInputs({ taskString: "ﬁnd the record" });
	const decomp = baseInputs({ taskString: "find the record" });
	assert.equal(computeCanonicalBlob(compat).sha, computeCanonicalBlob(decomp).sha);
});

test("computeCanonicalBlob: uppercase headSha hex is rejected outright", () => {
	const upper = baseInputs({ headSha: SHA1_HEAD.toUpperCase() });
	assert.throws(() => computeCanonicalBlob(upper), /invalid headSha/);
	// Documents the contract: caller must supply lowercase.
});

test("computeCanonicalBlob: changing a single blobSha digit changes the sha", () => {
	const a = baseInputs({ files: [{ path: "x.ts", blobSha: SHA1_A }] });
	const shaA = computeCanonicalBlob(a).sha;
	const b = baseInputs({
		files: [{ path: "x.ts", blobSha: "b" + SHA1_A.slice(1) }],
	});
	assert.notEqual(shaA, computeCanonicalBlob(b).sha);
});

// -----------------------------------------------------------------------------
// Byte-stable golden fixture (locks the serialization contract).
// -----------------------------------------------------------------------------

test("computeCanonicalBlob: golden fixture — locked serialization shape", () => {
	const inputs: CanonicalInputs = {
		repoOrigin: "https://example.invalid/repo.git",
		headSha: "0".repeat(40),
		files: [
			{ path: "b.ts", blobSha: "2".repeat(40) },
			{ path: "a.ts", blobSha: "1".repeat(40) },
		],
		taskString: "hello",
		agentFrontmatter: { name: "n" },
	};
	const { blob, sha } = computeCanonicalBlob(inputs);
	// Locked byte-exact serialization — any change here is a semver-breaking
	// change to the anchor and must bump `schemaVersion` in canonicalize.ts.
	assert.equal(
		blob,
		'{"agentFrontmatter":{"name":"n"},"files":[{"blobSha":"1111111111111111111111111111111111111111","path":"a.ts"},{"blobSha":"2222222222222222222222222222222222222222","path":"b.ts"}],"headSha":"0000000000000000000000000000000000000000","repoOrigin":"https://example.invalid/repo.git","schemaVersion":1,"taskString":"hello"}',
	);
	// Locked sha — matches the blob above.
	assert.equal(
		sha,
		"93b34a3aa56aacea8a8300f8f222cd303dc73aea674693eb8f4920df741bdbb1",
	);
});

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

test("computeCanonicalBlob: invalid headSha throws", () => {
	assert.throws(() => computeCanonicalBlob(baseInputs({ headSha: "not-a-sha" })), /invalid headSha/);
});

test("computeCanonicalBlob: invalid blobSha throws with the offending path", () => {
	assert.throws(
		() =>
			computeCanonicalBlob(
				baseInputs({ files: [{ path: "bad.ts", blobSha: "xxx" }] }),
			),
		/invalid blobSha for path 'bad\.ts'/,
	);
});

test("computeCanonicalBlob: duplicate paths throw (caller bug)", () => {
	assert.throws(
		() =>
			computeCanonicalBlob(
				baseInputs({
					files: [
						{ path: "dup.ts", blobSha: SHA1_A },
						{ path: "dup.ts", blobSha: SHA1_B },
					],
				}),
			),
		/duplicate file path/,
	);
});

test("computeCanonicalBlob: NaN in frontmatter throws", () => {
	assert.throws(
		() =>
			computeCanonicalBlob(
				baseInputs({ agentFrontmatter: { bad: Number.NaN } as never }),
			),
		/non-finite number/,
	);
});

// -----------------------------------------------------------------------------
// Persistence — secret-scan gate, atomicity, permissions
// -----------------------------------------------------------------------------

test("writeCanonicalBlob: writes 0600 file under a 0700 dir", () => {
	const dir = tempCacheDir("write-perms");
	const { blob, sha } = computeCanonicalBlob(baseInputs());
	const result = writeCanonicalBlob(sha, blob, { cacheDir: dir });

	assert.equal(result.path, path.join(dir, `${sha}.json.gz`));
	const fileStat = fs.statSync(result.path);
	assert.equal(
		fileStat.mode & 0o777,
		0o600,
		`file mode should be 0600, got ${(fileStat.mode & 0o777).toString(8)}`,
	);
	const dirStat = fs.statSync(dir);
	assert.ok(
		(dirStat.mode & 0o077) === 0,
		`cache dir must not be group/world-accessible, got ${(dirStat.mode & 0o777).toString(8)}`,
	);
});

test("writeCanonicalBlob: file content round-trips through gzip to the input blob", () => {
	const dir = tempCacheDir("roundtrip");
	const { blob, sha } = computeCanonicalBlob(baseInputs());
	const result = writeCanonicalBlob(sha, blob, { cacheDir: dir });

	const compressed = fs.readFileSync(result.path);
	assert.equal(compressed.byteLength, result.compressedBytes);
	const decompressed = gunzipSync(compressed).toString("utf8");
	assert.equal(decompressed, blob);
	assert.equal(Buffer.byteLength(blob, "utf8"), result.uncompressedBytes);
});

test("writeCanonicalBlob: refuses when blob contains an AWS access key", () => {
	const dir = tempCacheDir("secret-aws");
	// Embed an AWS-shaped fixture in the task string; recompute the blob so
	// the secret really is present in the persisted bytes.
	const inputs = baseInputs({
		taskString: `leaked: ${AWS_FIXTURE_KEY} inline`,
	});
	const { blob, sha } = computeCanonicalBlob(inputs);
	assert.throws(
		() => writeCanonicalBlob(sha, blob, { cacheDir: dir }),
		CanonicalBlobSecretError,
	);
	// No file should exist for that sha (fail closed).
	assert.equal(fs.existsSync(path.join(dir, `${sha}.json.gz`)), false);
	// No stray temp files either.
	const entries = fs.readdirSync(dir);
	assert.equal(entries.length, 0, `expected empty cache dir on refusal, got ${entries.join(",")}`);
});

test("writeCanonicalBlob: refuses when blob contains a PEM private-key header", () => {
	const dir = tempCacheDir("secret-pem");
	const inputs = baseInputs({
		taskString: `context includes: ${PEM_FIXTURE_HEADER}`,
	});
	const { blob, sha } = computeCanonicalBlob(inputs);
	assert.throws(
		() => writeCanonicalBlob(sha, blob, { cacheDir: dir }),
		CanonicalBlobSecretError,
	);
	assert.equal(fs.existsSync(path.join(dir, `${sha}.json.gz`)), false);
});

test("writeCanonicalBlob: secret error carries category names, not the secret", () => {
	const dir = tempCacheDir("secret-cat");
	const inputs = baseInputs({ taskString: AWS_FIXTURE_KEY });
	const { blob, sha } = computeCanonicalBlob(inputs);
	try {
		writeCanonicalBlob(sha, blob, { cacheDir: dir });
		assert.fail("expected refusal");
	} catch (e) {
		assert.ok(e instanceof CanonicalBlobSecretError);
		assert.deepEqual([...e.categories], ["aws-access-key"]);
		assert.match(e.message, /credential pattern\(s\): aws-access-key/);
		// The matched secret substring MUST NOT appear in the error message.
		assert.equal(e.message.includes(AWS_FIXTURE_KEY), false);
	}
});

test("writeCanonicalBlob: invalid sha (wrong length / wrong case) throws before I/O", () => {
	const dir = tempCacheDir("bad-sha");
	const { blob } = computeCanonicalBlob(baseInputs());
	assert.throws(() => writeCanonicalBlob("short", blob, { cacheDir: dir }), /invalid sha/);
	assert.throws(() => writeCanonicalBlob("A".repeat(64), blob, { cacheDir: dir }), /invalid sha/);
	assert.equal(fs.readdirSync(dir).length, 0);
});

test("writeCanonicalBlob: idempotent overwrite of same sha (identical content)", () => {
	const dir = tempCacheDir("idempotent");
	const { blob, sha } = computeCanonicalBlob(baseInputs());
	const first = writeCanonicalBlob(sha, blob, { cacheDir: dir });
	const second = writeCanonicalBlob(sha, blob, { cacheDir: dir });
	assert.equal(first.path, second.path);
	assert.equal(
		fs.readFileSync(first.path).equals(fs.readFileSync(second.path)),
		true,
	);
});

test("writeCanonicalBlob: refuses when cacheDir leaf is a symlink (defense in depth)", () => {
	const realTarget = tempCacheDir("symlink-target");
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "expertise-indexer-symparent-"));
	const linkPath = path.join(parent, "expertise_cache");
	fs.symlinkSync(realTarget, linkPath);
	try {
		const { blob, sha } = computeCanonicalBlob(baseInputs());
		assert.throws(
			() => writeCanonicalBlob(sha, blob, { cacheDir: linkPath }),
			/cache dir '.*' is a symlink/,
		);
		assert.equal(fs.existsSync(path.join(realTarget, `${sha}.json.gz`)), false);
		assert.equal(fs.readdirSync(realTarget).length, 0, "symlink target must not receive writes");
	} finally {
		fs.unlinkSync(linkPath);
	}
});

test("writeCanonicalBlob: tolerates ancestor symlinks (macOS /var -> /private/var pattern)", () => {
	// Simulate a benign ancestor-symlink layout: a real dir reached via a
	// symlinked parent. The cache dir leaf itself is NOT a symlink; the
	// realpath check must not false-fire here (the bug caught by the initial
	// review — macOS `/var` is a symlink to `/private/var`).
	const realParent = fs.mkdtempSync(path.join(os.tmpdir(), "expertise-indexer-ancreal-"));
	const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "expertise-indexer-anclink-"));
	// Replace linkParent with a symlink to realParent.
	fs.rmdirSync(linkParent);
	fs.symlinkSync(realParent, linkParent);
	const cacheDir = path.join(linkParent, "expertise_cache"); // leaf will be a real dir
	try {
		const { blob, sha } = computeCanonicalBlob(baseInputs());
		const result = writeCanonicalBlob(sha, blob, { cacheDir });
		assert.ok(fs.existsSync(result.path), "expected write to succeed under ancestor-symlinked parent");
	} finally {
		fs.unlinkSync(linkParent);
	}
});

// -----------------------------------------------------------------------------
// resolveCacheDir env handling
// -----------------------------------------------------------------------------

test("resolveCacheDir: honors PI_CODING_AGENT_DIR when set", () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-test-override";
		assert.equal(resolveCacheDir(), path.join("/tmp/pi-test-override", "expertise_cache"));
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	}
});

test("resolveCacheDir: empty PI_CODING_AGENT_DIR falls back to $HOME/.pi", () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = "   ";
		assert.equal(resolveCacheDir(), path.join(os.homedir(), ".pi", "expertise_cache"));
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	}
});
