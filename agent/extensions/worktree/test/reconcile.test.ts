import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorktreeInfo } from "../lib/git.ts";
import type { SessionManifest } from "../lib/manifest.ts";
import { formatLockReason, orphans, parseLockReason, reconcile } from "../lib/reconcile.ts";

const wt = (path: string, lockReason: string | null, branch = "feat/x"): WorktreeInfo => ({
  path,
  head: "abc123",
  branch,
  lockReason,
});

const manifest = (sid: string, pid: number): SessionManifest => ({
  v: 1,
  sessionId: sid,
  repo: "/repo",
  worktreePath: `/repo/.worktrees/${sid}`,
  branch: `feat/wt-${sid}`,
  pid,
  host: "h",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  lastSnapshotSha: null,
});

test("lock reason round-trips through format/parse", () => {
  const reason = formatLockReason("sid-1", 4242, "myhost", "2026-07-22T01:02:03Z");
  const parsed = parseLockReason(reason);
  assert.equal(parsed.sid, "sid-1");
  assert.equal(parsed.pid, 4242);
  assert.equal(parsed.host, "myhost");
  assert.equal(parsed.started, "2026-07-22T01:02:03Z");
});

test("parseLockReason tolerates junk and partial reasons", () => {
  assert.deepEqual(parseLockReason("free text lock"), { sid: null, pid: null, host: null, started: null });
  assert.equal(parseLockReason("pid:-5 session:x").pid, null);
  assert.equal(parseLockReason("pid:abc session:x").pid, null);
});

test("reconcile merges lock, manifest, and wip signals per sid and excludes own", () => {
  const records = reconcile({
    worktrees: [
      wt("/repo", null), // primary checkout — ignored
      wt("/repo/.worktrees/dead", formatLockReason("dead", 99999999, "h", "t")),
      wt("/repo/.worktrees/live", formatLockReason("live", 1, "h", "t")),
      wt("/repo/.worktrees/own", formatLockReason("own", 1, "h", "t")),
      wt("/elsewhere/manual-wt", formatLockReason("manual", 1, "h", "t")), // outside root — ignored
    ],
    manifests: [manifest("dead", 99999999), manifest("gone", 88888888)],
    wipRefs: [
      { sid: "dead", sha: "d".repeat(40) },
      { sid: "gone", sha: "e".repeat(40) },
    ],
    worktreesRoot: "/repo/.worktrees",
    ownSid: "own",
    isAlive: (pid) => pid === 1,
  });
  const bySid = new Map(records.map((r) => [r.sid, r]));
  assert.deepEqual([...bySid.keys()].sort(), ["dead", "gone", "live"]);
  assert.equal(bySid.get("dead")?.alive, false);
  assert.equal(bySid.get("dead")?.wipSha, "d".repeat(40));
  assert.ok(bySid.get("dead")?.worktree);
  assert.ok(bySid.get("dead")?.manifest);
  assert.equal(bySid.get("live")?.alive, true);
  // Manifest+wip but no worktree directory — the reaped-dir crash case.
  assert.equal(bySid.get("gone")?.alive, false);
  assert.equal(bySid.get("gone")?.worktree, null);
});

test("orphans returns only dead-pid records", () => {
  const records = reconcile({
    worktrees: [
      wt("/repo/.worktrees/a", formatLockReason("a", 2, "h", "t")),
      wt("/repo/.worktrees/b", formatLockReason("b", 1, "h", "t")),
    ],
    manifests: [],
    wipRefs: [],
    worktreesRoot: "/repo/.worktrees",
    ownSid: "me",
    isAlive: (pid) => pid === 1,
  });
  assert.deepEqual(orphans(records).map((r) => r.sid), ["a"]);
});

test("a lockless worktree under the root falls back to dir-name sid and is orphaned", () => {
  const records = reconcile({
    worktrees: [wt("/repo/.worktrees/stray", null)],
    manifests: [],
    wipRefs: [],
    worktreesRoot: "/repo/.worktrees",
    ownSid: "me",
    isAlive: () => true,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].sid, "stray");
  assert.equal(records[0].alive, false); // no pid signal → orphan candidate
});
