import assert from "node:assert/strict";
import { test } from "node:test";

import {
	__testing,
	acceptCandidates,
	ENTRY_TYPES,
	SEVERITIES,
	type ProjectedCandidate,
	type RejectionReason,
} from "../candidate-gate.ts";

// -----------------------------------------------------------------------------
// Credential fixtures constructed programmatically (see canonicalize.test.ts
// for the rationale — `test/` singular vs secrets-guard's `tests/` plural).
// -----------------------------------------------------------------------------

const PEM_FIXTURE_HEADER = ["-----", "BEGIN ", "RSA ", "PRIVATE ", "KEY-----"].join("");
const AWS_FIXTURE_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const GH_FIXTURE_PAT = "ghp_" + "a".repeat(36);

// -----------------------------------------------------------------------------
// Base candidate builder — every test starts from a valid Warning candidate
// and mutates one field to exercise a single failure mode.
// -----------------------------------------------------------------------------

const SHA_VALID_40 = "1234567890abcdef1234567890abcdef12345678";
const SHA_VALID_64 = "a".repeat(64);

function validCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		domain: "kafka",
		title: "consumer lag exceeded",
		body: "increase max.poll.records or reduce processing time per record",
		entryType: "IssueFix",
		severity: "Warning",
		proposedBy: "code-review-expert",
		dedupeQuery: "kafka consumer lag high",
		canonical_blob_sha: SHA_VALID_40,
		...overrides,
	};
}

function payload(candidates: unknown[], opts: { schemaVersion?: unknown } = {}): string {
	const p: Record<string, unknown> = {
		schemaVersion: "schemaVersion" in opts ? opts.schemaVersion : 1,
		candidates,
	};
	return JSON.stringify(p);
}

function expectAccepted(json: string, n: number): readonly ProjectedCandidate[] {
	const r = acceptCandidates(json);
	assert.equal(r.rejected.length, 0, `expected no rejections, got: ${JSON.stringify(r.rejected)}`);
	assert.equal(r.accepted.length, n);
	return r.accepted;
}

function expectRejected(json: string, reason: RejectionReason, index = -1 as number | undefined): void {
	const r = acceptCandidates(json);
	assert.equal(r.rejected.length, 1, `expected 1 rejection, got: ${JSON.stringify(r.rejected)}`);
	assert.equal(r.rejected[0].reason, reason, `reason mismatch: ${JSON.stringify(r.rejected[0])}`);
	if (index !== undefined) assert.equal(r.rejected[0].index, index);
	assert.equal(r.accepted.length, 0);
}

// -----------------------------------------------------------------------------
// Happy paths
// -----------------------------------------------------------------------------

test("acceptCandidates: single Warning candidate — accepted", () => {
	const [c] = expectAccepted(payload([validCandidate()]), 1);
	assert.equal(c.domain, "kafka");
	assert.equal(c.entryType, "IssueFix");
	assert.equal(c.severity, "Warning");
	assert.equal(c.canonical_blob_sha, SHA_VALID_40);
});

test("acceptCandidates: single Critical candidate — accepted", () => {
	const [c] = expectAccepted(payload([validCandidate({ severity: "Critical" })]), 1);
	assert.equal(c.severity, "Critical");
});

test("acceptCandidates: single Info candidate WITH justification — accepted", () => {
	const [c] = expectAccepted(
		payload([validCandidate({ severity: "Info", justification: "long-tail deployment quirk" })]),
		1,
	);
	assert.equal(c.severity, "Info");
	assert.equal(c.justification, "long-tail deployment quirk");
});

test("acceptCandidates: mixed batch of 3 — all accepted, order preserved", () => {
	const cands = [
		validCandidate({ title: "one", severity: "Warning" }),
		validCandidate({ title: "two", severity: "Critical" }),
		validCandidate({ title: "three", severity: "Info", justification: "seen once in prod" }),
	];
	const acc = expectAccepted(payload(cands), 3);
	assert.deepEqual(acc.map((c) => c.title), ["one", "two", "three"]);
});

