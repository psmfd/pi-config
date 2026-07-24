/**
 * Integration tests for lib/git.ts against real throwaway repositories.
 * Everything runs in mkdtemp dirs; no network (resolveBaseRef's fetch
 * attempts fail fast and fall through by design).
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  addWorktree,
  addWorktreeForBranch,
  deleteWipRef,
  ensureExcluded,
  gitCommonDir,
  isDirty,
  isLinkedWorktree,
  listWipRefs,
  listWorktrees,
  lockWorktree,
  removeWorktree,
  repoToplevel,
  resolveBaseRef,
  restoreSnapshot,
  safeSid,
  snapshotWip,
  systemGitRunner,
  unlockWorktree,
  wipRef,
  type GitRunner,
} from "../lib/git.ts";

const run: GitRunner = systemGitRunner();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run(args, { cwd });
  assert.equal(r.code, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "wt-git-"));
  await git(root, "init", "-b", "dev");
  await git(root, "config", "user.name", "test");
  await git(root, "config", "user.email", "test@localhost");
  await fs.writeFile(join(root, "tracked.txt"), "v1\n", "utf8");
  await fs.writeFile(join(root, "doomed.txt"), "delete me\n", "utf8");
  await fs.writeFile(join(root, ".gitignore"), "ignored.log\n", "utf8");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "initial");
  return root;
}

test("safeSid/wipRef sanitize hostile ids", () => {
  assert.equal(safeSid("abc 123/../x"), "abc-123-..-x");
  assert.equal(wipRef("s1"), "refs/pi-wip/s1");
  assert.equal(safeSid(""), "unknown-session");
});

test("toplevel / commonDir / linked-worktree detection", async () => {
  const repo = await makeRepo();
  const top = await repoToplevel(run, repo);
  assert.ok(top);
  assert.equal(await fs.realpath(top), await fs.realpath(repo));
  assert.equal(await isLinkedWorktree(run, repo), false);
  const common = await gitCommonDir(run, repo);
  assert.ok(common !== null && common.endsWith(".git"));
  const wt = join(repo, ".worktrees", "s1");
  await addWorktree(run, repo, wt, "feat/wt-s1", "HEAD");
  assert.equal(await isLinkedWorktree(run, wt), true);
  assert.equal(await isLinkedWorktree(run, repo), false);
});

test("ensureExcluded is idempotent and excludes .worktrees", async () => {
  const repo = await makeRepo();
  const common = await gitCommonDir(run, repo);
  assert.ok(common);
  await ensureExcluded(common);
  await ensureExcluded(common);
  const content = await fs.readFile(join(common, "info", "exclude"), "utf8");
  assert.equal(content.split("\n").filter((l) => l.trim() === "/.worktrees/").length, 1);
  const wt = join(repo, ".worktrees", "s1");
  await addWorktree(run, repo, wt, "feat/wt-s1", "HEAD");
  const status = await git(repo, "status", "--porcelain");
  assert.equal(status.includes(".worktrees"), false);
});

test("resolveBaseRef: explicit wins; no origin falls back to HEAD", async () => {
  const repo = await makeRepo();
  assert.equal(await resolveBaseRef(run, repo, null), "HEAD");
  assert.equal(await resolveBaseRef(run, repo, "dev"), "dev");
  assert.equal(await resolveBaseRef(run, repo, "does-not-exist"), null);
});

test("resolveBaseRef: falls through to origin/main when upstream has no dev, fetching it fresh", async () => {
  const upstream = await makeRepo();
  await git(upstream, "branch", "-m", "dev", "main"); // upstream has main only
  const root = await fs.mkdtemp(join(tmpdir(), "wt-clone-"));
  const clone = join(root, "clone");
  await git(root, "clone", "--quiet", upstream, clone);
  // Advance upstream AFTER the clone; per-candidate fetch must pick it up.
  await fs.writeFile(join(upstream, "tracked.txt"), "v2\n", "utf8");
  await git(upstream, "commit", "-am", "advance");
  const tip = await git(upstream, "rev-parse", "HEAD");
  assert.equal(await resolveBaseRef(run, clone, null), "origin/main");
  assert.equal(await git(clone, "rev-parse", "origin/main"), tip);
});

test("lock/list/unlock lifecycle with parseable reasons", async () => {
  const repo = await makeRepo();
  const wt = join(repo, ".worktrees", "s1");
  await addWorktree(run, repo, wt, "feat/wt-s1", "HEAD");
  await lockWorktree(run, repo, wt, "session:s1 pid:123 host:h started:now");
  const listed = await listWorktrees(run, repo);
  assert.equal(listed.length, 2);
  const entry = listed.find((w) => w.path.endsWith("s1"));
  assert.ok(entry);
  assert.equal(entry.branch, "feat/wt-s1");
  assert.equal(entry.lockReason, "session:s1 pid:123 host:h started:now");
  assert.equal(listed[0].lockReason, null); // primary is never locked
  assert.equal(await unlockWorktree(run, repo, wt), true);
  await removeWorktree(run, repo, wt);
  assert.equal((await listWorktrees(run, repo)).length, 1);
});

test("git refuses the same branch in two worktrees (natural mutex)", async () => {
  const repo = await makeRepo();
  await addWorktree(run, repo, join(repo, ".worktrees", "a"), "feat/wt-a", "HEAD");
  await assert.rejects(
    addWorktreeForBranch(run, repo, join(repo, ".worktrees", "b"), "feat/wt-a"),
    /already/,
  );
});

test("snapshotWip captures tracked edits, untracked files, and deletions — without touching the real index", async () => {
  const repo = await makeRepo();
  const wt = join(repo, ".worktrees", "s1");
  await addWorktree(run, repo, wt, "feat/wt-s1", "HEAD");

  assert.equal(await isDirty(run, wt), false);
  assert.equal(await snapshotWip(run, wt, "s1"), null); // clean tree → no snapshot

  await fs.writeFile(join(wt, "tracked.txt"), "v2\n", "utf8");
  await fs.writeFile(join(wt, "brand-new.ts"), "export const x = 1;\n", "utf8");
  await fs.writeFile(join(wt, "ignored.log"), "noise\n", "utf8");
  await fs.rm(join(wt, "doomed.txt"));
  assert.equal(await isDirty(run, wt), true);

  const sha = await snapshotWip(run, wt, "s1");
  assert.ok(sha);

  // Snapshot content: modified + untracked in, deleted + gitignored out.
  assert.equal(await git(wt, "show", `${sha}:tracked.txt`), "v2");
  assert.equal(await git(wt, "show", `${sha}:brand-new.ts`), "export const x = 1;");
  const lsTree = await git(wt, "ls-tree", "-r", "--name-only", sha);
  assert.equal(lsTree.includes("doomed.txt"), false);
  assert.equal(lsTree.includes("ignored.log"), false);

  // Real index untouched: nothing staged, untracked stays untracked.
  const status = await git(wt, "status", "--porcelain");
  assert.match(status, /\?\? brand-new\.ts/);
  assert.match(status, / M tracked\.txt/);

  // Ref pinned with reflog; idempotent on unchanged tree (no churn).
  const refs = await listWipRefs(run, repo);
  assert.deepEqual(refs, [{ sid: "s1", sha }]);
  assert.equal(await snapshotWip(run, wt, "s1"), sha);

  // Snapshot survives worktree destruction (shared object store).
  await removeWorktree(run, repo, wt, true);
  assert.equal(await git(repo, "show", `${sha}:brand-new.ts`), "export const x = 1;");

  await deleteWipRef(run, repo, "s1");
  assert.deepEqual(await listWipRefs(run, repo), []);
});

test("restoreSnapshot reproduces pre-crash state in a fresh worktree", async () => {
  const repo = await makeRepo();
  const wt = join(repo, ".worktrees", "s1");
  await addWorktree(run, repo, wt, "feat/wt-s1", "HEAD");
  await fs.writeFile(join(wt, "tracked.txt"), "v2\n", "utf8");
  await fs.writeFile(join(wt, "brand-new.ts"), "export const x = 1;\n", "utf8");
  await fs.rm(join(wt, "doomed.txt"));
  const sha = await snapshotWip(run, wt, "s1");
  assert.ok(sha);

  // Simulate crash + reap of the directory.
  await removeWorktree(run, repo, wt, true);

  const wt2 = join(repo, ".worktrees", "s1-recovered");
  await addWorktreeForBranch(run, repo, wt2, "feat/wt-s1");
  await restoreSnapshot(run, wt2, sha);

  assert.equal(await fs.readFile(join(wt2, "tracked.txt"), "utf8"), "v2\n");
  assert.equal(await fs.readFile(join(wt2, "brand-new.ts"), "utf8"), "export const x = 1;\n");
  await assert.rejects(fs.access(join(wt2, "doomed.txt")));
  // Recovered state shows as uncommitted changes (git restore --no-overlay
  // records removals in the index too, so the deletion may appear staged).
  const status = await git(wt2, "status", "--porcelain");
  assert.match(status, / M tracked\.txt/);
  assert.match(status, /(^|\n).?D\s+doomed\.txt/);
});
