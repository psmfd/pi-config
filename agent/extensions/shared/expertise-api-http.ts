/**
 * expertise-client — bounded HTTP helpers (ADR-0028).
 *
 * Thin GET/POST wrappers around the configured loopback API. They:
 *   - inject the `Authorization: Bearer` credential (never echoed back to
 *     callers) — the only scheme agent-expertise-api's ApiKeyAuthHandler
 *     accepts (#486);
 *   - refuse to follow redirects (`redirect: "error"`) so an unexpected 3xx
 *     cannot bounce the request off-loopback;
 *   - bound the response body to MAX_BODY_BYTES.
 *
 * `fetchImpl` is injectable so tests never touch the network.
 */

import type { ClientConfig } from "./expertise-api-config.ts";

export const MAX_BODY_BYTES = 262144; // 256 KB

export interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  truncated: boolean;
  /** Value of the `Retry-After` response header, when the server sent one (e.g. on 429). */
  retryAfter?: string;
}

export interface ApiGetOptions {
  searchParams?: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ApiPostOptions {
  body?: unknown;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Bounded slice of an error-response body for diagnostics (e.g. ProblemDetails
 * `title`/`status`; `detail` is scrubbed outside Development server-side).
 * Returns an empty string for an empty body, else ` — <slice>` for appending
 * to a refusal reason.
 */
export function errorDetail(text: string, cap = 500): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const slice = trimmed.length > cap ? `${trimmed.slice(0, cap)}…` : trimmed;
  return ` — ${slice}`;
}

/** Bound a response body to MAX_BODY_BYTES and shape an `ApiResponse`. */
async function boundResponse(res: Response): Promise<ApiResponse> {
  const raw = await res.text();
  const buf = Buffer.from(raw, "utf-8");
  let text = raw;
  let truncated = false;
  if (buf.byteLength > MAX_BODY_BYTES) {
    text = buf.subarray(0, MAX_BODY_BYTES).toString("utf-8");
    truncated = true;
  }
  const retryAfter = res.headers?.get?.("retry-after");
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    text,
    truncated,
    ...(retryAfter ? { retryAfter } : {}),
  };
}

/**
 * Perform an authenticated GET against `<baseUrl><path>`. Throws on network
 * failure (callers translate to a refusal); returns a bounded `ApiResponse`
 * on any HTTP status.
 */
export async function apiGet(
  config: ClientConfig,
  path: string,
  options: ApiGetOptions = {},
): Promise<ApiResponse> {
  const doFetch = options.fetchImpl ?? fetch;

  const url = new URL(path, config.baseUrl);
  if (options.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      url.searchParams.set(k, v);
    }
  }

  const init: RequestInit = {
    method: "GET",
    redirect: "error",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      accept: "application/json",
    },
  };
  if (options.signal) init.signal = options.signal;

  const res = await doFetch(url, init);
  return boundResponse(res);
}

/**
 * Perform an authenticated POST against `<baseUrl><path>`. Throws on network
 * failure (callers translate to a refusal); returns a bounded `ApiResponse`
 * on any HTTP status. The JSON body is sent with `content-type: application/
 * json`; `extraHeaders` carries per-request headers such as `Idempotency-Key`.
 */
export async function apiPost(
  config: ClientConfig,
  path: string,
  options: ApiPostOptions = {},
): Promise<ApiResponse> {
  const doFetch = options.fetchImpl ?? fetch;

  const url = new URL(path, config.baseUrl);

  const init: RequestInit = {
    method: "POST",
    redirect: "error",
    headers: {
      // Per-request extras (e.g. Idempotency-Key) are spread FIRST so the
      // baseline credential / content-type headers below always win — a caller
      // (or future caller) cannot clobber `authorization` or `content-type` via
      // extraHeaders. Last-write-wins on object literals (#323).
      ...(options.extraHeaders ?? {}),
      authorization: `Bearer ${config.apiKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(options.body ?? {}),
  };
  if (options.signal) init.signal = options.signal;

  const res = await doFetch(url, init);
  return boundResponse(res);
}
