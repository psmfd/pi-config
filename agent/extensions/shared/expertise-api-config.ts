/**
 * shared/expertise-api-config.ts — agent-expertise-api configuration
 * resolution + trust-boundary validation (ADR-0103, superseding ADR-0028).
 *
 * Both `expertise-client` and `expertise-fanout-gate` consume this one parser.
 * It supports two deliberately distinct profiles:
 *
 *   1. legacy local development: `PI_EXPERTISE_*` from process env plus the
 *      extension-owned `.env.local`; API-key authenticated and loopback-only;
 *   2. upstream bearer contract: `EXPERTISE_API_BASE_URL` +
 *      `EXPERTISE_API_TOKEN` from process env plus the upstream fixed
 *      `~/.config/expertise-api/secrets.env` file (or the explicit
 *      `EXPERTISE_API_SECRETS_FILE` override). Remote origins require HTTPS.
 *
 * The upstream token is pre-provisioned by the operator (for the LAN static
 * OIDC profile, via agent-expertise-api's `scripts/mint_token.py`). This client
 * never mints, refreshes, or writes credentials. Endpoint/credential values
 * are never read from project settings or discovered by walking repository
 * directories.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
export const DEFAULT_UPSTREAM_SECRETS_FILE = join(
  homedir(),
  ".config",
  "expertise-api",
  "secrets.env",
);

export const ENV_BASE_URL = "PI_EXPERTISE_API_BASE_URL";
export const ENV_API_KEY = "PI_EXPERTISE_API_KEY";
export const ENV_ALLOW_WRITE = "PI_EXPERTISE_ALLOW_LOCALDEV_WRITE";
export const ENV_UPSTREAM_BASE_URL = "EXPERTISE_API_BASE_URL";
export const ENV_UPSTREAM_TOKEN = "EXPERTISE_API_TOKEN";
export const ENV_UPSTREAM_SECRETS_FILE = "EXPERTISE_API_SECRETS_FILE";

export type ExpertiseAuthMode = "local-api-key" | "upstream-bearer";

/** Resolved, validated client configuration. */
export interface ClientConfig {
  /** Validated API origin. Remote origins are possible only in upstream-bearer mode. */
  baseUrl: string;
  /** Bearer credential (API key, LocalDev token, or OIDC JWT). Never surfaced. */
  bearerToken: string;
  /** Which trust profile produced this configuration. */
  authMode: ExpertiseAuthMode;
  /** Whether create remains explicitly opted in (`PI_EXPERTISE_...=1`). */
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
 * Resolve and validate config. A non-empty upstream variable selects the
 * upstream profile; a partial upstream pair fails closed rather than silently
 * falling back to a legacy credential.
 */
export function buildClientConfig(
  processEnv: EnvMap,
  legacyFileEnv: Record<string, string>,
  upstreamFileEnv: Record<string, string> = {},
): ConfigResult {
  const allowWrite =
    resolve(ENV_ALLOW_WRITE, processEnv, legacyFileEnv, "0") === "1";
  const upstreamBaseUrl = resolve(
    ENV_UPSTREAM_BASE_URL,
    processEnv,
    upstreamFileEnv,
    "",
  );
  const upstreamToken = resolve(
    ENV_UPSTREAM_TOKEN,
    processEnv,
    upstreamFileEnv,
    "",
  );
  const upstreamSelected = upstreamBaseUrl.length > 0 || upstreamToken.length > 0;

  if (upstreamSelected) {
    if (upstreamBaseUrl.length === 0 || upstreamToken.length === 0) {
      return {
        ok: false,
        reason:
          `${ENV_UPSTREAM_BASE_URL} and ${ENV_UPSTREAM_TOKEN} must both be set ` +
          `for the upstream bearer profile.`,
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(upstreamBaseUrl);
    } catch {
      return {
        ok: false,
        reason: `${ENV_UPSTREAM_BASE_URL} '${upstreamBaseUrl}' is not a valid URL`,
      };
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      return {
        ok: false,
        reason: `${ENV_UPSTREAM_BASE_URL} must not contain URL credentials`,
      };
    }
    const loopback = isLoopbackHost(parsed.hostname);
    if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
      return {
        ok: false,
        reason:
          `${ENV_UPSTREAM_BASE_URL} must use https:// for non-loopback ` +
          `endpoints (http:// is allowed only on loopback).`,
      };
    }

    return {
      ok: true,
      config: {
        baseUrl: parsed.origin,
        bearerToken: upstreamToken,
        authMode: "upstream-bearer",
        allowWrite,
      },
    };
  }

  const rawBaseUrl = resolve(
    ENV_BASE_URL,
    processEnv,
    legacyFileEnv,
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
        `Use the upstream ${ENV_UPSTREAM_BASE_URL}/${ENV_UPSTREAM_TOKEN} ` +
        `contract for a remote static-OIDC consumer.`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `${ENV_BASE_URL} must use http:// or https://`,
    };
  }

  const apiKey = resolve(ENV_API_KEY, processEnv, legacyFileEnv, "");
  if (apiKey.length === 0) {
    return {
      ok: false,
      reason:
        `${ENV_API_KEY} is required for local expertise-client calls. ` +
        `Set it in the environment or in the extension's .env.local.`,
    };
  }

  return {
    ok: true,
    config: {
      baseUrl: parsed.origin,
      bearerToken: apiKey,
      authMode: "local-api-key",
      allowWrite,
    },
  };
}

/** Fixed upstream secrets path, with an explicit process-env override. */
export function resolveUpstreamSecretsPath(processEnv: EnvMap): string {
  return resolve(
    ENV_UPSTREAM_SECRETS_FILE,
    processEnv,
    {},
    DEFAULT_UPSTREAM_SECRETS_FILE,
  );
}

/** Load the operator-owned upstream consumer file; missing means no values. */
export function loadUpstreamSecrets(processEnv: EnvMap): Record<string, string> {
  return loadEnvLocal(resolveUpstreamSecretsPath(processEnv));
}

/** Safe, token-free guidance for a 401 under the static-OIDC bearer profile. */
export function authFailureGuidance(config: ClientConfig): string {
  if (config.authMode !== "upstream-bearer") return "";
  return (
    ` The configured ${ENV_UPSTREAM_TOKEN} may be expired or invalid; ` +
    `mint a replacement with agent-expertise-api scripts/mint_token.py and ` +
    `update the operator-owned secrets file.`
  );
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
