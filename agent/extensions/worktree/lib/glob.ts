/**
 * worktree/lib/glob.ts — minimal glob matcher for write-exemption patterns.
 *
 * Semantics (documented in the extension README):
 *   - A pattern containing "/" matches against the full repo-relative path
 *     (POSIX separators).
 *   - A pattern without "/" matches against the basename, at any depth.
 *   - `**` crosses directory separators; `*` and `?` do not.
 *
 * Deliberately tiny — no dependency, no brace expansion, no negation. The
 * exemption list is operator-curated config, not a general-purpose ignore
 * engine (ADR-0120).
 */

const SPECIALS = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — match anything, including separators. Swallow a trailing
        // slash so "a/**/b" also matches "a/b".
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += c.replace(SPECIALS, "\\$&");
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/**
 * Test a repo-relative POSIX path against a list of exemption patterns.
 * Invalid patterns are skipped (never throw on operator config).
 */
export function matchesAny(relPath: string, patterns: readonly string[]): boolean {
  const base = relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath;
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0) continue;
    let re: RegExp;
    try {
      re = globToRegExp(pattern);
    } catch {
      continue;
    }
    const subject = pattern.includes("/") ? relPath : base;
    if (re.test(subject)) return true;
  }
  return false;
}
