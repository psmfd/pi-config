/**
 * Current-branch resolution for the CI widget (ADR-0140, #1005).
 *
 * repo-dash's only other subprocess is the shared, argv-gated `gh` runner, so
 * adding one is a deliberate change of posture rather than an implementation
 * detail. Three things keep it narrow:
 *
 * 1. **The argv is a constant.** Nothing interpolated, nothing attacker- or
 *    operator-influenced reaches it. The subprocess concern that motivates the
 *    `gh` path's `assertReadOnlyPlan` gate is argv construction from untrusted
 *    parts; there is no construction here to get wrong.
 * 2. **Every failure is soft.** Not a repository, no git on PATH, detached
 *    HEAD, timeout, a branch name GitHub's `ref` grammar would reject — all
 *    return `undefined`, and the caller falls back to the repository-wide
 *    behaviour that shipped in ADR-0140. The widget must never break because
 *    branch detection did.
 * 3. **It runs once per session.** The result is cached by the caller
 *    alongside the repository, so this is not on the polling path.
 *
 * Reading `.git/HEAD` directly was considered and rejected: ADR-0120 puts every
 * pi session in a linked worktree, where `.git` is a *file* pointing at
 * `…/.git/worktrees/<name>`, so worktree gitdir resolution would be the common
 * path rather than an edge case — reimplementing plumbing `rev-parse` already
 * gets right, along with `GIT_DIR`, bare repos, and parent-directory discovery.
 */

import { spawn } from "node:child_process";

/** Generous for a local plumbing command; the widget is not blocked on it. */
const TIMEOUT_MS = 5_000;

/** Longest plausible branch name; also bounds what a hostile checkout can return. */
const MAX_OUTPUT = 4096;

/**
 * GitHub's own `ref` grammar, mirrored from `shared/github-read-validation.ts`.
 *
 * Checked *here* rather than left to `validateRef`, because that function
 * **throws** — and a throw on this path would surface as a permanently
 * unavailable widget for a branch name that is perfectly valid in git but
 * outside GitHub's accepted shape. Screening locally turns that into an
 * unscoped widget instead. Keep in lockstep with `REF_RE` there.
 */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Injectable seam so tests never spawn a process. */
export type GitRunner = (args: readonly string[], timeoutMs: number) => Promise<string | undefined>;

/**
 * Run git and return trimmed stdout, or `undefined` on any failure.
 *
 * Environment is not scrubbed the way `runGh` scrubs it: no credential is being
 * passed, and `git rev-parse` reads no network. `GIT_*` variables in the
 * operator's own environment are theirs to set, and honouring them is correct
 * behaviour for a command asking "what branch am I on".
 */
const runGit: GitRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    let out = "";
    const done = (value?: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn("git", [...args], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // git missing from PATH, or spawn refused outright.
      done();
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (out.length < MAX_OUTPUT) out += chunk;
    });
    child.on("error", () => { clearTimeout(timer); done(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? out.slice(0, MAX_OUTPUT).trim() : undefined);
    });
  });

/**
 * The branch the session is sitting on, or `undefined` when there isn't one.
 *
 * `undefined` deliberately conflates every reason — detached HEAD, no
 * repository, no git, an unusable name — because the caller does the same thing
 * in all of them: show the repository-wide view. Distinguishing them would
 * imply the caller could act on the difference, and it cannot.
 *
 * `--abbrev-ref HEAD` prints the literal string `HEAD` on a detached checkout,
 * which is why that value is rejected rather than passed through as a branch
 * named "HEAD".
 */
export async function currentBranch(run: GitRunner = runGit): Promise<string | undefined> {
  const value = await run(["rev-parse", "--abbrev-ref", "HEAD"], TIMEOUT_MS);
  if (value === undefined || value.length === 0) return undefined;
  if (value === "HEAD") return undefined;
  if (!REF_RE.test(value)) return undefined;
  return value;
}