test("acceptCandidates: 64-char canonical_blob_sha (SHA-256) accepted", () => {
	expectAccepted(payload([validCandidate({ canonical_blob_sha: SHA_VALID_64 })]), 1);
});

test("acceptCandidates: optional fields (tags, source, sourceVersion) round-trip", () => {
	const [c] = expectAccepted(
		payload([
			validCandidate({
				tags: ["review", "consumer"],
				source: "code-review-expert",
				sourceVersion: "opus-4.7",
			}),
		]),
		1,
	);
	assert.deepEqual([...(c.tags ?? [])], ["review", "consumer"]);
	assert.equal(c.source, "code-review-expert");
	assert.equal(c.sourceVersion, "opus-4.7");
});

test("acceptCandidates: empty candidates array — accepted, no rejections", () => {
	const r = acceptCandidates(payload([]));
	assert.equal(r.accepted.length, 0);
	assert.equal(r.rejected.length, 0);
});

// -----------------------------------------------------------------------------
// Payload-level rejections (index=-1)
// -----------------------------------------------------------------------------

test("acceptCandidates: invalid JSON — payload-level invalid-json", () => {
	expectRejected("{not json", "invalid-json");
});

test("acceptCandidates: top-level not an object — payload-not-object", () => {
	expectRejected("[]", "payload-not-object");
	expectRejected("null", "payload-not-object");
	expectRejected('"hi"', "payload-not-object");
});

test("acceptCandidates: unknown top-level key — unknown-top-level-key", () => {
	const raw = JSON.stringify({ schemaVersion: 1, candidates: [], extra: 1 });
	const r = acceptCandidates(raw);
	assert.equal(r.rejected[0].reason, "unknown-top-level-key");
	assert.match(r.rejected[0].hint ?? "", /key='extra'/);
});

test("acceptCandidates: wrong schemaVersion — invalid-schema-version", () => {
	expectRejected(payload([], { schemaVersion: 2 }), "invalid-schema-version");
	expectRejected(payload([], { schemaVersion: "1" }), "invalid-schema-version");
});

test("acceptCandidates: candidates not an array — candidates-not-array", () => {
	const raw = JSON.stringify({ schemaVersion: 1, candidates: {} });
	expectRejected(raw, "candidates-not-array");
});

// -----------------------------------------------------------------------------
// Per-candidate rejections — index matches position in candidates[]
// -----------------------------------------------------------------------------

test("acceptCandidates: missing required field — missing-required-field", () => {
	const bad = validCandidate();
	delete bad.domain;
	expectRejected(payload([bad]), "missing-required-field", 0);
});

test("acceptCandidates: wrong-type on required field", () => {
	expectRejected(payload([validCandidate({ title: 123 })]), "wrong-type", 0);
});

test("acceptCandidates: invalid entryType enum", () => {
	expectRejected(payload([validCandidate({ entryType: "Bug" })]), "invalid-enum-value", 0);
});

test("acceptCandidates: invalid severity enum", () => {
	expectRejected(payload([validCandidate({ severity: "Fatal" })]), "invalid-enum-value", 0);
});

test("acceptCandidates: Info severity without justification — info-severity-requires-justification", () => {
	expectRejected(payload([validCandidate({ severity: "Info" })]), "info-severity-requires-justification", 0);
});

test("acceptCandidates: Info severity with blank justification — rejected", () => {
	expectRejected(
		payload([validCandidate({ severity: "Info", justification: "   " })]),
		"info-severity-requires-justification",
		0,
	);
});

test("acceptCandidates: missing canonical_blob_sha — missing-required-field", () => {
	const bad = validCandidate();
	delete bad.canonical_blob_sha;
	expectRejected(payload([bad]), "missing-required-field", 0);
});

test("acceptCandidates: malformed canonical_blob_sha (uppercase / wrong length)", () => {
	// A well-typed-but-malformed-hex value gets its own reason, distinct from a
	// genuine type mismatch on the field (#817).
	expectRejected(
		payload([validCandidate({ canonical_blob_sha: SHA_VALID_40.toUpperCase() })]),
		"invalid-canonical-blob-sha",
		0,
	);
	expectRejected(payload([validCandidate({ canonical_blob_sha: "abc" })]), "invalid-canonical-blob-sha", 0);
});

