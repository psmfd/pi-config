// PI-EXTENSION-CAPABILITY: no-registerTool
// Gated by validate.sh 6b-quinquies (ADR-0139): the declaration and the code must agree.

/**
 * worktree — pi extension (ADR-0120, #859)
 *
 * Per-session git worktree isolation with crash-durable WIP snapshots, so
 * multiple concurrent pi orchestrator sessions can work the same repository
 * without write collisions, and sudden session death (crash, SIGKILL, power
 * loss) loses at most one turn / one timer interval of work.
 *
 * Mechanism (pi cannot change a session's cwd, so the session STAYS in the
 * primary checkout and its MUTATIONS are steered):
 *   - Lazy trigger: the first `write`/`edit` targeting the repo creates
 *     `<repo>/.worktrees/<sid>/` on a fresh branch off the integration base,
 *     locked via `git worktree lock` with a `session:<sid> pid:<pid>` reason
 *     string (the liveness record the reconciler checks).
 *   - Enforcement: primary-checkout `write`/`edit` → deny + redirect reason
 *     (guard house style, exemption globs for scratch/handoff files);
 *     read-like tools → path rewritten into the worktree (stale-read
 *     prevention); `bash` → wrapped `cd <wt> && ( … )`; `subagent` calls get
 *     `cwd` defaulted to the worktree (children then disarm — a linked
 *     worktree is never re-isolated).
 *   - Durability: temp-index commit snapshots to `refs/pi-wip/<sid>` on
 *     dirty turn_end + a timer fallback (lib/git.ts § snapshotWip).
 *   - Recovery: session_start reconciler surfaces dead-pid orphans; adoption
 *     is manual via /worktree resume (never automatic for foreign sids).
 *
 * Failure posture: FAIL-OPEN with a visible warning. This is collision
 * isolation for cooperating sessions, not a security boundary — a broken
 * git environment must not brick the session (the guard trio still gates
 * every call). Override: PI_SKIP_WORKTREE=1, or
 * extensionSettings.worktree.enabled=false.
 *
 * Bash-only mutation workflows do not trigger creation (v1 accepted gap,
 * #861). Absolute paths inside bash strings escape the cd-wrap (accepted,
 * same class as bash-destructive-guard residual gaps).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_SETTINGS, loadSettings, type WorktreeSettings } from "./lib/config.ts";
import {
  classifyPath,
  denyReason,
  mapToWorktree,
  wrapBashCommand,
  type EnforcementContext,
} from "./lib/enforcement.ts";
import {
  addWorktreeForBranch,
  addWorktree,
  deleteBranch,
  deleteWipRef,
  ensureExcluded,
  existsInHead,
  gitCommonDir,
  isDirty,
  isLinkedWorktree,
  listWipRefs,
  listWorktrees,
  lockWorktree,
  refExists,
  removeWorktree,
  renameBranch,
  repoToplevel,
  resolveBaseRef,
  restoreSnapshot,
  safeSid,
  snapshotWip,
  systemGitRunner,
  unlockWorktree,
  wipRef,
} from "./lib/git.ts";
import { listManifests, loadManifest, removeManifest, saveManifest } from "./lib/manifest.ts";
import {
  formatLockReason,
  orphans,
  parseLockReason,
  reconcile,
  type SessionRecord,
} from "./lib/reconcile.ts";

const SKIP_ENV = "PI_SKIP_WORKTREE";
const STATUS_KEY = "worktree";
const BRANCH_RE = /^(feat|fix|docs|chore|refactor|test|ci|style)\/[a-z0-9][a-z0-9-]*$/;

interface SessionState {
  armed: boolean;
  settings: WorktreeSettings;
  repoRoot: string | null;
  cwdReal: string | null;
  commonDir: string | null;
  sid: string;
  active: boolean;
  worktreePath: string | null;
  branch: string | null;
  creating: Promise<boolean> | null;
  disabledReason: string | null;
  timer: ReturnType<typeof setInterval> | null;
  snapshotting: boolean;
  reportedOnce: Set<string>;
}

function freshState(): SessionState {
  return {
    armed: false,
    settings: { ...DEFAULT_SETTINGS, writeExemptions: [], linkFiles: [] },
    repoRoot: null,
    cwdReal: null,
    commonDir: null,
    sid: "unknown-session",
    active: false,
    worktreePath: null,
    branch: null,
    creating: null,
    disabledReason: null,
    timer: null,
    snapshotting: false,
    reportedOnce: new Set(),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function notifyOnce(st: SessionState, ctx: ExtensionContext, key: string, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (st.reportedOnce.has(key)) return;
  st.reportedOnce.add(key);
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

/** `gh pr view <branch> --json state` → "MERGED" | "OPEN" | ... | "unknown". */
function prState(repo: string, branch: string): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(
      "gh",
      ["pr", "view", branch, "--json", "state", "--jq", ".state"],
      { cwd: repo, timeout: 30_000 },
      (error, stdout) => {
        resolvePromise(error ? "unknown" : String(stdout).trim() || "unknown");
      },
    );
  });
}

