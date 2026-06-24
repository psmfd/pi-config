/**
 * expertise-client — configuration resolution + trust-boundary validation
 * (ADR-0028).
 *
 * Resolves the base URL, API key, and write opt-in with precedence
 * `process.env` > `.env.local` > built-in defaults, then enforces the
 * phase-1 invariants:
 *   - the base URL must resolve to LOOPBACK (no remote/team endpoints yet);
 *   - an API key is REQUIRED for every call (loopback is a network locality
 *     boundary, not an authentication boundary).
 *
 * Endpoint/credential values are never read from project/repo settings — only
 * from `process.env` and the fixed extension-local `.env.local`.
 */

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

export const ENV_BASE_URL = "PI_EXPERTISE_API_BASE_URL";
export const ENV_API_KEY = "PI_EXPERTISE_API_KEY";
export const ENV_ALLOW_WRITE = "PI_EXPERTISE_ALLOW_LOCALDEV_WRITE";

/** Resolved, validated client configuration. */
export interface ClientConfig {
  /** Loopback origin, e.g. `http://127.0.0.1:8080`. */
  baseUrl: string;
  /** API key for `x-api-key`. Never logged or surfaced. */
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
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) return true;
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
