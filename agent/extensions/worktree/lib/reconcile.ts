/**
 * worktree/lib/reconcile.ts — orphan detection (pure logic).
 *
 * pi fires NO event on ungraceful death (session_shutdown is skipped on
 * uncaughtException / terminal-EIO / SIGKILL), so recovery is proactive:
 * every session_start cross-references the three durable signals —
 * worktree lock reasons (pid liveness records), per-session manifests, and
 * refs/pi-wip/* — and reports sessions whose recorded process is dead.
 * Adoption is NEVER automatic for foreign sids; only the surfacing is
 * (ADR-0120). This module is pure so it unit-tests without git or /proc.
 */

import type { WipRefInfo, WorktreeInfo } from "./git.ts";
import type { SessionManifest } from "./manifest.ts";

export interface LockInfo {
  sid: string | null;
  pid: number | null;
  host: string | null;
  started: string | null;
}

/** Parse a `session:<sid> pid:<n> host:<h> started:<iso>` lock reason. */
export function parseLockReason(reason: string): LockInfo {
  const info: LockInfo = { sid: null, pid: null, host: null, started: null };
  for (const token of reason.split(/\s+/)) {
    const idx = token.indexOf(":");
    if (idx <= 0) continue;
    const key = token.slice(0, idx);
    const value = token.slice(idx + 1);
    if (value.length === 0) continue;
    if (key === "session") info.sid = value;
    else if (key === "pid") {
      const n = Number.parseInt(value, 10);
      if (Number.isInteger(n) && n > 0) info.pid = n;
    } else if (key === "host") info.host = value;
    else if (key === "started") info.started = value;
  }
  return info;
}

export function formatLockReason(sid: string, pid: number, host: string, startedIso: string): string {
  return `session:${sid} pid:${pid} host:${host} started:${startedIso}`;
}

export interface SessionRecord {
  sid: string;
  worktree: WorktreeInfo | null;
  manifest: SessionManifest | null;
  wipSha: string | null;
  pid: number | null;
  alive: boolean;
}

export interface ReconcileInput {
  worktrees: readonly WorktreeInfo[];
  manifests: readonly SessionManifest[];
  wipRefs: readonly WipRefInfo[];
  /** Directory that contains per-session worktrees (`<repo>/.worktrees`). */
  worktreesRoot: string;
  ownSid: string;
  isAlive: (pid: number) => boolean;
}

/**
 * Merge the three signals into per-sid records. Records for `ownSid` are
 * excluded (the running session manages its own state). A record with a
 * dead — or unknowable — pid is an orphan candidate.
 */
export function reconcile(input: ReconcileInput): SessionRecord[] {
  const bySid = new Map<string, SessionRecord>();
  const record = (sid: string): SessionRecord => {
    let r = bySid.get(sid);
    if (!r) {
      r = { sid, worktree: null, manifest: null, wipSha: null, pid: null, alive: false };
      bySid.set(sid, r);
    }
    return r;
  };

  for (const wt of input.worktrees) {
    // Only session worktrees under our root — the primary checkout and any
    // operator-created worktrees elsewhere are none of our business.
    if (!wt.path.startsWith(`${input.worktreesRoot}/`) && wt.path !== input.worktreesRoot) continue;
    const lock = wt.lockReason !== null ? parseLockReason(wt.lockReason) : null;
    const sid = lock?.sid ?? wt.path.slice(wt.path.lastIndexOf("/") + 1);
    const r = record(sid);
    r.worktree = wt;
    if (lock?.pid !== null && lock?.pid !== undefined) r.pid = lock.pid;
  }
  for (const m of input.manifests) {
    const r = record(m.sessionId);
    r.manifest = m;
    if (r.pid === null) r.pid = m.pid;
  }
  for (const ref of input.wipRefs) {
    record(ref.sid).wipSha = ref.sha;
  }

  const records: SessionRecord[] = [];
  for (const r of bySid.values()) {
    if (r.sid === input.ownSid) continue;
    r.alive = r.pid !== null && input.isAlive(r.pid);
    records.push(r);
  }
  return records.sort((a, b) => a.sid.localeCompare(b.sid));
}

export function orphans(records: readonly SessionRecord[]): SessionRecord[] {
  return records.filter((r) => !r.alive);
}
