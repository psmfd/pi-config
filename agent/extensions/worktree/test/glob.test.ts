import assert from "node:assert/strict";
import { test } from "node:test";

import { globToRegExp, matchesAny } from "../lib/glob.ts";

test("basename patterns (no slash) match at any depth", () => {
  assert.equal(matchesAny("NEXT_SESSION.md", ["NEXT_SESSION*.md"]), true);
  assert.equal(matchesAny("NEXT_SESSION_foo-bar.md", ["NEXT_SESSION*.md"]), true);
  assert.equal(matchesAny("docs/NEXT_SESSION.md", ["NEXT_SESSION*.md"]), true);
  assert.equal(matchesAny("NEXT_SESSIONx/other.md", ["NEXT_SESSION*.md"]), false);
  assert.equal(matchesAny("readme.md", ["NEXT_SESSION*.md"]), false);
});

test("path patterns (with slash) anchor to the repo-relative path", () => {
  assert.equal(matchesAny(".review/finding.json", [".review/**"]), true);
  assert.equal(matchesAny(".review/deep/nested/file.md", [".review/**"]), true);
  assert.equal(matchesAny("src/.review/file.md", [".review/**"]), false);
  assert.equal(matchesAny(".reviewx/file.md", [".review/**"]), false);
});

test("`*` and `?` do not cross separators; `**` does", () => {
  assert.equal(globToRegExp("a/*/c").test("a/b/c"), true);
  assert.equal(globToRegExp("a/*/c").test("a/b/x/c"), false);
  assert.equal(globToRegExp("a/**/c").test("a/b/x/c"), true);
  assert.equal(globToRegExp("a/**/c").test("a/c"), true);
  assert.equal(globToRegExp("a?c").test("abc"), true);
  assert.equal(globToRegExp("a?c").test("a/c"), false);
});

test("regex metacharacters in patterns are literal", () => {
  assert.equal(matchesAny("file.md", ["file.md"]), true);
  assert.equal(matchesAny("filexmd", ["file.md"]), false);
  assert.equal(matchesAny("a+b(c).md", ["a+b(c).md"]), true);
});

test("invalid and empty patterns are skipped without throwing", () => {
  assert.equal(matchesAny("x", ["", "x"]), true);
  assert.equal(matchesAny("y", [""]), false);
});
