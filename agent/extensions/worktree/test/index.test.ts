/**
 * End-to-end tests for index.ts: a stub ExtensionAPI drives the real event
 * handlers against a real throwaway git repo. HOME is redirected per
 * scenario so manifests and settings land in the sandbox, never in the
 * operator's ~/.pi (both config.ts and manifest.ts resolve via homedir()).
 */

import assert from "node:assert/strict";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import worktreeExtension from "../index.ts";
import { snapshotWip, systemGitRunner } from "../lib/git.ts";
import { saveManifest } from "../lib/manifest.ts";

const run = systemGitRunner();

const ENV_WORKTREE = "PI_SESSION_WORKTREE";
const ENV_SESSION = "PI_CONFINE_SESSION";
const TOUCHED_ENV = [ENV_WORKTREE, ENV_SESSION, "HOME", "PATH"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TOUCHED_ENV) savedEnv[key] = process.env[key];
  delete process.env[ENV_WORKTREE];
  delete process.env[ENV_SESSION];
});

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void {
    this.commands.set(name, options);
  }
  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const r = await handler(payload, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  }
}

interface Scenario {
  repo: string;
  home: string;
  pi: FakePi;
  ctx: ExtensionContext;
  notifications: string[];
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run(args, { cwd });
  assert.equal(r.code, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function scenario(sid: string, userSettings?: unknown): Promise<Scenario> {
  const root = await fs.mkdtemp(join(tmpdir(), "wt-e2e-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(repo, { recursive: true });
  process.env.HOME = home;
  if (userSettings !== undefined) {
    await fs.mkdir(join(home, ".pi", "agent"), { recursive: true });
    await fs.writeFile(join(home, ".pi", "agent", "settings.json"), JSON.stringify(userSettings), "utf8");
  }
  await git(repo, "init", "-b", "dev");
  await git(repo, "config", "user.name", "test");
  await git(repo, "config", "user.email", "test@localhost");
  await fs.writeFile(join(repo, "tracked.txt"), "v1\n", "utf8");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "initial");

  const notifications: string[] = [];
  const ctx = {
    cwd: repo,
    hasUI: true,
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      setStatus: () => undefined,
    },
    sessionManager: { getSessionId: () => sid },
    isProjectTrusted: () => false,
  } as unknown as ExtensionContext;

  const pi = new FakePi();
  worktreeExtension(pi as unknown as ExtensionAPI);
  return { repo, home, pi, ctx, notifications };
}

test("lazy trigger: first primary write creates + locks the worktree, then denies with redirect", async () => {
  const s = await scenario("sid-e2e");
  await s.pi.emit("session_start", { reason: "startup" }, s.ctx);

  const input = { path: "src/app.ts", content: "x" };
  const result = (await s.pi.emit("tool_call", { toolName: "write", input }, s.ctx)) as
    | { block: boolean; reason: string }
    | undefined;

  assert.ok(result?.block, "primary write must be blocked after activation");
  const wt = join(s.repo, ".worktrees", "sid-e2e");
  // git reports realpath'd toplevels, so mutation targets are canonical paths.
  const wtReal = join(await fs.realpath(s.repo), ".worktrees", "sid-e2e");
  // No `/`-escaping pass: `/` is not a metacharacter to the RegExp
  // CONSTRUCTOR (only to regex literals), so escaping it was a no-op that also
  // left the real metacharacters untouched — which is what CodeQL's
  // js/incomplete-sanitization flagged. The pattern below is byte-equivalent.
  assert.match(result.reason, new RegExp("Re-issue this write against: .*sid-e2e/src/app\\.ts"));
  assert.equal(existsSync(wt), true);

  const listed = await git(s.repo, "worktree", "list", "--porcelain");
  assert.match(listed, /locked session:sid-e2e pid:\d+/);
  assert.match(await git(wt, "rev-parse", "--abbrev-ref", "HEAD"), /^feat\/wt-sid-e2e/);

  // Worktree writes and exempt scratch writes pass through untouched.
  const inWt = await s.pi.emit("tool_call", { toolName: "write", input: { path: join(wt, "src/app.ts"), content: "x" } }, s.ctx);
  assert.equal(inWt, undefined);
  const exempt = await s.pi.emit("tool_call", { toolName: "write", input: { path: "NEXT_SESSION.md", content: "notes" } }, s.ctx);
  assert.equal(exempt, undefined);

  // Bash is steered via cd-wrap mutation.
  const bashInput = { command: "echo hi" };
  await s.pi.emit("tool_call", { toolName: "bash", input: bashInput }, s.ctx);
  assert.equal(bashInput.command, `cd '${wtReal}' && (\necho hi\n)`);

  // Reads of tracked files are rewritten into the worktree copy.
  const readInput = { path: "tracked.txt" };
  await s.pi.emit("tool_call", { toolName: "read", input: readInput }, s.ctx);
  assert.equal(readInput.path, join(wtReal, "tracked.txt"));

  // grep with no path defaults to the worktree.
  const grepInput: { pattern: string; path?: string } = { pattern: "x" };
  await s.pi.emit("tool_call", { toolName: "grep", input: grepInput }, s.ctx);
  assert.equal(grepInput.path, wtReal);

  // Subagent calls inherit the worktree cwd (single + steps modes).
  const subInput: Record<string, unknown> = { agent: "a", task: "t", steps: [{ agent: "b" }] };
  await s.pi.emit("tool_call", { toolName: "subagent", input: subInput }, s.ctx);
  assert.equal(subInput["cwd"], wtReal);
  assert.equal((subInput["steps"] as Array<Record<string, unknown>>)[0]["cwd"], wtReal);

  // Dirty turn_end snapshots to refs/pi-wip/<sid>; shutdown snapshots too.
  await fs.writeFile(join(wt, "wip.ts"), "export const wip = true;\n", "utf8");
  await s.pi.emit("turn_end", { turnIndex: 1 }, s.ctx);
  const refs = await git(s.repo, "for-each-ref", "--format=%(refname)", "refs/pi-wip");
  assert.equal(refs, "refs/pi-wip/sid-e2e");
  await s.pi.emit("session_shutdown", { reason: "quit" }, s.ctx);
});

test("shutdown and inactive replacement revoke the prior session worktree grant", async () => {
  const active = await scenario("sid-active");
  await active.pi.emit("session_start", { reason: "startup" }, active.ctx);
  await active.pi.emit(
    "tool_call",
    { toolName: "write", input: { path: "src/a.ts", content: "x" } },
    active.ctx,
  );
  assert.match(process.env[ENV_WORKTREE] ?? "", /sid-active$/);
  assert.equal(process.env[ENV_SESSION], "sid-active");

  await active.pi.emit("session_shutdown", { reason: "new" }, active.ctx);
  assert.equal(process.env[ENV_WORKTREE], undefined);
  assert.equal(process.env[ENV_SESSION], undefined);

  process.env[ENV_WORKTREE] = "/stale/session-a";
  process.env[ENV_SESSION] = "stale-session-a";
  const inactive = await scenario("sid-inactive", { extensionSettings: { worktree: { enabled: false } } });
  await inactive.pi.emit("session_start", { reason: "new" }, inactive.ctx);
  assert.equal(process.env[ENV_WORKTREE], undefined);
  assert.equal(process.env[ENV_SESSION], undefined);
});

test("successful worktree done revokes the worktree grant", async () => {
  const s = await scenario("sid-done");
  const fakeBin = join(s.home, "bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGh = join(fakeBin, "gh");
  await fs.writeFile(fakeGh, "#!/bin/sh\nprintf 'MERGED\\n'\n", "utf8");
  await fs.chmod(fakeGh, 0o755);
  process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;

  await s.pi.emit("session_start", { reason: "startup" }, s.ctx);
  await s.pi.emit(
    "tool_call",
    { toolName: "write", input: { path: "src/a.ts", content: "x" } },
    s.ctx,
  );
  assert.equal(process.env[ENV_SESSION], "sid-done");

  const command = s.pi.commands.get("worktree");
  assert.ok(command);
  await command.handler("done", s.ctx);
  assert.ok(s.notifications.some((message) => message.includes("done — reaped")));
  assert.equal(process.env[ENV_WORKTREE], undefined);
  assert.equal(process.env[ENV_SESSION], undefined);
});

test("non-repo stays inert; linked-worktree child publishes only its current grant", async () => {
  const s = await scenario("sid-x");
  const bare = await fs.mkdtemp(join(tmpdir(), "wt-norepo-"));
  const bareCtx = { ...(s.ctx as unknown as Record<string, unknown>), cwd: bare } as unknown as ExtensionContext;
  await s.pi.emit("session_start", { reason: "startup" }, bareCtx);
  const result = await s.pi.emit("tool_call", { toolName: "write", input: { path: "a.ts", content: "x" } }, bareCtx);
  assert.equal(result, undefined);
  assert.equal(existsSync(join(bare, ".worktrees")), false);
  assert.equal(process.env[ENV_WORKTREE], undefined);

  const linked = join(s.home, "linked-child");
  await git(s.repo, "worktree", "add", "-b", "feat/linked-child", linked, "HEAD");
  process.env[ENV_WORKTREE] = "/stale/parent-worktree";
  process.env[ENV_SESSION] = "stale-parent";
  const linkedCtx = {
    ...(s.ctx as unknown as Record<string, unknown>),
    cwd: linked,
    sessionManager: { getSessionId: () => "sid-child" },
  } as unknown as ExtensionContext;
  await s.pi.emit("session_start", { reason: "new" }, linkedCtx);
  assert.equal(process.env[ENV_WORKTREE], await fs.realpath(linked));
  assert.equal(process.env[ENV_SESSION], "sid-child");
  assert.equal(existsSync(join(linked, ".worktrees")), false);

  await s.pi.emit("session_shutdown", { reason: "quit" }, linkedCtx);
  assert.equal(process.env[ENV_WORKTREE], undefined);
  assert.equal(process.env[ENV_SESSION], undefined);
});

test("reportOnly observes without creating or mutating", async () => {
  const s = await scenario("sid-ro", { extensionSettings: { worktree: { reportOnly: true } } });
  await s.pi.emit("session_start", { reason: "startup" }, s.ctx);
  const result = await s.pi.emit("tool_call", { toolName: "write", input: { path: "src/a.ts", content: "x" } }, s.ctx);
  assert.equal(result, undefined);
  assert.equal(existsSync(join(s.repo, ".worktrees")), false);
  assert.ok(s.notifications.some((n) => n.includes("report-only")));
});

test("enabled:false disarms entirely", async () => {
  const s = await scenario("sid-off", { extensionSettings: { worktree: { enabled: false } } });
  await s.pi.emit("session_start", { reason: "startup" }, s.ctx);
  const result = await s.pi.emit("tool_call", { toolName: "write", input: { path: "src/a.ts", content: "x" } }, s.ctx);
  assert.equal(result, undefined);
  assert.equal(existsSync(join(s.repo, ".worktrees")), false);
});

test("session restart re-attaches its own worktree; orphans are surfaced not adopted", async () => {
  const s = await scenario("sid-owner");
  await s.pi.emit("session_start", { reason: "startup" }, s.ctx);
  await s.pi.emit("tool_call", { toolName: "write", input: { path: "src/a.ts", content: "x" } }, s.ctx);
  const wt = join(s.repo, ".worktrees", "sid-owner");
  await fs.writeFile(join(wt, "wip.ts"), "1\n", "utf8");
  await s.pi.emit("session_shutdown", { reason: "quit" }, s.ctx);

  // Same sid restarts (fresh extension instance, same HOME): re-attach.
  const pi2 = new FakePi();
  worktreeExtension(pi2 as unknown as ExtensionAPI);
  s.notifications.length = 0;
  await pi2.emit("session_start", { reason: "resume" }, s.ctx);
  assert.ok(s.notifications.some((n) => n.includes("re-attached")));
  const bash = { command: "pwd" };
  await pi2.emit("tool_call", { toolName: "bash", input: bash }, s.ctx);
  assert.match(bash.command, /^cd '/);

  // A different sid in the same repo sees the (dead-pid-free) record as live
  // — its pid is this test process, which is alive — so no orphan warning.
  const pi3 = new FakePi();
  worktreeExtension(pi3 as unknown as ExtensionAPI);
  const ctx3 = {
    ...(s.ctx as unknown as Record<string, unknown>),
    sessionManager: { getSessionId: () => "sid-other" },
  } as unknown as ExtensionContext;
  s.notifications.length = 0;
  await pi3.emit("session_start", { reason: "startup" }, ctx3);
  assert.equal(s.notifications.some((n) => n.includes("orphaned")), false);
});

test("reads reflect worktree-side deletions; primary-only scratch keeps its path", async () => {
  const s = await scenario("sid-del");
  await s.pi.emit("session_start", { reason: "startup" }, s.ctx);
  await s.pi.emit("tool_call", { toolName: "write", input: { path: "src/a.ts", content: "x" } }, s.ctx);
  const wtReal = join(await fs.realpath(s.repo), ".worktrees", "sid-del");

  // Session deletes a tracked file in ITS worktree; the primary copy remains.
  await fs.rm(join(wtReal, "tracked.txt"));
  const readDeleted = { path: "tracked.txt" };
  await s.pi.emit("tool_call", { toolName: "read", input: readDeleted }, s.ctx);
  assert.equal(readDeleted.path, join(wtReal, "tracked.txt"), "must see the deletion, not the stale primary copy");

  // Untracked primary-only scratch the worktree never had keeps its path.
  await fs.writeFile(join(s.repo, "scratch.txt"), "primary-only\n", "utf8");
  const readScratch = { path: "scratch.txt" };
  await s.pi.emit("tool_call", { toolName: "read", input: readScratch }, s.ctx);
  assert.equal(readScratch.path, "scratch.txt");
  await s.pi.emit("session_shutdown", { reason: "quit" }, s.ctx);
});

test("/worktree resume adopts a dead-pid orphan (dir present) and recreates a reaped one (dir gone)", async () => {
  const s = await scenario("sid-rescuer");
  const repoReal = await fs.realpath(s.repo);

  // Forge a crashed session: worktree + dead-pid lock + WIP snapshot + manifest.
  const lostWt = join(repoReal, ".worktrees", "lost");
  await git(s.repo, "worktree", "add", "-b", "feat/wt-lost", lostWt, "HEAD");
  await fs.writeFile(join(lostWt, "recovered.ts"), "export const saved = true;\n", "utf8");
  const sha = await snapshotWip(run, lostWt, "lost");
  assert.ok(sha);
  await git(s.repo, "worktree", "lock", "--reason", "session:lost pid:99999999 host:h started:t", lostWt);
  await saveManifest({
    v: 1,
    sessionId: "lost",
    repo: repoReal,
    worktreePath: lostWt,
    branch: "feat/wt-lost",
    pid: 99999999,
    host: "h",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    lastSnapshotSha: sha,
  });

  await s.pi.emit("session_start", { reason: "startup" }, s.ctx);
  assert.ok(s.notifications.some((n) => n.includes("orphaned")), "reconciler must surface the orphan");

  // Dir-present adoption: dead-pid lock is cleared and re-taken by this session.
  const cmd = s.pi.commands.get("worktree");
  assert.ok(cmd);
  s.notifications.length = 0;
  await cmd.handler("resume lost", s.ctx);
  assert.ok(s.notifications.some((n) => n.includes("resumed 'lost'")), s.notifications.join("|"));
  const listed = await git(s.repo, "worktree", "list", "--porcelain");
  assert.match(listed, /locked session:sid-rescuer pid:\d+/);
  await s.pi.emit("session_shutdown", { reason: "quit" }, s.ctx);

  // Dir-gone recreation: forge a second orphan whose directory was reaped
  // while still LOCKED (prune refuses locked entries without the unlock-first fix).
  const goneWt = join(repoReal, ".worktrees", "gone");
  await git(s.repo, "worktree", "add", "-b", "feat/wt-gone", goneWt, "HEAD");
  await fs.writeFile(join(goneWt, "wip-gone.ts"), "export const g = 1;\n", "utf8");
  const goneSha = await snapshotWip(run, goneWt, "gone");
  assert.ok(goneSha);
  await git(s.repo, "worktree", "lock", "--reason", "session:gone pid:99999999 host:h started:t", goneWt);
  await fs.rm(goneWt, { recursive: true, force: true });
  await saveManifest({
    v: 1,
    sessionId: "gone",
    repo: repoReal,
    worktreePath: goneWt,
    branch: "feat/wt-gone",
    pid: 99999999,
    host: "h",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    lastSnapshotSha: goneSha,
  });

  const pi2 = new FakePi();
  worktreeExtension(pi2 as unknown as ExtensionAPI);
  const ctx2 = {
    ...(s.ctx as unknown as Record<string, unknown>),
    sessionManager: { getSessionId: () => "sid-rescuer2" },
  } as unknown as ExtensionContext;
  await pi2.emit("session_start", { reason: "startup" }, ctx2);
  s.notifications.length = 0;
  const cmd2 = pi2.commands.get("worktree");
  assert.ok(cmd2);
  await cmd2.handler("resume gone", ctx2);
  assert.ok(s.notifications.some((n) => n.includes("resumed 'gone'")), s.notifications.join("|"));
  assert.equal(
    await fs.readFile(join(repoReal, ".worktrees", "gone", "wip-gone.ts"), "utf8"),
    "export const g = 1;\n",
    "WIP snapshot must be restored into the recreated worktree",
  );
  await pi2.emit("session_shutdown", { reason: "quit" }, ctx2);
});

test("/worktree resume refuses a live-pid session", async () => {
  const s = await scenario("sid-refuser");
  const repoReal = await fs.realpath(s.repo);
  const liveWt = join(repoReal, ".worktrees", "livesid");
  await git(s.repo, "worktree", "add", "-b", "feat/wt-livesid", liveWt, "HEAD");
  await git(s.repo, "worktree", "lock", "--reason", `session:livesid pid:${process.pid} host:h started:t`, liveWt);
  await s.pi.emit("session_start", { reason: "startup" }, s.ctx);
  const cmd = s.pi.commands.get("worktree");
  assert.ok(cmd);
  s.notifications.length = 0;
  await cmd.handler("resume livesid", s.ctx);
  assert.ok(s.notifications.some((n) => n.includes("still live")), s.notifications.join("|"));
});

test("/worktree status reports active and foreign sessions", async () => {
  const s = await scenario("sid-status");
  await s.pi.emit("session_start", { reason: "startup" }, s.ctx);
  await s.pi.emit("tool_call", { toolName: "write", input: { path: "src/a.ts", content: "x" } }, s.ctx);
  s.notifications.length = 0;
  const cmd = s.pi.commands.get("worktree");
  assert.ok(cmd);
  await cmd.handler("status", s.ctx);
  const status = s.notifications.join("\n");
  assert.match(status, /active: .*sid-status/);
  await s.pi.emit("session_shutdown", { reason: "quit" }, s.ctx);
});