/** Run a trusted project's postCreate command in the fresh worktree. */
function runPostCreate(command: string, worktree: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd: worktree, timeout: 120_000, env: { ...process.env, PI_WORKTREE: worktree } },
      (error, _stdout, stderr) => {
        resolvePromise({ ok: !error, detail: error ? String(stderr).trim().slice(0, 400) : "" });
      },
    );
  });
}

export default function (pi: ExtensionAPI) {
  if (process.env[SKIP_ENV] === "1") return;

  const run = systemGitRunner();
  let st = freshState();

  const enforcementCtx = (ctx: ExtensionContext): EnforcementContext | null => {
    if (!st.active || st.repoRoot === null || st.worktreePath === null) return null;
    return {
      cwd: ctx.cwd,
      cwdReal: st.cwdReal ?? ctx.cwd,
      repoRoot: st.repoRoot,
      worktreePath: st.worktreePath,
      exemptions: st.settings.writeExemptions,
    };
  };

  const stopTimer = (): void => {
    if (st.timer !== null) {
      clearInterval(st.timer);
      st.timer = null;
    }
  };

  const snapshotNow = async (ctx: ExtensionContext): Promise<string | null> => {
    if (!st.active || st.worktreePath === null || st.snapshotting) return null;
    st.snapshotting = true;
    try {
      if (!(await isDirty(run, st.worktreePath))) return null;
      const sha = await snapshotWip(run, st.worktreePath, st.sid);
      if (sha !== null) {
        const manifest = await loadManifest(st.sid);
        if (manifest) {
          await saveManifest({
            ...manifest,
            lastSnapshotSha: sha,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return sha;
    } catch (err) {
      notifyOnce(st, ctx, "snapshot-error", `worktree: WIP snapshot failed — ${String(err)}`, "warning");
      return null;
    } finally {
      st.snapshotting = false;
    }
  };

  const startTimer = (ctx: ExtensionContext): void => {
    stopTimer();
    const timer = setInterval(() => {
      void snapshotNow(ctx);
    }, st.settings.snapshotIntervalMs);
    // Never hold the process open for the snapshot fallback.
    if (typeof timer.unref === "function") timer.unref();
    st.timer = timer;
  };

  const activate = (ctx: ExtensionContext, worktreePath: string, branch: string): void => {
    st.active = true;
    st.worktreePath = worktreePath;
    st.branch = branch;
    // Publish the write grant for the Phase 2a bash-confinement wrapper
    // (ADR-0146, #1046): this is the first point the session's worktree path
    // is known, on both the fresh-create and re-attach paths. The wrapper
    // reads PI_SESSION_WORKTREE from its inherited env; PI_CONFINE_SESSION
    // keys the per-session scratch. Bash calls that precede the first
    // worktree still find no grant — which is correct (the wrapper fails
    // closed under enforce mode until a worktree exists).
    process.env.PI_SESSION_WORKTREE = worktreePath;
    process.env.PI_CONFINE_SESSION = safeSid(st.sid);
    startTimer(ctx);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `⌂ ${branch}`);
  };

  const hydrate = async (ctx: ExtensionContext, worktreePath: string): Promise<void> => {
    if (st.repoRoot === null) return;
    for (const rel of st.settings.linkFiles) {
      const source = join(st.repoRoot, rel);
      const target = join(worktreePath, rel);
      try {
        if (!existsSync(source) || existsSync(target)) continue;
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.symlink(source, target);
      } catch (err) {
        notifyOnce(st, ctx, `link-${rel}`, `worktree: linkFiles '${rel}' failed — ${String(err)}`, "warning");
      }
    }
    if (st.settings.postCreate !== null) {
      const result = await runPostCreate(st.settings.postCreate, worktreePath);
      if (!result.ok) {
        notifyOnce(st, ctx, "postcreate", `worktree: postCreate failed — ${result.detail}`, "warning");
      }
    }
  };

  const createWorktree = async (ctx: ExtensionContext): Promise<boolean> => {
    if (st.repoRoot === null || st.commonDir === null) return false;
    try {
      await ensureExcluded(st.commonDir);
      const baseRef = await resolveBaseRef(run, st.repoRoot, st.settings.baseRef);
      if (baseRef === null) throw new Error("no usable base ref (origin/dev, origin/main, HEAD)");
      const key = safeSid(st.sid);
      const worktreePath = join(st.repoRoot, ".worktrees", key);
      const baseBranch = `feat/wt-${key.slice(0, 12).toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
      let branch = baseBranch;
      let suffix = 1;
      while (await refExists(run, st.repoRoot, `refs/heads/${branch}`)) {
        suffix += 1;
        branch = `${baseBranch}-${suffix}`;
      }
      await addWorktree(run, st.repoRoot, worktreePath, branch, baseRef);
      await lockWorktree(
        run,
        st.repoRoot,
        worktreePath,
        formatLockReason(st.sid, process.pid, hostname(), new Date().toISOString()),
      );
      await hydrate(ctx, worktreePath);
      const now = new Date().toISOString();
      await saveManifest({
        v: 1,
        sessionId: st.sid,
        repo: st.repoRoot,
        worktreePath,
        branch,
        pid: process.pid,
        host: hostname(),
        createdAt: now,
        updatedAt: now,
        lastSnapshotSha: null,
      });
      activate(ctx, worktreePath, branch);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `worktree: session isolated in ${worktreePath} (branch ${branch}, base ${baseRef}). ` +
            `Code work happens there; WIP snapshots go to ${wipRef(st.sid)}.`,
          "info",
        );
      }
      return true;
    } catch (err) {
      st.disabledReason = String(err);
      notifyOnce(
        st,
        ctx,
        "create-failed",
        `worktree: creation failed (${String(err)}) — session continues UNISOLATED in the primary checkout.`,
        "warning",
      );
      return false;
    }
  };

  const ensureWorktree = (ctx: ExtensionContext): Promise<boolean> => {
    if (st.active) return Promise.resolve(true);
    if (st.creating === null) {
      st.creating = createWorktree(ctx).finally(() => {
        st.creating = null;
      });
    }
    return st.creating;
  };

  const adopt = async (ctx: ExtensionContext, record: SessionRecord): Promise<string> => {
    if (st.repoRoot === null) return "worktree: not armed in this session";
    if (st.active) return "worktree: this session already has an active worktree";
    const sid = record.sid;
    const branch = record.manifest?.branch ?? record.worktree?.branch ?? null;
    if (branch === null) return `worktree: cannot resume '${sid}' — no branch recorded`;
    let worktreePath = record.worktree?.path ?? record.manifest?.worktreePath ?? null;
    const ourReason = (): string =>
      formatLockReason(st.sid, process.pid, hostname(), new Date().toISOString());
    try {
      if (worktreePath === null || !existsSync(worktreePath)) {
        // Directory gone (reaped/ephemeral disk). `worktree prune` refuses to
        // clear a LOCKED stale entry, so best-effort unlock first — this is
        // exactly the crash-recovery path where the lock was never released.
        if (worktreePath !== null) await unlockWorktree(run, st.repoRoot, worktreePath);
        await run(["worktree", "prune"], { cwd: st.repoRoot });
        worktreePath = join(st.repoRoot, ".worktrees", safeSid(sid));
        // Natural mutex: a concurrent resume of the same sid loses here —
        // git refuses to check the branch out in a second worktree.
        await addWorktreeForBranch(run, st.repoRoot, worktreePath, branch);
        if (record.wipSha !== null) await restoreSnapshot(run, worktreePath, record.wipSha);
        await lockWorktree(run, st.repoRoot, worktreePath, ourReason());
      } else {
        // Directory present: the lock itself is the adoption mutex. Take it
        // directly; only if that fails, re-verify the CURRENT holder is dead
        // (not the stale record from before the command ran), clear it, and
        // race for the lock — the loser's second attempt fails and aborts.
        try {
          await lockWorktree(run, st.repoRoot, worktreePath, ourReason());
        } catch {
          const current = (await listWorktrees(run, st.repoRoot)).find((w) => w.path === worktreePath);
          const holder = current?.lockReason != null ? parseLockReason(current.lockReason) : null;
          if (holder?.pid != null && pidAlive(holder.pid)) {
            return `worktree: resume aborted — '${sid}' was claimed by a live session (pid ${holder.pid})`;
          }
          await unlockWorktree(run, st.repoRoot, worktreePath);
          try {
            await lockWorktree(run, st.repoRoot, worktreePath, ourReason());
          } catch {
            return `worktree: resume aborted — another session claimed '${sid}' concurrently`;
          }
        }
      }
      // The adopted worktree now belongs to THIS session id.
      const now = new Date().toISOString();
      await saveManifest({
        v: 1,
        sessionId: st.sid,
        repo: st.repoRoot,
        worktreePath,
        branch,
        pid: process.pid,
        host: hostname(),
        createdAt: record.manifest?.createdAt ?? now,
        updatedAt: now,
        lastSnapshotSha: record.wipSha,
      });
      if (sid !== st.sid) await removeManifest(sid);
      activate(ctx, worktreePath, branch);
      return `worktree: resumed '${sid}' → ${worktreePath} (branch ${branch})`;
    } catch (err) {
      return `worktree: resume failed — ${String(err)}`;
    }
  };

  const gatherRecords = async (): Promise<SessionRecord[]> => {
    if (st.repoRoot === null) return [];
    const [worktrees, manifests, wipRefs] = await Promise.all([
      listWorktrees(run, st.repoRoot),
      listManifests(),
      listWipRefs(run, st.repoRoot),
    ]);
    return reconcile({
      worktrees,
      manifests: manifests.filter((m) => m.repo === st.repoRoot),
      wipRefs,
      worktreesRoot: join(st.repoRoot, ".worktrees"),
      ownSid: st.sid,
      isAlive: pidAlive,
    });
  };

  const cleanupRecord = async (record: {
    sid: string;
    worktreePath: string | null;
    branch: string | null;
  }): Promise<string> => {
    if (st.repoRoot === null) return "not armed";
    const { sid, worktreePath, branch } = record;
    if (branch !== null) {
      const state = await prState(st.repoRoot, branch);
      if (state !== "MERGED") return `skipped '${sid}': PR state is ${state} (branch ${branch})`;
    }
    if (worktreePath !== null && existsSync(worktreePath)) {
      if (await isDirty(run, worktreePath)) return `skipped '${sid}': worktree has uncommitted changes`;
      await unlockWorktree(run, st.repoRoot, worktreePath);
      await removeWorktree(run, st.repoRoot, worktreePath);
    }
    await run(["worktree", "prune"], { cwd: st.repoRoot });
    if (branch !== null && (await refExists(run, st.repoRoot, `refs/heads/${branch}`))) {
      await deleteBranch(run, st.repoRoot, branch);
    }
    await deleteWipRef(run, st.repoRoot, sid);
    await removeManifest(sid);
    return `reaped '${sid}'${branch !== null ? ` (branch ${branch} merged)` : ""}`;
  };

  pi.on("session_start", async (_event, ctx) => {
    stopTimer();
    st = freshState();
    st.settings = await loadSettings(ctx.cwd, {
      projectTrusted: (() => {
        try {
          return ctx.isProjectTrusted();
        } catch {
          return false;
        }
      })(),
    });
    if (!st.settings.enabled) return;
    const repoRoot = await repoToplevel(run, ctx.cwd);
    if (repoRoot === null) return;
    if (await isLinkedWorktree(run, ctx.cwd)) return; // subagent inside a worktree, or operator-launched
    st.repoRoot = repoRoot;
    try {
      st.cwdReal = await fs.realpath(ctx.cwd);
    } catch {
      st.cwdReal = ctx.cwd;
    }
    st.commonDir = await gitCommonDir(run, ctx.cwd);
    // Sanitize at the source: st.sid is THE session key — lock reasons,
    // manifests, refs, and directory names all derive from it, so they can
    // never disagree the way a raw-vs-sanitized split would.
    try {
      st.sid = safeSid(ctx.sessionManager.getSessionId());
    } catch {
      st.sid = safeSid(`pid-${process.pid}`);
    }
    st.armed = true;

    // Re-attach this session's own worktree across resume/restart.
    const own = await loadManifest(st.sid);
    if (own && own.repo === repoRoot && existsSync(own.worktreePath)) {
      await unlockWorktree(run, repoRoot, own.worktreePath);
      try {
        await lockWorktree(
          run,
          repoRoot,
          own.worktreePath,
          formatLockReason(st.sid, process.pid, hostname(), new Date().toISOString()),
        );
      } catch {
        // Lock is a liveness marker, not a hard gate — proceed unlocked.
      }
      await saveManifest({ ...own, pid: process.pid, updatedAt: new Date().toISOString() });
      activate(ctx, own.worktreePath, own.branch);
      if (ctx.hasUI) {
        ctx.ui.notify(`worktree: re-attached ${own.worktreePath} (branch ${own.branch})`, "info");
      }
    }

    const dead = orphans(await gatherRecords());
    if (dead.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `worktree: ${dead.length} orphaned session worktree(s) with recoverable WIP — ` +
          `run /worktree status (resume with /worktree resume <sid>).`,
        "warning",
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!st.armed || st.disabledReason !== null) return undefined;

    if (event.toolName === "write" || event.toolName === "edit") {
      const rawPath = (event.input as { path?: unknown }).path;
      if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;

      if (!st.active) {
        // Lazy trigger: first repo-targeting mutation creates the worktree.
        const probe = classifyPath(rawPath, {
          cwd: ctx.cwd,
          cwdReal: st.cwdReal ?? ctx.cwd,
          repoRoot: st.repoRoot ?? ctx.cwd,
          worktreePath: join(st.repoRoot ?? ctx.cwd, ".worktrees", safeSid(st.sid)),
          exemptions: st.settings.writeExemptions,
        });
        if (probe.cls !== "primary") return undefined;
        if (st.settings.reportOnly) {
          notifyOnce(
            st,
            ctx,
            "report-trigger",
            `worktree(report-only): would isolate this session into .worktrees/${safeSid(st.sid)} on first write (${probe.rel ?? rawPath}).`,
          );
          return undefined;
        }
        if (!(await ensureWorktree(ctx))) return undefined; // fail-open
        // Fall through to enforcement below — the write still targets primary.
      }

      const ec = enforcementCtx(ctx);
      if (ec === null) return undefined;
      const classified = classifyPath(rawPath, ec);
      if (classified.cls !== "primary") return undefined;
      if (st.settings.reportOnly) {
        notifyOnce(st, ctx, "report-write", `worktree(report-only): would block ${event.toolName} → ${classified.rel ?? rawPath}`);
        return undefined;
      }
      const reason = denyReason(event.toolName, classified, ec);
      if (ctx.hasUI) ctx.ui.notify(`worktree: redirected ${event.toolName} of ${classified.rel ?? rawPath}`, "info");
      return { block: true, reason };
    }

    const ec = enforcementCtx(ctx);
    if (ec === null) return undefined;

    if (event.toolName === "bash") {
      if (st.settings.reportOnly) return undefined;
      const input = event.input as { command?: unknown };
      if (typeof input.command !== "string" || input.command.length === 0) return undefined;
      input.command = wrapBashCommand(input.command, ec.worktreePath);
      return undefined;
    }

    if (
      event.toolName === "read" ||
      event.toolName === "grep" ||
      event.toolName === "find" ||
      event.toolName === "ls"
    ) {
      if (st.settings.reportOnly) return undefined;
      const input = event.input as { path?: unknown };
      if (typeof input.path !== "string" || input.path.length === 0) {
        // grep/find/ls default to cwd — point them at the worktree instead.
        if (event.toolName !== "read") input.path = ec.worktreePath;
        return undefined;
      }
      const classified = classifyPath(input.path, ec);
      if (classified.cls !== "primary") return undefined;
      const mapped = mapToWorktree(classified.resolved, ec);
      if (mapped === null) return undefined;
      // Availability rule: prefer the worktree copy. When the worktree copy
      // is absent, a file tracked in the worktree's HEAD was DELETED by this
      // session — the read must see that deletion (ENOENT), not the stale
      // primary copy. Only genuinely primary-only untracked files (scratch
      // the worktree never had) keep the primary path.
      if (existsSync(mapped) || !existsSync(classified.resolved)) {
        input.path = mapped;
      } else if (classified.rel !== null && (await existsInHead(run, ec.worktreePath, classified.rel))) {
        input.path = mapped;
      }
      return undefined;
    }

    if (event.toolName === "subagent") {
      if (st.settings.reportOnly) return undefined;
      const input: Record<string, unknown> = event.input;
      if (typeof input["cwd"] !== "string") input["cwd"] = ec.worktreePath;
      for (const key of ["steps", "tasks"]) {
        const items = input[key];
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (typeof item === "object" && item !== null) {
            const rec = item as Record<string, unknown>;
            if (typeof rec["cwd"] !== "string") rec["cwd"] = ec.worktreePath;
          }
        }
      }
      return undefined;
    }

    return undefined;
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (st.active) await snapshotNow(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (st.active) await snapshotNow(ctx);
    stopTimer();
  });

  pi.registerCommand("worktree", {
    description: "Session worktree isolation: /worktree [status|resume <sid>|branch <name>|done|reap]",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter((s) => s.length > 0);
      const notify = (msg: string, level: "info" | "warning" | "error" = "info"): void => {
        if (ctx.hasUI) ctx.ui.notify(msg, level);
      };

      if (sub === undefined || sub === "status") {
        if (!st.armed) {
          notify(`worktree: not armed (${st.disabledReason ?? "no git repo / disabled / already in a worktree"})`);
          return;
        }
        const lines: string[] = [];
        lines.push(
          st.active
            ? `active: ${st.worktreePath} (branch ${st.branch}, sid ${st.sid})`
            : `inactive: worktree created on first write/edit (sid ${st.sid})`,
        );
        for (const r of await gatherRecords()) {
          const state = r.alive ? "live" : "ORPHAN";
          lines.push(
            `${state} '${r.sid}': ${r.worktree?.path ?? "worktree gone"}, branch ${
              r.manifest?.branch ?? r.worktree?.branch ?? "?"
            }, wip ${r.wipSha?.slice(0, 8) ?? "none"}, pid ${r.pid ?? "?"}`,
          );
        }
        notify(`worktree status:\n${lines.join("\n")}`);
        return;
      }

      if (sub === "resume") {
        const sid = rest[0];
        if (sid === undefined) {
          notify("worktree: usage — /worktree resume <sid>", "warning");
          return;
        }
        const record = (await gatherRecords()).find((r) => r.sid === sid);
        if (record === undefined) {
          notify(`worktree: no session '${sid}' found`, "warning");
          return;
        }
        if (record.alive) {
          notify(`worktree: session '${sid}' is still live (pid ${record.pid}) — refusing to adopt`, "warning");
          return;
        }
        notify(await adopt(ctx, record));
        return;
      }

      if (sub === "branch") {
        const name = rest[0];
        if (name === undefined || !BRANCH_RE.test(name)) {
          notify("worktree: usage — /worktree branch <type>/<kebab-name> (Conventional Commits types)", "warning");
          return;
        }
        if (!st.active || st.worktreePath === null || st.branch === null) {
          notify("worktree: no active worktree to rename", "warning");
          return;
        }
        try {
          await renameBranch(run, st.worktreePath, st.branch, name);
          const manifest = await loadManifest(st.sid);
          if (manifest) await saveManifest({ ...manifest, branch: name, updatedAt: new Date().toISOString() });
          st.branch = name;
          if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `⌂ ${name}`);
          notify(`worktree: branch renamed to ${name}`);
        } catch (err) {
          notify(`worktree: rename failed — ${String(err)}`, "error");
        }
        return;
      }

      if (sub === "done") {
        if (!st.active || st.worktreePath === null || st.branch === null) {
          notify("worktree: no active worktree", "warning");
          return;
        }
        await snapshotNow(ctx);
        const result = await cleanupRecord({ sid: st.sid, worktreePath: st.worktreePath, branch: st.branch });
        if (result.startsWith("reaped")) {
          stopTimer();
          st.active = false;
          st.worktreePath = null;
          st.branch = null;
          if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
          notify(`worktree: done — ${result}`);
        } else {
          notify(`worktree: not cleaned up — ${result}`, "warning");
        }
        return;
      }

      if (sub === "reap") {
        const dead = orphans(await gatherRecords());
        if (dead.length === 0) {
          notify("worktree: no orphaned sessions to reap");
          return;
        }
        const results: string[] = [];
        for (const r of dead) {
          results.push(
            await cleanupRecord({
              sid: r.sid,
              worktreePath: r.worktree?.path ?? r.manifest?.worktreePath ?? null,
              branch: r.manifest?.branch ?? r.worktree?.branch ?? null,
            }),
          );
        }
        notify(`worktree reap:\n${results.join("\n")}`);
        return;
      }

      notify(`worktree: unknown subcommand '${sub}' — use status|resume|branch|done|reap`, "warning");
    },
  });
}
