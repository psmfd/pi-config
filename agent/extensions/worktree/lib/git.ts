/**
 * worktree/lib/git.ts — git plumbing for per-session worktree isolation and
 * crash-durable WIP snapshots (ADR-0120, #859).
 *
 * Every function takes an injectable `GitRunner` so the whole module
 * unit-tests against throwaway temp repositories without pi. The runner
 * never throws on non-zero exit — callers branch on `code` (helpers that
 * represent hard failures throw a descriptive Error themselves).
 *
 * Durability model: snapshots are TEMP-INDEX `commit-tree` commits pinned to
 * `refs/pi-wip/<sid>` — NOT `git stash create` (which cannot capture
 * untracked files, i.e. every newly written source file) and NOT commits on
 * the visible branch (which would run the pre-commit secrets-guard on every
 * snapshot and pollute pre-squash history). The temp index means the real
 * index is never touched, no hooks run, and the commit lives in the shared
 * object store — it survives worktree deletion and any process death mode.
 * `refs/pi-wip/*` is a local-only namespace by convention; nothing here (or
 * anywhere in this extension) configures a push refspec for it.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<GitResult>;

/** Real runner: `git <args>` via execFile (no shell), 16 MB output cap. */
export function systemGitRunner(): GitRunner {
  return (args, opts) =>
    new Promise((resolvePromise) => {
      execFile(
        "git",
        args,
        {
          cwd: opts?.cwd,
          env: opts?.env ? { ...process.env, ...opts.env } : process.env,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          let code = 0;
          if (error) {
            const raw = (error as { code?: unknown }).code;
            code = typeof raw === "number" ? raw : 1;
          }
          resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

/** Identity override for WIP snapshot commits — independent of user config. */
const SNAPSHOT_IDENT = [
  "-c",
  "user.name=pi-worktree",
  "-c",
  "user.email=pi-worktree@localhost",
];

const WIP_REF_PREFIX = "refs/pi-wip/";

/** Sanitize a session id for use in refs, branch names, and directory names. */
export function safeSid(sid: string): string {
  const cleaned = sid.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return cleaned.length > 0 ? cleaned : "unknown-session";
}

export function wipRef(sid: string): string {
  return `${WIP_REF_PREFIX}${safeSid(sid)}`;
}

export async function repoToplevel(run: GitRunner, cwd: string): Promise<string | null> {
  const r = await run(["rev-parse", "--show-toplevel"], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function gitCommonDir(run: GitRunner, cwd: string): Promise<string | null> {
  const r = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** A linked worktree's --git-dir differs from --git-common-dir. */
export async function isLinkedWorktree(run: GitRunner, cwd: string): Promise<boolean> {
  const r = await run(
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    { cwd },
  );
  if (r.code !== 0) return false;
  const [gitDir, commonDir] = r.stdout.trim().split("\n");
  return gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir;
}

/**
 * Ensure `/.worktrees/` is excluded via `<common-dir>/info/exclude` — local
 * only, so target repos we do not own need no committed .gitignore change.
 */
export async function ensureExcluded(commonDir: string): Promise<void> {
  const file = join(commonDir, "info", "exclude");
  const line = "/.worktrees/";
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    // Missing info/exclude is normal for fresh repos.
  }
  if (existing.split("\n").some((l) => l.trim() === line)) return;
  await fs.mkdir(join(commonDir, "info"), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.appendFile(
    file,
    `${prefix}# pi worktree extension — per-session worktrees (ADR-0120)\n${line}\n`,
    "utf8",
  );
}

/**
 * Resolve the base ref for a new session branch. Explicit setting wins;
 * otherwise origin/dev → origin/main → origin/HEAD → HEAD. Each origin/*
 * candidate gets its own best-effort fetch before verification (a repo whose
 * upstream has main but not dev must still fetch main); offline fetches fail
 * fast and fall back to local state.
 */
export async function resolveBaseRef(
  run: GitRunner,
  repo: string,
  explicit: string | null,
): Promise<string | null> {
  const candidates = explicit ? [explicit] : ["origin/dev", "origin/main", "origin/HEAD", "HEAD"];
  for (const candidate of candidates) {
    if (candidate.startsWith("origin/") && candidate !== "origin/HEAD") {
      await run(["fetch", "--quiet", "origin", candidate.slice("origin/".length)], { cwd: repo });
    }
    const r = await run(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
      cwd: repo,
    });
    if (r.code === 0) return candidate;
  }
  return null;
}

/**
 * Whether `relPath` (repo-relative, POSIX) is tracked in the worktree's
 * HEAD. Distinguishes "the session deleted this file in its worktree" (HEAD
 * still has it — reads must see the deletion, not the stale primary copy)
 * from "primary-only scratch the worktree never had."
 */
export async function existsInHead(
  run: GitRunner,
  worktree: string,
  relPath: string,
): Promise<boolean> {
  const r = await run(["cat-file", "-e", `HEAD:${relPath}`], { cwd: worktree });
  return r.code === 0;
}

export async function refExists(run: GitRunner, repo: string, ref: string): Promise<boolean> {
  const r = await run(["rev-parse", "--verify", "--quiet", ref], { cwd: repo });
  return r.code === 0;
}

export async function addWorktree(
  run: GitRunner,
  repo: string,
  path: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  const r = await run(["worktree", "add", "-b", branch, path, baseRef], { cwd: repo });
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
}

/** Attach an existing branch in a new worktree directory (recovery path). */
export async function addWorktreeForBranch(
  run: GitRunner,
  repo: string,
  path: string,
  branch: string,
): Promise<void> {
  const r = await run(["worktree", "add", path, branch], { cwd: repo });
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
}

export async function lockWorktree(
  run: GitRunner,
  repo: string,
  path: string,
  reason: string,
): Promise<void> {
  const r = await run(["worktree", "lock", "--reason", reason, path], { cwd: repo });
  if (r.code !== 0) throw new Error(`git worktree lock failed: ${r.stderr.trim()}`);
}

export async function unlockWorktree(run: GitRunner, repo: string, path: string): Promise<boolean> {
  const r = await run(["worktree", "unlock", path], { cwd: repo });
  return r.code === 0;
}

export async function removeWorktree(
  run: GitRunner,
  repo: string,
  path: string,
  force = false,
): Promise<void> {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), path];
  const r = await run(args, { cwd: repo });
  if (r.code !== 0) throw new Error(`git worktree remove failed: ${r.stderr.trim()}`);
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  /** Short branch name (refs/heads/ stripped), or null when detached. */
  branch: string | null;
  /** Lock reason string, "" when locked without reason, null when unlocked. */
  lockReason: string | null;
}

export async function listWorktrees(run: GitRunner, repo: string): Promise<WorktreeInfo[]> {
  const r = await run(["worktree", "list", "--porcelain"], { cwd: repo });
  if (r.code !== 0) return [];
  const result: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: line.slice("worktree ".length), head: null, branch: null, lockReason: null };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line.startsWith("locked")) {
      current.lockReason = line.length > "locked".length ? line.slice("locked ".length) : "";
    }
  }
  if (current) result.push(current);
  return result;
}

export async function isDirty(run: GitRunner, worktree: string): Promise<boolean> {
  const r = await run(["status", "--porcelain"], { cwd: worktree });
  if (r.code !== 0) return false;
  return r.stdout.trim().length > 0;
}

/**
 * Crash-durable WIP snapshot of `worktree` into `refs/pi-wip/<sid>`.
 *
 * Builds the commit through a TEMP index (never the real one): read-tree
 * HEAD → add -A → write-tree → commit-tree -p HEAD. Captures tracked
 * modifications AND untracked files (gitignored content excluded by add -A).
 * Returns the snapshot sha, or null when the tree is identical to HEAD's.
 * Skips ref churn when the tree matches the previous snapshot.
 */
export async function snapshotWip(
  run: GitRunner,
  worktree: string,
  sid: string,
): Promise<string | null> {
  const gitDirRes = await run(["rev-parse", "--path-format=absolute", "--git-dir"], {
    cwd: worktree,
  });
  if (gitDirRes.code !== 0) throw new Error(`snapshot: not a git dir: ${gitDirRes.stderr.trim()}`);
  const tmpIndex = join(gitDirRes.stdout.trim(), "pi-wip-index");
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    let r = await run(["read-tree", "HEAD"], { cwd: worktree, env });
    if (r.code !== 0) throw new Error(`snapshot read-tree failed: ${r.stderr.trim()}`);
    r = await run(["add", "-A", "."], { cwd: worktree, env });
    if (r.code !== 0) throw new Error(`snapshot add failed: ${r.stderr.trim()}`);
    r = await run(["write-tree"], { cwd: worktree, env });
    if (r.code !== 0) throw new Error(`snapshot write-tree failed: ${r.stderr.trim()}`);
    const tree = r.stdout.trim();

    const headTree = await run(["rev-parse", "HEAD^{tree}"], { cwd: worktree });
    if (headTree.code === 0 && headTree.stdout.trim() === tree) return null;

    const ref = wipRef(sid);
    const prevTree = await run(["rev-parse", "--verify", "--quiet", `${ref}^{tree}`], {
      cwd: worktree,
    });
    if (prevTree.code === 0 && prevTree.stdout.trim() === tree) {
      const prev = await run(["rev-parse", ref], { cwd: worktree });
      return prev.code === 0 ? prev.stdout.trim() : null;
    }

    const head = await run(["rev-parse", "HEAD"], { cwd: worktree });
    if (head.code !== 0) throw new Error(`snapshot rev-parse HEAD failed: ${head.stderr.trim()}`);
    r = await run(
      [
        ...SNAPSHOT_IDENT,
        "commit-tree",
        tree,
        "-p",
        head.stdout.trim(),
        "-m",
        `pi-wip: session ${safeSid(sid)} snapshot`,
      ],
      { cwd: worktree },
    );
    if (r.code !== 0) throw new Error(`snapshot commit-tree failed: ${r.stderr.trim()}`);
    const sha = r.stdout.trim();
    r = await run(["update-ref", "--create-reflog", ref, sha], { cwd: worktree });
    if (r.code !== 0) throw new Error(`snapshot update-ref failed: ${r.stderr.trim()}`);
    return sha;
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => undefined);
  }
}

