/** Tests for plain-english/config.ts — parsing, globs, path eligibility. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_EXCLUDE,
  DEFAULTS,
  globToRegExp,
  isEligiblePath,
  parseConfig,
  type PlainEnglishConfig,
} from "../config.ts";

const CWD = "/repo";

function cfg(overrides: Partial<PlainEnglishConfig> = {}): PlainEnglishConfig {
  return { ...DEFAULTS, enabled: true, ...overrides };
}

test("parseConfig: non-object → defaults (disabled)", () => {
  assert.deepEqual(parseConfig(undefined), DEFAULTS);
  assert.deepEqual(parseConfig("yes"), DEFAULTS);
  assert.equal(parseConfig(null).enabled, false);
});

test("parseConfig: enabled + bounded numbers", () => {
  const c = parseConfig({ enabled: true, timeoutMs: 5000, minChars: 10, maxChars: 2000 });
  assert.equal(c.enabled, true);
  assert.equal(c.timeoutMs, 5000);
  assert.equal(c.minChars, 10);
  assert.equal(c.maxChars, 2000);
});

test("parseConfig: out-of-range numbers fall back to defaults", () => {
  const c = parseConfig({ timeoutMs: 5, maxChars: -1, minChars: "lots" });
  assert.equal(c.timeoutMs, DEFAULTS.timeoutMs);
  assert.equal(c.maxChars, DEFAULTS.maxChars);
  assert.equal(c.minChars, DEFAULTS.minChars);
});

test("parseConfig: model accepts string, array, and null — chain normalized", () => {
  assert.deepEqual(parseConfig({ model: "omlx/qwen-3" }).models, ["omlx/qwen-3"]);
  assert.deepEqual(parseConfig({ model: ["omlx/qwen-3", "github-copilot/gpt-5.4-mini"] }).models, [
    "omlx/qwen-3",
    "github-copilot/gpt-5.4-mini",
  ]);
  assert.deepEqual(parseConfig({ model: null }).models, []);
  assert.deepEqual(parseConfig({ model: "no-slash" }).models, []);
  assert.deepEqual(parseConfig({ model: 42 }).models, []);
  // Malformed entries drop out of the chain; well-formed ones survive.
  assert.deepEqual(parseConfig({ model: ["bad/../../path", "omlx/ok", 7] }).models, ["omlx/ok"]);
});

test("parseConfig: model chain capped at MAX_MODEL_CHAIN", () => {
  const chain = ["a/1", "b/2", "c/3", "d/4", "e/5"];
  assert.deepEqual(parseConfig({ model: chain }).models, ["a/1", "b/2", "c/3"]);
});

test("parseConfig: malformed glob arrays fall back to defaults", () => {
  assert.deepEqual(parseConfig({ exclude: [] }).exclude, DEFAULT_EXCLUDE);
  assert.deepEqual(parseConfig({ exclude: [1, 2] }).exclude, DEFAULT_EXCLUDE);
  assert.deepEqual(parseConfig({ exclude: ["docs/**"] }).exclude, ["docs/**"]);
});

test("globToRegExp: ** spans directories, * stays in a segment", () => {
  assert.ok(globToRegExp("**/*.md").test("a/b/c.md"));
  assert.ok(globToRegExp("**/*.md").test("top.md")); // **/ matches empty
  assert.ok(!globToRegExp("*.md").test("a/b.md"));
  assert.ok(globToRegExp("adrs/**").test("adrs/0001-x.md"));
  assert.ok(!globToRegExp("adrs/**").test("docs/adrs.md"));
  assert.ok(globToRegExp("NEXT_SESSION*").test("NEXT_SESSION_ft2.md"));
  assert.ok(globToRegExp("file?.md").test("file1.md"));
  assert.ok(!globToRegExp("file?.md").test("file10.md"));
});

test("eligibility: .md under cwd, include-matched, not excluded", () => {
  const c = cfg();
  assert.ok(isEligiblePath("/repo/docs/guide.md", CWD, c));
  assert.ok(isEligiblePath("docs/guide.md", CWD, c));
  assert.ok(isEligiblePath("/repo/README.md", CWD, c));
});

test("eligibility: non-md, outside-cwd, and excluded paths are refused", () => {
  const c = cfg();
  assert.ok(!isEligiblePath("/repo/src/app.ts", CWD, c));
  assert.ok(!isEligiblePath("/elsewhere/notes.md", CWD, c));
  assert.ok(!isEligiblePath("/repo/../outside.md", CWD, c));
  assert.ok(!isEligiblePath("/repo/adrs/0142-x.md", CWD, c));
  assert.ok(!isEligiblePath("/repo/.review/finding.md", CWD, c));
  assert.ok(!isEligiblePath("/repo/agent/skills/docs-expert/SKILL.md", CWD, c));
  assert.ok(!isEligiblePath("/repo/NEXT_SESSION_backlog.md", CWD, c));
  // Bare basename exclude glob catches the file at depth too.
  assert.ok(!isEligiblePath("/repo/notes/NEXT_SESSION_old.md", CWD, c));
});

test("eligibility: custom include narrows the surface", () => {
  const c = cfg({ include: ["docs/**"] });
  assert.ok(isEligiblePath("/repo/docs/a.md", CWD, c));
  assert.ok(!isEligiblePath("/repo/README.md", CWD, c));
});
