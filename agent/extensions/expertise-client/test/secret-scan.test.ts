/**
 * expertise-client — secret-scan tests (ADR-0028, #318).
 *
 * Asserts the body guard matches each credential category and returns category
 * NAMES only — never the matched secret text.
 *
 * Fixture literals are assembled at runtime from fragments so this test file
 * itself contains no committed secret pattern (keeps secrets-guard happy).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanForSecrets } from "../lib/secret-scan.ts";

const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const GH_CLASSIC = "ghp_" + "A".repeat(36);
const GH_FINE = "github_pat_" + "B".repeat(82);
const PEM = "-----BEGIN RSA " + "PRIVATE KEY-----";

test("clean body returns []", () => {
  assert.deepEqual(
    scanForSecrets({ title: "kafka tuning", content: "use idempotent producers" }),
    [],
  );
});

test("detects AWS access key in content", () => {
  const cats = scanForSecrets({ title: "t", content: `key ${AWS_KEY}` });
  assert.deepEqual(cats, ["aws-access-key"]);
});

test("detects GitHub classic PAT in title", () => {
  const cats = scanForSecrets({ title: GH_CLASSIC, content: "c" });
  assert.deepEqual(cats, ["github-pat-classic"]);
});

test("detects GitHub fine-grained PAT in a tag", () => {
  const cats = scanForSecrets({ title: "t", content: "c", tags: ["ok", GH_FINE] });
  assert.deepEqual(cats, ["github-pat-fine-grained"]);
});

test("detects PEM private-key block in source", () => {
  const cats = scanForSecrets({ title: "t", content: "c", source: PEM });
  assert.deepEqual(cats, ["pem-private-key"]);
});

test("returned values are category names, never the secret text", () => {
  const cats = scanForSecrets({
    title: GH_CLASSIC,
    content: AWS_KEY,
    source: PEM,
  });
  const joined = cats.join("|");
  assert.equal(joined.includes(GH_CLASSIC), false);
  assert.equal(joined.includes(AWS_KEY), false);
  assert.equal(joined.includes(PEM), false);
});