export interface WipRefInfo {
  sid: string;
  sha: string;
}

export async function listWipRefs(run: GitRunner, repo: string): Promise<WipRefInfo[]> {
  const r = await run(
    ["for-each-ref", "--format=%(refname) %(objectname)", WIP_REF_PREFIX.slice(0, -1)],
    { cwd: repo },
  );
  if (r.code !== 0) return [];
  const refs: WipRefInfo[] = [];
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(WIP_REF_PREFIX)) continue;
    const [refname, sha] = trimmed.split(" ");
    if (refname && sha) refs.push({ sid: refname.slice(WIP_REF_PREFIX.length), sha });
  }
  return refs;
}

export async function deleteWipRef(run: GitRunner, repo: string, sid: string): Promise<void> {
  await run(["update-ref", "-d", wipRef(sid)], { cwd: repo });
}

/**
 * Restore a WIP snapshot into `worktree`'s working tree. Recovered state
 * shows as uncommitted changes (modified / untracked; removals may appear
 * staged — a documented `git restore --no-overlay` behavior) — the
 * pre-crash content, ready to continue or commit.
 */
export async function restoreSnapshot(run: GitRunner, worktree: string, sha: string): Promise<void> {
  const r = await run(["restore", "--source", sha, "--no-overlay", "--worktree", "--", "."], {
    cwd: worktree,
  });
  if (r.code !== 0) throw new Error(`restore snapshot failed: ${r.stderr.trim()}`);
}

export async function renameBranch(
  run: GitRunner,
  worktree: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const r = await run(["branch", "-m", oldName, newName], { cwd: worktree });
  if (r.code !== 0) throw new Error(`branch rename failed: ${r.stderr.trim()}`);
}

export async function deleteBranch(run: GitRunner, repo: string, branch: string): Promise<void> {
  const r = await run(["branch", "-D", branch], { cwd: repo });
  if (r.code !== 0) throw new Error(`branch delete failed: ${r.stderr.trim()}`);
}
