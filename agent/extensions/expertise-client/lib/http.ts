/**
 * expertise-client — bounded HTTP helpers (ADR-0028).
 *
 * Thin GET/POST wrappers around the configured loopback API. They:
 *   - inject the `x-api-key` credential (never echoed back to callers);
 *   - refuse to follow redirects (`redirect: "error"`) so an unexpected 3xx
 *     cannot bounce the request off-loopback;
 *   - bound the response body to MAX_BODY_BYTES.
 *
 * `fetchImpl` is injectable so tests never touch the network.
 */

import type { ClientConfig } from "./config.ts";

export const MAX_BODY_BYTES = 262144; // 256 KB

export interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  truncated: boolean;
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
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    text,
    truncated,
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
      "x-api-key": config.apiKey,
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
      "x-api-key": config.apiKey,
      accept: "application/json",
      "content-type": "application/json",
      ...(options.extraHeaders ?? {}),
    },
    body: JSON.stringify(options.body ?? {}),
  };
  if (options.signal) init.signal = options.signal;

  const res = await doFetch(url, init);
  return boundResponse(res);
}
