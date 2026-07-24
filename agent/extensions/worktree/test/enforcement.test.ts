import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyPath,
  denyReason,
  mapToWorktree,
  shellQuote,
  wrapBashCommand,
  type EnforcementContext,
} from "../lib/enforcement.ts";

const ec: EnforcementContext = {
  cwd: "/repo",
  repoRoot: "/repo",
  worktreePath: "/repo/.worktrees/sid1",
  exemptions: ["NEXT_SESSION*.md", ".review/**"],
};

test("classifyPath: worktree paths pass through", () => {
  assert.equal(classifyPath("/repo/.worktrees/sid1/src/a.ts", ec).cls, "worktree");
  assert.equal(classifyPath(".worktrees/sid1/src/a.ts", ec).cls, "worktree");
});

test("classifyPath: primary-checkout paths are primary (relative and absolute)", () => {
  assert.equal(classifyPath("src/a.ts", ec).cls, "primary");
  assert.equal(classifyPath("/repo/src/a.ts", ec).cls, "primary");
  assert.equal(classifyPath("/repo/src/a.ts", ec).rel, "src/a.ts");
});

test("classifyPath: another session's worktree is primary (denied), not mapped", () => {
  const c = classifyPath("/repo/.worktrees/other/src/a.ts", ec);
  assert.equal(c.cls, "primary");
  assert.equal(mapToWorktree(c.resolved, ec), null);
});

test("classifyPath: exemptions and outside paths", () => {
  assert.equal(classifyPath("NEXT_SESSION.md", ec).cls, "exempt");
  assert.equal(classifyPath(".review/handoff.json", ec).cls, "exempt");
  assert.equal(classifyPath("/etc/hosts", ec).cls, "outside");
  assert.equal(classifyPath("../elsewhere/x", ec).cls, "outside");
});

test("mapToWorktree maps repo-relative structure into the worktree", () => {
  const c = classifyPath("src/deep/a.ts", ec);
  assert.equal(mapToWorktree(c.resolved, ec), "/repo/.worktrees/sid1/src/deep/a.ts");
});

test("shellQuote survives embedded single quotes", () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
});

test("wrapBashCommand wraps in a cd + subshell, preserving multi-line commands", () => {
  const wrapped = wrapBashCommand("echo hi\nmake test", "/repo/.worktrees/sid1");
  assert.equal(wrapped, `cd '/repo/.worktrees/sid1' && (\necho hi\nmake test\n)`);
});

test("denyReason names the worktree and the mapped target", () => {
  const c = classifyPath("src/a.ts", ec);
  const reason = denyReason("write", c, ec);
  assert.match(reason, /\/repo\/\.worktrees\/sid1/);
  assert.match(reason, /Re-issue this write against: \/repo\/\.worktrees\/sid1\/src\/a\.ts/);
});
