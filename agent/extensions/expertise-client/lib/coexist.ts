/**
 * expertise-client — load-time coexistence guard (ADR-0029).
 *
 * The client registers `expertise_search` and `expertise_create` from
 * `~/.pi/agent/extensions/`, so it loads for EVERY pi session regardless of the
 * project directory. The `agent-expertise-api` repository ships its OWN
 * project-local pi extension (`<repo>/.pi/extensions/expertise-api/`) that
 * registers the same two tool names directly against the in-process API. pi
 * requires tool names to be unique across all loaded extensions, so when pi is
 * launched inside that repo both extensions claim the names and the
 * second-loaded one fails to load.
 *
 * This guard makes the GLOBAL client stand down whenever the current project
 * already defines a conflicting expertise tool, so the project-local extension
 * wins. An explicit `SKIP_EXPERTISE_CLIENT=1` override forces stand-down
 * unconditionally.
 *
 * Detection reads only `<cwd>/.pi/extensions/<dir>/index.ts` (the project-local
 * extension discovery path). It never injects file content anywhere — it scans
 * for a conflicting tool-name registration and returns a boolean. This is NOT a
 * configuration or credential source (cf. ADR-0028 § Trust and Security
 * Controls); it is a local conflict-avoidance check and fails OPEN (registers
 * normally) on any read error.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Tool names this client registers — and therefore the names it can collide on. */
export const CONFLICTING_TOOL_NAMES = ["expertise_search", "expertise_create"] as const;

/** Env var that forces the client to stand down unconditionally. */
export const SKIP_ENV = "SKIP_EXPERTISE_CLIENT";

/** Max bytes scanned from any sibling extension entry point during detection. */
const MAX_SCAN_BYTES = 512 * 1024;

/**
 * Max number of `.pi/extensions/<dir>` entries inspected. Bounds startup cost
 * against a crafted project tree with a very large extensions directory; real
 * projects ship a handful of extensions, well under this cap.
 */
export const MAX_SCAN_ENTRIES = 100;

/** Escape regex metacharacters so a tool name is matched literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a `registerTool({ name: "<conflicting>" ... })` call for any of our
 * tool names, tolerant of quote style and surrounding whitespace. The leading
 * negative lookbehind keeps it from matching a different key that merely ends in
 * `name` (e.g. `tool_name: "expertise_search"`).
 */
const CONFLICT_RE = new RegExp(
  `(?<![A-Za-z0-9_])name\\s*:\\s*["'](?:${CONFLICTING_TOOL_NAMES.map(escapeRegExp).join("|")})["']`,
);

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const s = value.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Scans a single candidate entry-point file for a conflicting tool-name
 * registration. Returns `true` only for a regular file at or under the byte cap
 * that matches `CONFLICT_RE`. Any stat/read error or oversized/non-regular file
 * yields `false` (fail open: skip this candidate).
 */
function fileRegistersConflict(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) return false;
    return CONFLICT_RE.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Returns the first (lexicographically lowest) project-local extension entry
 * under `<cwd>/.pi/extensions` that registers a conflicting tool name, or `null`
 * when none does. Both pi project-extension discovery forms are covered
 * (`docs/extensions.md`): the subdirectory form `<dir>/index.ts` and the
 * single-file form `<name>.ts`. The returned label is the matched entry as it
 * appears under `.pi/extensions/` (a bare dir name, or a `*.ts` filename).
 * Entries are sorted for deterministic reporting and at most `MAX_SCAN_ENTRIES`
 * are inspected. A missing or unreadable extensions root yields `null` (fail
 * open: the client registers normally).
 */
export function findConflictingProjectExtension(cwd: string): string | null {
  const extRoot = join(cwd, ".pi", "extensions");
  let entries: string[];
  try {
    entries = readdirSync(extRoot);
  } catch {
    return null;
  }
  let scanned = 0;
  for (const name of entries.sort()) {
    if (scanned >= MAX_SCAN_ENTRIES) break;
    scanned++;
    // Subdirectory form: .pi/extensions/<name>/index.ts
    if (fileRegistersConflict(join(extRoot, name, "index.ts"))) return name;
    // Single-file form: .pi/extensions/<name>.ts
    if (name.endsWith(".ts") && fileRegistersConflict(join(extRoot, name))) {
      return name;
    }
  }
  return null;
}

export interface SkipDecision {
  skip: boolean;
  reason: string;
}

/**
 * Decide whether the global client should register its tools:
 *
 *   1. `SKIP_EXPERTISE_CLIENT` truthy            -> skip (explicit operator override)
 *   2. current project ships a conflicting tool  -> skip (yield to the project)
 *   3. otherwise                                 -> register normally
 */
export function shouldSkipRegistration(opts: {
  env: Record<string, string | undefined>;
  cwd: string;
}): SkipDecision {
  if (isTruthy(opts.env[SKIP_ENV])) {
    return { skip: true, reason: `${SKIP_ENV} is set` };
  }
  const dir = findConflictingProjectExtension(opts.cwd);
  if (dir) {
    return {
      skip: true,
      reason: `project-local extension .pi/extensions/${dir} already registers an expertise tool`,
    };
  }
  return { skip: false, reason: "" };
}
