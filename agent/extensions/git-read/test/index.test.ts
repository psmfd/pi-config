import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import gitRead, { buildGitArgs, runGitRead } from "../index.ts";

const MUTATIONS = new Set(["add", "commit", "push", "reset", "rebase", "merge", "cherry-pick", "switch", "checkout", "update-ref", "branch-delete", "tag-delete"]);

for (const operation of ["status", "log", "diff", "show", "branches", "tags", "remotes", "worktrees", "reflog"] as const) {
  test(`${operation} builds an allowlisted read-only command`, () => {
    const args = buildGitArgs({ operation, revision: operation === "show" ? "HEAD" : undefined });
    assert.equal(args.some((arg) => MUTATIONS.has(arg)), false);
    assert.equal(args.includes("--no-optional-locks"), true);
  });
}

test("rejects option, traversal, control, and shell-shaped inputs", () => {
  assert.throws(() => buildGitArgs({ operation: "show", revision: "--delete" }));
  assert.throws(() => buildGitArgs({ operation: "diff", path: "../secret" }));
  assert.throws(() => buildGitArgs({ operation: "diff", path: "x\nnext" }));
  assert.throws(() => buildGitArgs({ operation: "log", revision: "HEAD;touch" }));
});

test("diff and show disable configured external and textconv helpers", () => {
  for (const operation of ["diff", "show"] as const) {
    const args = buildGitArgs({ operation, revision: "HEAD" });
    assert.equal(args.includes("--no-ext-diff"), true);
    assert.equal(args.includes("--no-textconv"), true);
  }
});

test("path remains after an option terminator", () => {
  const args = buildGitArgs({ operation: "diff", revision: "HEAD~1..HEAD", path: "docs/file name.md" });
  const marker = args.indexOf("--");
  assert.ok(marker > 0);
  assert.equal(args[marker + 1], "docs/file name.md");
});

test("runner uses a credential-free environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-read-fake-"));
  const fake = join(dir, "git");
  await writeFile(fake, "#!/bin/sh\nprintf 'GH=%s SSH=%s ARGS=%s\\n' \"${GH_TOKEN-}\" \"${SSH_AUTH_SOCK-}\" \"$*\"\n", "utf8");
  await chmod(fake, 0o700);
  const result = await runGitRead(["status"], dir, undefined, {
    PATH: dir,
    HOME: dir,
    GH_TOKEN: "must-not-pass",
    SSH_AUTH_SOCK: "/tmp/must-not-pass",
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^GH= SSH=/);
});

test("registers git_read", () => {
  let name = "";
  gitRead({ registerTool(tool: { name: string }) { name = tool.name; } } as never);
  assert.equal(name, "git_read");
});

test("gitflow skill stays aligned with binding commit and merge policy", () => {
  const skill = readFileSync("agent/skills/gitflow-expert/SKILL.md", "utf8");
  assert.match(skill, /Ordinary topic PRs to `dev` use \*\*squash merge\*\*/);
  assert.match(skill, /Conventional Commit descriptions in pi_config start lowercase/);
  assert.doesNotMatch(skill, /Ordinary topic PRs to `dev` use the merge method\s+permitted/);
  assert.doesNotMatch(skill, /^3\. Capitalize the subject line$/m);
});
