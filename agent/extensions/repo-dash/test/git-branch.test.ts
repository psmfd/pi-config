import assert from "node:assert/strict";
import { test } from "node:test";

import { currentBranch, type GitRunner } from "../git-branch.ts";

/** Records the argv it was handed, so the constant-argv claim is testable. */
function runner(value: string | undefined): GitRunner & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const fn = (args: readonly string[]): Promise<string | undefined> => {
    calls.push(args);
    return Promise.resolve(value);
  };
  return Object.assign(fn, { calls });
}

test("currentBranch asks git exactly one constant question", async () => {
  // The whole safety argument for adding a subprocess to repo-dash is that
  // nothing is interpolated into this vector. Pin it.
  const run = runner("dev");
  await currentBranch(run);
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.calls[0], ["rev-parse", "--abbrev-ref", "HEAD"]);
});

test("currentBranch returns an ordinary branch name", async () => {
  assert.equal(await currentBranch(runner("dev")), "dev");
  assert.equal(await currentBranch(runner("feat/repo-dash-ci-widget")), "feat/repo-dash-ci-widget");
});

test("currentBranch treats a detached HEAD as unscopable", async () => {
  // `--abbrev-ref HEAD` prints the literal string HEAD when detached; passing
  // that through would scope the widget to a branch named "HEAD".
  assert.equal(await currentBranch(runner("HEAD")), undefined);
});

test("currentBranch is undefined when git fails or is absent", async () => {
  // Not a repository, git missing from PATH, timeout — the runner reports all
  // of them the same way, and the caller does the same thing in each case.
  assert.equal(await currentBranch(runner(undefined)), undefined);
});

test("currentBranch is undefined on empty output", async () => {
  assert.equal(await currentBranch(runner("")), undefined);
});

test("currentBranch screens names GitHub's ref grammar would reject", async () => {
  // validateRef THROWS on a bad ref, and a throw on the widget's load path
  // would show a permanently unavailable widget for a branch that is perfectly
  // legal in git. Screening here degrades to an unscoped widget instead.
  for (const bad of [
    "-dangerous",           // leading dash: could read as a git/gh option
    "feat/thing~1",         // tilde is not in the accepted grammar
    "feat/thing^",
    "has space",
    "has\ttab",
    "café",                 // non-ASCII is legal in git, rejected by REF_RE
    `${"b".repeat(201)}`,   // over the 200-character bound
  ]) {
    assert.equal(await currentBranch(runner(bad)), undefined, bad);
  }
});

test("currentBranch accepts names at the edge of the accepted grammar", async () => {
  for (const ok of [
    "a",
    "release/1.2.3",
    "fix/a-b_c.d",
    `b${"c".repeat(199)}`,  // exactly 200 characters
  ]) {
    assert.equal(await currentBranch(runner(ok)), ok, ok);
  }
});