test("acceptCandidates: tags not string[] — wrong-type", () => {
	expectRejected(payload([validCandidate({ tags: "not-an-array" })]), "wrong-type", 0);
	expectRejected(payload([validCandidate({ tags: [1, 2] })]), "wrong-type", 0);
});

test("acceptCandidates: unknown per-candidate field — unknown-field", () => {
	const r = acceptCandidates(payload([validCandidate({ mystery: "field" })]));
	assert.equal(r.rejected[0].reason, "unknown-field");
	assert.match(r.rejected[0].hint ?? "", /field='mystery'/);
	assert.equal(r.rejected[0].index, 0);
});

test("acceptCandidates: candidate not an object — candidate-not-object", () => {
	expectRejected(payload(["nope"]), "candidate-not-object", 0);
	expectRejected(payload([null]), "candidate-not-object", 0);
	expectRejected(payload([[]]), "candidate-not-object", 0);
});

// -----------------------------------------------------------------------------
// Approval-state bypass — MUST reject, not silently strip.
// -----------------------------------------------------------------------------

test("acceptCandidates: approved:true is rejected (approval-state-field)", () => {
	const r = acceptCandidates(payload([validCandidate({ approved: true })]));
	assert.equal(r.rejected[0].reason, "approval-state-field");
	assert.match(r.rejected[0].hint ?? "", /field='approved'/);
});

test("acceptCandidates: approvedBy is rejected (approval-state-field)", () => {
	expectRejected(payload([validCandidate({ approvedBy: "me" })]), "approval-state-field", 0);
});

test("acceptCandidates: approvalTimestamp is rejected (approval-state-field)", () => {
	expectRejected(payload([validCandidate({ approvalTimestamp: 0 })]), "approval-state-field", 0);
});

test("acceptCandidates: approvalToken is rejected (approval-state-field)", () => {
	expectRejected(payload([validCandidate({ approvalToken: "x" })]), "approval-state-field", 0);
});

test("acceptCandidates: no approval-state field survives into accepted output", () => {
	// A candidate that ONLY has approval-state must fail; a batch alongside a
	// valid candidate must reject one and accept the other with independent
	// indexing.
	const cands = [validCandidate({ approved: true }), validCandidate({ title: "clean" })];
	const r = acceptCandidates(payload(cands));
	assert.equal(r.rejected.length, 1);
	assert.equal(r.rejected[0].index, 0);
	assert.equal(r.accepted.length, 1);
	assert.equal(r.accepted[0].title, "clean");
	// Extra belt+braces: no key resembling approval state appears anywhere in
	// the accepted output.
	const serialized = JSON.stringify(r.accepted);
	for (const k of __testing.APPROVAL_STATE_FIELDS) {
		assert.equal(serialized.includes(k), false, `accepted output leaked approval-state key '${k}'`);
	}
});

// -----------------------------------------------------------------------------
// Prototype poisoning
// -----------------------------------------------------------------------------

test("acceptCandidates: __proto__ at candidate root — prototype-poisoning", () => {
	// Hand-crafted JSON — `validCandidate({__proto__: {}})` would be stripped
	// by V8's object literal handling; the raw JSON string preserves the key.
	const raw = `{"schemaVersion":1,"candidates":[${JSON.stringify(validCandidate()).replace(
		/^\{/,
		'{"__proto__":{"polluted":true},',
	)}]}`;
	const r = acceptCandidates(raw);
	assert.equal(r.rejected[0].reason, "prototype-poisoning");
	assert.equal(r.rejected[0].hint, "key=__proto__");
});

test("acceptCandidates: constructor key at candidate root — prototype-poisoning", () => {
	const raw = `{"schemaVersion":1,"candidates":[${JSON.stringify(validCandidate()).replace(
		/^\{/,
		'{"constructor":"pwn",',
	)}]}`;
	expectRejected(raw, "prototype-poisoning", 0);
});

