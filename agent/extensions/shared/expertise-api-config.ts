/**
 * shared/expertise-api-config.ts — agent-expertise-api configuration
 * resolution + trust-boundary validation (ADR-0028).
 *
 * Moved here from `expertise-client/lib/config.ts` (ADR-0095) so both
 * `expertise-client` (the tool surface) and `expertise-fanout-gate` (the
 * deterministic canonical-search hook, #613) consume ONE config parser —
 * the same #635/ADR-0088 rationale that moved `secret-scan.ts`: the client
 * is excluded from the config mirror, so a cross-extension import of it is
 * unresolvable on a distributed install.
 *
 * Resolves the base URL, API key, and write opt-in with precedence
 * `process.env` > `.env.local` > built-in defaults, then enforces the
 * phase-1 invariants:
 *   - the base URL must resolve to LOOPBACK (no remote/team endpoints yet);
 *   - an API key is REQUIRED for every call (loopback is a network locality
 *     boundary, not an authentication boundary).
 *
 * Endpoint/credential values are never read from project/repo settings — only
 * from `process.env` and the fixed `.env.local` owned by the expertise-client
 * extension (each consumer resolves that path itself; see
 * `expertise-client/lib/env.ts` and the fanout gate's sibling-path resolver).
 * The pure `.env.local` PARSING helpers live here for the same one-parser
 * reason; the path anchoring stays consumer-local.
 */

import { readFileSync } from "node:fs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

export const ENV_BASE_URL = "PI_EXPERTISE_API_BASE_URL";
export const ENV_API_KEY = "PI_EXPERTISE_API_KEY";
export const ENV_ALLOW_WRITE = "PI_EXPERTISE_ALLOW_LOCALDEV_WRITE";

/** Resolved, validated client configuration. */
export interface ClientConfig {
  /** Loopback origin, e.g. `http://127.0.0.1:8080`. */
  baseUrl: string;
  /** API key, sent as `Authorization: Bearer`. Never logged or surfaced. */
  apiKey: string;
  /** Whether local write/create is explicitly opted in (`...=1`). */
  allowWrite: boolean;
}

export type ConfigResult =
  | { ok: true; config: ClientConfig }
  | { ok: false; reason: string };

type EnvMap = Record<string, string | undefined>;

/** `process.env` value wins over `.env.local`, which wins over the fallback. */
function resolve(
  key: string,
  processEnv: EnvMap,
  fileEnv: Record<string, string>,
  fallback: string,
): string {
  const fromProcess = processEnv[key];
  if (fromProcess !== undefined && fromProcess.length > 0) return fromProcess;
  const fromFile = fileEnv[key];
  if (fromFile !== undefined && fromFile.length > 0) return fromFile;
  return fallback;
}

/** True for `localhost`, `::1`, and the `127.0.0.0/8` block. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost") return true;
  if (host === "::1") return true;
  // 127.0.0.0/8 with true 0-255 octets (the prior \d{1,3} accepted 127.999.0.1).
  if (
    /^127\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(
      host,
    )
  )
    return true;
  return false;
}

/**
 * Resolve and validate config from `process.env` + `.env.local`. Returns a
 * discriminated result so callers translate failures into tool refusals.
 */
export function buildClientConfig(
  processEnv: EnvMap,
  fileEnv: Record<string, string>,
): ConfigResult {
  const rawBaseUrl = resolve(
    ENV_BASE_URL,
    processEnv,
    fileEnv,
    DEFAULT_BASE_URL,
  );

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    return {
      ok: false,
      reason: `${ENV_BASE_URL} '${rawBaseUrl}' is not a valid URL`,
    };
  }

  if (!isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      reason:
        `${ENV_BASE_URL} host '${parsed.hostname}' is not loopback. ` +
        `Phase 1 (ADR-0028) only talks to a local agent-expertise-api; ` +
        `remote/team endpoints are deferred.`,
    };
  }

  const apiKey = resolve(ENV_API_KEY, processEnv, fileEnv, "");
  if (apiKey.length === 0) {
    return {
      ok: false,
      reason:
        `${ENV_API_KEY} is required for all expertise-client calls. ` +
        `Set it in the environment or in the extension's .env.local.`,
    };
  }

  const allowWrite = resolve(ENV_ALLOW_WRITE, processEnv, fileEnv, "0") === "1";

  return {
    ok: true,
    config: { baseUrl: parsed.origin, apiKey, allowWrite },
  };
}

// ---------------------------------------------------------------------------
// `.env.local` parsing (moved from expertise-client/lib/env.ts, ADR-0095).
// Path RESOLUTION stays consumer-local — only the pure parse/load lives here.
// ---------------------------------------------------------------------------

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
 * Read and parse an `.env.local` if present. A missing file is not an
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
