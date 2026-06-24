/**
 * expertise-client — environment / `.env.local` loading (ADR-0028).
 *
 * Phase 1 reads configuration from two sources only:
 *   1. `process.env` (highest precedence)
 *   2. a single FIXED extension-local file: `<ext>/.env.local`
 *
 * There is intentionally NO arbitrary `.env` discovery: the loader never walks
 * parent directories and never reads a repository's own `.env`. This prevents a
 * checked-out project from silently redirecting the client's endpoint or
 * supplying credentials (ADR-0028 § Trust and Security Controls).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path of the one env file the client will read. */
export function resolveEnvPath(): string {
  // `.env.local` lives in the extension root, one level above this lib module.
  return fileURLToPath(new URL("../.env.local", import.meta.url));
}

/**
 * Parse a minimal `KEY=VALUE` env file. Blank lines and `#` comments are
 * ignored; surrounding single/double quotes on the value are stripped. Keys
 * must match `[A-Za-z_][A-Za-z0-9_]*`. Unrecognized lines are skipped rather
 * than throwing — a malformed local file should degrade to "no value", not
 * crash the extension at load.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read and parse `<ext>/.env.local` if present. A missing file is not an
 * error — it yields an empty map, and `process.env` (or defaults) take over.
 */
export function loadEnvLocal(path: string): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return parseEnvFile(content);
}