test("acceptCandidates: prototype key at candidate root — prototype-poisoning", () => {
	const raw = `{"schemaVersion":1,"candidates":[${JSON.stringify(validCandidate()).replace(
		/^\{/,
		'{"prototype":{},',
	)}]}`;
	expectRejected(raw, "prototype-poisoning", 0);
});

test("acceptCandidates: __proto__ nested inside tags-array element object — prototype-poisoning", () => {
	// tags is defined as string[], so a caller that jammed an object in there
	// with __proto__ should be caught by the recursive walker BEFORE the
	// tags type check (poison check runs first). Build the tags-element via
	// raw JSON so `__proto__` survives as an OWN property (a JS object
	// literal would set the prototype and drop it from own-props).
	const poisonedTagsElem = '{"__proto__":{"pwn":true}}';
	const cand = JSON.stringify(validCandidate()).replace(
		/\}$/,
		`,"tags":[${poisonedTagsElem}]}`,
	);
	const raw = `{"schemaVersion":1,"candidates":[${cand}]}`;
	expectRejected(raw, "prototype-poisoning", 0);
});

test("acceptCandidates: __proto__ INSIDE a body-string is NOT rejected (we do not re-parse strings)", () => {
	// A candidate body legitimately discussing __proto__ pollution should pass.
	const cand = validCandidate({
		body: 'Warning: never use `Object.assign(target, JSON.parse(input))` — a `{"__proto__":...}` in input pollutes.',
	});
	expectAccepted(payload([cand]), 1);
});

test("acceptCandidates: __proto__ at payload root — prototype-poisoning surfaces as unknown-top-level-key OR poisoning", () => {
	// Payload-level walker is not run (unknown-top-level-key fires first),
	// but the rejection MUST happen. Lock the actually-observed reason.
	const raw = '{"__proto__":{"schemaVersion":1},"schemaVersion":1,"candidates":[]}';
	const r = acceptCandidates(raw);
	assert.equal(r.rejected.length, 1);
	// Either signal is a valid fail-closed outcome; today it fires as unknown-top-level-key
	// because the payload-level scan runs before per-candidate walk.
	assert.ok(
		r.rejected[0].reason === "unknown-top-level-key" || r.rejected[0].reason === "prototype-poisoning",
		`unexpected reason: ${r.rejected[0].reason}`,
	);
});

// -----------------------------------------------------------------------------
// Secret detection — reject with category names, NEVER the matched substring.
// -----------------------------------------------------------------------------

test("acceptCandidates: AWS key in body — secret-detected, categories only", () => {
	const r = acceptCandidates(payload([validCandidate({ body: `leaked ${AWS_FIXTURE_KEY} here` })]));
	assert.equal(r.rejected[0].reason, "secret-detected");
	assert.match(r.rejected[0].hint ?? "", /categories=aws-access-key/);
	// The matched substring MUST NOT appear anywhere in the rejection surface.
	const surface = JSON.stringify(r.rejected);
	assert.equal(surface.includes(AWS_FIXTURE_KEY), false, "rejection surface leaked the matched secret");
});

test("acceptCandidates: PEM header in title — secret-detected", () => {
	const r = acceptCandidates(payload([validCandidate({ title: PEM_FIXTURE_HEADER })]));
	assert.equal(r.rejected[0].reason, "secret-detected");
	assert.match(r.rejected[0].hint ?? "", /categories=pem-private-key/);
	assert.equal(JSON.stringify(r.rejected).includes("BEGIN RSA PRIVATE KEY"), false);
});

test("acceptCandidates: GitHub PAT anywhere in candidate — secret-detected", () => {
	const r = acceptCandidates(payload([validCandidate({ tags: ["ok", GH_FIXTURE_PAT] })]));
	assert.equal(r.rejected[0].reason, "secret-detected");
	assert.match(r.rejected[0].hint ?? "", /categories=github-token/);
});

