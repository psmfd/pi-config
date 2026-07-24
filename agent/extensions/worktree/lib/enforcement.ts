/**
 * worktree/lib/enforcement.ts — path classification and steering primitives.
 *
 * Once a session worktree is active:
 *   - write/edit paths in the primary checkout are DENIED with a redirect
 *     reason (guard-trio house style — deny, never silently relocate a
 *     mutation the model addressed elsewhere);
 *   - read-like paths are REWRITTEN into the worktree so the agent's reads
 *     see its own edits (stale-read prevention);
 *   - bash commands are wrapped in `cd <worktree> && ( … )` so relative-path
 *     commands execute in the worktree (documented `tool_call.input`
 *     mutation; ADR-0120 records this as the first input-mutation use in
 *     this repo).
 *
 * THREAT MODEL: blast-radius isolation for cooperating sessions, not a
 * sandbox. Absolute paths inside bash command strings escape the cd-wrap by
 * design — the same accepted-gap class as bash-destructive-guard's residual
 * gaps (its sibling guards still apply to every call).
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { matchesAny } from "./glob.ts";

export type PathClass = "worktree" | "exempt" | "primary" | "outside";

export interface EnforcementContext {
  /** The session's launch cwd (primary checkout or below). */
  cwd: string;
  /**
   * realpath(cwd) — git reports realpath'd toplevels, so when cwd sits
   * behind a symlink (macOS /var → /private/var, symlinked home dirs) every
   * containment check would mis-classify without this prefix mapping.
   */
  cwdReal?: string;
  /** Primary checkout toplevel (as git reports it — already realpath'd). */
  repoRoot: string;
  /** Active session worktree directory. */
  worktreePath: string;
  /** Write-exemption globs (lib/glob.ts semantics). */
  exemptions: readonly string[];
}

export interface Classified {
  cls: PathClass;
  /** Absolute resolved path. */
  resolved: string;
  /** Repo-relative POSIX path (primary/exempt only). */
  rel: string | null;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Map a symlinked-cwd prefix to its canonical form (see cwdReal above). */
function canonical(resolved: string, ec: EnforcementContext): string {
  const real = ec.cwdReal;
  if (real === undefined || real === ec.cwd) return resolved;
  if (resolved === ec.cwd) return real;
  if (resolved.startsWith(ec.cwd + sep)) return real + resolved.slice(ec.cwd.length);
  return resolved;
}

export function classifyPath(rawPath: string, ec: EnforcementContext): Classified {
  const resolved = canonical(resolve(ec.cwd, rawPath), ec);
  if (within(ec.worktreePath, resolved)) return { cls: "worktree", resolved, rel: null };
  if (!within(ec.repoRoot, resolved)) return { cls: "outside", resolved, rel: null };
  const rel = toPosix(relative(ec.repoRoot, resolved));
  if (matchesAny(rel, ec.exemptions)) return { cls: "exempt", resolved, rel };
  return { cls: "primary", resolved, rel };
}

/**
 * Map a primary-checkout path to its worktree equivalent. Returns null for
 * paths under `.worktrees/` (another session's tree — no sensible mapping).
 */
export function mapToWorktree(resolved: string, ec: EnforcementContext): string | null {
  const rel = relative(ec.repoRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  if (toPosix(rel).startsWith(".worktrees/")) return null;
  return resolve(ec.worktreePath, rel);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Steer a bash command into the worktree. The subshell keeps arbitrary
 * multi-line commands (heredocs, `&&` chains, trailing `&`) intact, and the
 * newline before `)` terminates any final unterminated construct cleanly.
 */
export function wrapBashCommand(command: string, worktreePath: string): string {
  return `cd ${shellQuote(worktreePath)} && (\n${command}\n)`;
}

export function denyReason(toolName: string, classified: Classified, ec: EnforcementContext): string {
  const mapped = mapToWorktree(classified.resolved, ec);
  const target = mapped
    ? `Re-issue this ${toolName} against: ${mapped}`
    : `This path belongs to another session's worktree — do not modify it.`;
  return (
    `worktree: this session's code work is isolated in ${ec.worktreePath} ` +
    `(branch checkout of this repo). Writing to the shared primary checkout is blocked ` +
    `to prevent cross-session collisions. ${target}`
  );
}
