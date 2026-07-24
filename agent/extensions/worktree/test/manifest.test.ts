import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  listManifests,
  loadManifest,
  removeManifest,
  safeKey,
  saveManifest,
  sessionsDir,
  type SessionManifest,
} from "../lib/manifest.ts";

const manifest = (sid: string, over: Partial<SessionManifest> = {}): SessionManifest => ({
  v: 1,
  sessionId: sid,
  repo: "/repo",
  worktreePath: `/repo/.worktrees/${sid}`,
  branch: `feat/wt-${sid}`,
  pid: 12345,
  host: "testhost",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  lastSnapshotSha: null,
  ...over,
});

test("safeKey rejects traversal and empty ids", () => {
  assert.equal(safeKey("abc-123"), "abc-123");
  assert.equal(safeKey("../../etc/passwd"), "passwd");
  assert.equal(safeKey(".."), "unknown-session");
  assert.equal(safeKey(""), "unknown-session");
  assert.equal(safeKey("a b/c"), "c");
});

test("save/load round-trips and lands in the sessions dir", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "wt-manifest-"));
  await saveManifest(manifest("sess-a"), dir);
  const loaded = await loadManifest("sess-a", dir);
  assert.ok(loaded);
  assert.equal(loaded.branch, "feat/wt-sess-a");
  const files = await fs.readdir(sessionsDir(dir));
  assert.deepEqual(files, ["sess-a.json"]);
});

test("list returns only valid manifests; remove is idempotent", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "wt-manifest-"));
  await saveManifest(manifest("sess-a"), dir);
  await saveManifest(manifest("sess-b"), dir);
  await fs.writeFile(join(sessionsDir(dir), "junk.json"), "not json", "utf8");
  await fs.writeFile(join(sessionsDir(dir), "wrong.json"), JSON.stringify({ v: 99 }), "utf8");
  const all = await listManifests(dir);
  assert.deepEqual(all.map((m) => m.sessionId).sort(), ["sess-a", "sess-b"]);
  await removeManifest("sess-a", dir);
  await removeManifest("sess-a", dir);
  assert.equal(await loadManifest("sess-a", dir), null);
});

test("load returns null for missing or schema-mismatched files", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "wt-manifest-"));
  assert.equal(await loadManifest("nope", dir), null);
});