test("acceptCandidates: secret hidden in an UNKNOWN field still rejects as secret-detected (raw-scan defense)", () => {
	// Even though `garbage` is an unknown field that would normally trigger
	// `unknown-field`, the raw-serialization secret scan runs FIRST so the
	// caller gets the more security-relevant signal (never a partial write of
	// the secret into the approval prompt).
	const r = acceptCandidates(payload([validCandidate({ garbage: AWS_FIXTURE_KEY })]));
	assert.equal(r.rejected[0].reason, "secret-detected");
});

test("acceptCandidates: multiple secret categories deduplicated + sorted in hint", () => {
	const r = acceptCandidates(
		payload([validCandidate({ body: `${AWS_FIXTURE_KEY} and also ${PEM_FIXTURE_HEADER}` })]),
	);
	assert.equal(r.rejected[0].reason, "secret-detected");
	assert.match(r.rejected[0].hint ?? "", /categories=aws-access-key,pem-private-key/);
});

// -----------------------------------------------------------------------------
// Batch semantics — one bad, rest good
// -----------------------------------------------------------------------------

test("acceptCandidates: one rejection does not poison the batch", () => {
	const cands = [
		validCandidate({ title: "a" }),
		validCandidate({ title: "b", severity: "Info" }), // missing justification
		validCandidate({ title: "c" }),
	];
	const r = acceptCandidates(payload(cands));
	assert.equal(r.accepted.length, 2);
	assert.deepEqual(r.accepted.map((c) => c.title), ["a", "c"]);
	assert.equal(r.rejected.length, 1);
	assert.equal(r.rejected[0].index, 1);
	assert.equal(r.rejected[0].reason, "info-severity-requires-justification");
});

// -----------------------------------------------------------------------------
// Structural invariants
// -----------------------------------------------------------------------------

test("acceptCandidates: accepted objects are frozen and have no prototype-chain surprises", () => {
	const [c] = expectAccepted(payload([validCandidate({ tags: ["a"] })]), 1);
	assert.equal(Object.isFrozen(c), true);
	assert.equal(Object.isFrozen(c.tags), true);
	// No inherited Object.prototype keys leak through Reflect.ownKeys.
	const own = Reflect.ownKeys(c);
	for (const forbidden of __testing.PROTOTYPE_KEYS) {
		assert.equal(own.includes(forbidden), false);
	}
});

test("acceptCandidates: enums exported as readonly tuples are exhaustive", () => {
	// Locks the exported constants so a downstream `satisfies` check catches
	// drift between EntryType/Severity types and their runtime lists.
	assert.deepEqual([...ENTRY_TYPES], ["IssueFix", "Caveat", "Requirement", "Pattern"]);
	assert.deepEqual([...SEVERITIES], ["Info", "Warning", "Critical"]);
});

test("__testing.findPrototypeKey: returns null for clean input, terminal key on hit", () => {
	assert.equal(__testing.findPrototypeKey({ a: 1, b: [2, 3] }, 0), null);
	// Build the poisoned tree via JSON.parse so `__proto__` is an OWN
	// property (a JS literal would set the prototype instead).
	const poisoned = JSON.parse('{"a":{"b":{"__proto__":{}}}}') as unknown;
	assert.equal(__testing.findPrototypeKey(poisoned, 0), "__proto__");
});

// -----------------------------------------------------------------------------
// Hardening added post-review (High/Medium findings from code-review-expert +
// security-review-expert on commit 6791a07).
// -----------------------------------------------------------------------------

test("acceptCandidates: invalid-json rejection carries NO hint (V8 SyntaxError echoes input)", () => {
	// Adversarial: leading bytes contain a credential. Prior implementation
	// echoed V8's SyntaxError message which quotes source input, leaking the
	// secret into the operator terminal.
	const evil = `${AWS_FIXTURE_KEY}: not json`;
	const r = acceptCandidates(evil);
	assert.equal(r.rejected[0].reason, "invalid-json");
	assert.equal(r.rejected[0].hint, undefined, "invalid-json hint must be absent to prevent input echo");
	// Belt-and-suspenders: rejection surface serialization must not contain the fixture.
	assert.equal(JSON.stringify(r.rejected).includes(AWS_FIXTURE_KEY), false);
});

