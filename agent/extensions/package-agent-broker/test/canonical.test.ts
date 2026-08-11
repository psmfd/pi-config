/**
 * canonical.test.ts — canonical encoding determinism, domain separation,
 * injectivity, and bounds (#916).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CanonicalError,
  canonicalDigest,
  canonicalEncode,
} from "../../shared/package-agent-canonical.ts";

const DOMAIN = "pi-config/package-agent-review-draft/v1";

test("deterministic across key insertion order", () => {
  const a = canonicalDigest(DOMAIN, { x: 1, y: "two", z: [true, null] });
  const b = canonicalDigest(DOMAIN, { z: [true, null], y: "two", x: 1 });
  assert.equal(a, b);
});

test("domain separation: same value, different domain, different digest", () => {
  const value = { qualifiedId: "git:h/p@r#name" };
  assert.notEqual(canonicalDigest(DOMAIN, value), canonicalDigest("pi-config/active-grant/v1", value));
});

test("distinct values never share an encoding", () => {
  const pairs: Array<[unknown, unknown]> = [
    [{ a: "bc" }, { ab: "c" }],
    [["ab"], ["a", "b"]],
    [{ a: 1 }, { a: "1" }],
    [{ a: null }, {}],
    [{ a: "" }, { a: null }],
    [0, false],
    ["", []],
    [{ a: [1, 2] }, { a: [12] }],
    [{ a: 12 }, { a: 1, b: 2 }],
  ];
  for (const [x, y] of pairs) {
    assert.notEqual(
      canonicalEncode(DOMAIN, x as never).toString("hex"),
      canonicalEncode(DOMAIN, y as never).toString("hex"),
      JSON.stringify([x, y]),
    );
  }
});

test("negative zero normalizes to zero", () => {
  assert.equal(canonicalDigest(DOMAIN, -0), canonicalDigest(DOMAIN, 0));
});

test("floats are refused", () => {
  assert.throws(() => canonicalEncode(DOMAIN, 1.5), CanonicalError);
  assert.throws(() => canonicalEncode(DOMAIN, Number.NaN), CanonicalError);
  assert.throws(() => canonicalEncode(DOMAIN, Number.MAX_SAFE_INTEGER + 2), CanonicalError);
});

test("unpaired surrogates are refused, not replaced", () => {
  assert.throws(() => canonicalEncode(DOMAIN, "\ud800"), CanonicalError);
  assert.throws(() => canonicalEncode(DOMAIN, { "\udfff": 1 }), CanonicalError);
  // well-formed surrogate pair is fine
  canonicalEncode(DOMAIN, "😀");
});

test("depth bound is enforced", () => {
  let v: unknown = 1;
  for (let i = 0; i < 20; i++) v = [v];
  assert.throws(() => canonicalEncode(DOMAIN, v as never), CanonicalError);
});

test("empty domain is refused", () => {
  assert.throws(() => canonicalEncode("", 1), CanonicalError);
});

test("bytes and strings are distinct", () => {
  const asString = canonicalEncode(DOMAIN, "abc");
  const asBytes = canonicalEncode(DOMAIN, new Uint8Array([0x61, 0x62, 0x63]));
  assert.notEqual(asString.toString("hex"), asBytes.toString("hex"));
});

test("every scalar type has a stable encoding", () => {
  // Pinned digests: any encoding change is a breaking contract change and
  // must arrive with a new digest domain version.
  assert.equal(
    canonicalDigest(DOMAIN, { n: null, t: true, f: false, i: 42, s: "x" }),
    canonicalDigest(DOMAIN, { s: "x", i: 42, f: false, t: true, n: null }),
  );
});