test("acceptCandidates: unknown-top-level-key with credential-shaped key redacts by category", () => {
	const raw = JSON.stringify({
		schemaVersion: 1,
		candidates: [],
		[AWS_FIXTURE_KEY]: 1,
	});
	const r = acceptCandidates(raw);
	assert.equal(r.rejected[0].reason, "unknown-top-level-key");
	assert.match(r.rejected[0].hint ?? "", /key=<redacted:categories=aws-access-key>/);
	assert.equal(JSON.stringify(r.rejected).includes(AWS_FIXTURE_KEY), false);
});

test("acceptCandidates: unknown-top-level-key with benign key still names the key (usability)", () => {
	const raw = JSON.stringify({ schemaVersion: 1, candidates: [], typo_field: 1 });
	const r = acceptCandidates(raw);
	assert.equal(r.rejected[0].reason, "unknown-top-level-key");
	assert.match(r.rejected[0].hint ?? "", /key='typo_field'/);
});

test("acceptCandidates: invalid-schema-version with credential-shaped value redacts by category", () => {
	const raw = JSON.stringify({ schemaVersion: AWS_FIXTURE_KEY, candidates: [] });
	const r = acceptCandidates(raw);
	assert.equal(r.rejected[0].reason, "invalid-schema-version");
	assert.match(r.rejected[0].hint ?? "", /got=<redacted:categories=aws-access-key>/);
	assert.equal(JSON.stringify(r.rejected).includes(AWS_FIXTURE_KEY), false);
});

test("acceptCandidates: invalid-schema-version with benign value still shows shape", () => {
	const raw = JSON.stringify({ schemaVersion: 2, candidates: [] });
	const r = acceptCandidates(raw);
	assert.equal(r.rejected[0].reason, "invalid-schema-version");
	assert.match(r.rejected[0].hint ?? "", /got='2' expected=1/);
});

test("acceptCandidates: findPrototypeKey depth cap prevents stack overflow (DoS defense)", () => {
	// Build a JSON string ~85k-deep and confirm acceptCandidates rejects
	// as prototype-poisoning without stack-overflow escaping the try/catch.
	// Cap our test depth at 2000 (well above MAX_POISON_WALK_DEPTH=256 but
	// below actual stack ceiling) to keep the test fast and deterministic.
	const DEPTH = 2000;
	let inner = "1";
	for (let i = 0; i < DEPTH; i++) inner = `{"a":${inner}}`;
	const cand = validCandidate({ body: "deep" });
	// Splice the deep tree into the candidate via a raw-string post-processing
	// (using an approval-state field slot that we then rename to a legal
	// unknown-field path won't work; instead abuse `tags` which will be
	// caught by the poison walker before the type check).
	const raw = `{"schemaVersion":1,"candidates":[${JSON.stringify(cand).replace(
		/\}$/,
		`,"tags":[${inner}]}`,
	)}]}`;
	const r = acceptCandidates(raw);
	// Should be a structural rejection, not an escape.
	assert.equal(r.rejected.length, 1);
	// Deep tree contains no __proto__/constructor/prototype key, so the
	// walker returns null after hitting the depth cap ONLY via the marker
	// path. If the walker terminates cleanly below the cap the candidate
	// passes the poison check and instead fails on tags type (`wrong-type`).
	assert.ok(
		r.rejected[0].reason === "prototype-poisoning" || r.rejected[0].reason === "wrong-type",
		`unexpected reason: ${r.rejected[0].reason}`,
	);
});

test("__testing.findPrototypeKey: depth cap returns synthetic marker", () => {
	// Build a plain (non-poisoned) tree deeper than the cap.
	let deep: unknown = { end: true };
	for (let i = 0; i < __testing.MAX_POISON_WALK_DEPTH + 5; i++) deep = { a: deep };
	assert.equal(__testing.findPrototypeKey(deep, 0), "<depth-exceeded>");
});

test("acceptCandidates: {severity:'Info', justification:null} yields the Info-specific signal (ordering fix)", () => {
	// Pre-fix, OPTIONAL_STRING_FIELDS included `justification`, so a null
	// value fired `wrong-type` before the Info-severity gate could produce
	// the more specific `info-severity-requires-justification` signal.
	expectRejected(
		payload([validCandidate({ severity: "Info", justification: null })]),
		"info-severity-requires-justification",
		0,
	);
});

test("acceptCandidates: non-Info severity with wrong-type justification still surfaces wrong-type", () => {
	// Regression: after moving justification out of OPTIONAL_STRING_FIELDS,
	// non-Info severity paths must still catch a wrong-type justification.
	expectRejected(
		payload([validCandidate({ severity: "Warning", justification: 42 })]),
		"wrong-type",
		0,
	);
});

test("__testing.safeHint: passes through benign values, redacts on category hit", () => {
	assert.equal(__testing.safeHint("key", "benign"), "key='benign'");
	const h = __testing.safeHint("key", AWS_FIXTURE_KEY);
	assert.equal(h, "key=<redacted:categories=aws-access-key>");
	assert.equal(h.includes(AWS_FIXTURE_KEY), false);
});

// -----------------------------------------------------------------------------
// Second-round hardening: universal-first-scan invariant (re-review of fc5058f)
// -----------------------------------------------------------------------------

test("acceptCandidates: prototype-poisoning hint carries ONLY the terminal key, never a path", () => {
	// Post-hardening the hint is `key=<PROTOTYPE_KEY>`, structurally free
	// of any attacker-controlled intermediate key names (defense in depth
	// even if the pre-walk secret scan ever misses a novel credential
	// shape).
	const raw = `{"schemaVersion":1,"candidates":[${JSON.stringify(validCandidate()).replace(
		/^\{/,
		'{"harmless_wrapper":{"__proto__":{}},',
	)}]}`;
	const r = acceptCandidates(raw);
	assert.equal(r.rejected[0].reason, "prototype-poisoning");
	assert.equal(r.rejected[0].hint, "key=__proto__");
	assert.equal((r.rejected[0].hint ?? "").includes("harmless_wrapper"), false);
});

test("acceptCandidates: candidate with credential-shaped KEY NAME + poison key → secret-detected (not prototype-poisoning)", () => {
	// Original re-review HIGH finding: a candidate whose intermediate key
	// name is credential-shaped AND that also contains a poison key would,
	// pre-hardening, surface `at=candidates[0].AKIA….__proto__` — the
	// key name leaked into the rejection hint. Universal-first-scan
	// ordering now routes this to secret-detected before poisoning check.
	const raw = `{"schemaVersion":1,"candidates":[${JSON.stringify(validCandidate()).replace(
		/^\{/,
		`{"${AWS_FIXTURE_KEY}_x":{"__proto__":{}},`,
	)}]}`;
	const r = acceptCandidates(raw);
	assert.equal(r.rejected[0].reason, "secret-detected");
	assert.equal(JSON.stringify(r.rejected).includes(AWS_FIXTURE_KEY), false);
});

test("acceptCandidates: candidate with credential-shaped KEY NAME + unknown field → secret-detected (locks ordering invariant)", () => {
	// code-review Warning: the per-candidate `unknown-field` hint
	// interpolates the raw own-property name. Universal-first-scan
	// ordering guarantees a secret-shaped key never reaches that site.
	// This test locks the ordering — if a future refactor inserts a
	// pre-check between scan and unknown-field, this test fails.
	const raw = JSON.stringify({
		schemaVersion: 1,
		candidates: [{ ...validCandidate(), [`${AWS_FIXTURE_KEY}_field`]: "noop" }],
	});
	const r = acceptCandidates(raw);
	assert.equal(r.rejected[0].reason, "secret-detected");
	assert.equal(JSON.stringify(r.rejected).includes(AWS_FIXTURE_KEY), false);
});
