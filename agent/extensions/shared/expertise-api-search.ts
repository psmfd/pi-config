/**
 * expertise-client — read-side `expertise_search` (ADR-0028).
 *
 * Targets the SEMANTIC search endpoint of agent-expertise-api
 * (`GET /expertise/search/semantic`), verified against the live API and the
 * server source at v1.1.0 (#489) and re-verified unchanged at v1.4.1
 * (2026-07-10): query param is `q`, `limit` is clamped server-side to
 * [1, 100], and the endpoint is governed by a token-bucket rate limit of
 * 10 requests/min per principal (429 with Retry-After, no queuing). v1.3.0
 * added an optional `includeDeprecated` query param — deliberately not
 * exposed, same phase-1 rationale as the keyword FTS endpoint
 * (`/expertise/search`, `q` + `includeDeprecated`), which is also unexposed.
 */

import type { ClientConfig } from "./expertise-api-config.ts";
import { apiGet, errorDetail } from "./expertise-api-http.ts";

export const SEARCH_PATH = "/expertise/search/semantic";

/** Server clamps `limit` to this range; we clamp client-side to match. */
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;

export interface SearchParams {
  query: string;
  limit?: number;
}

export type SearchResult =
  | { ok: true; status: number; text: string; truncated: boolean }
  | {
      ok: false;
      reason: string;
      /** Set on HTTP 429 so programmatic callers (the fanout gate's session
       * backoff, ADR-0095) need not sniff the prose reason. */
      rateLimited?: boolean;
      /** Parsed integer `Retry-After` seconds, when the server sent one. */
      retryAfterSeconds?: number;
    };

export interface SearchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Query expertise entries. Read-only; never mutates API state. */
export async function searchExpertise(
  config: ClientConfig,
  params: SearchParams,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const searchParams: Record<string, string> = { q: params.query };
  if (params.limit !== undefined && Number.isFinite(params.limit)) {
    searchParams.limit = String(
      Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.trunc(params.limit))),
    );
  }

  try {
    const res = await apiGet(config, SEARCH_PATH, {
      searchParams,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (res.status === 429) {
      const retryNote = res.retryAfter
        ? `Retry after ${res.retryAfter}s.`
        : "Wait before retrying.";
      const retryAfterSeconds =
        res.retryAfter && /^\d+$/.test(res.retryAfter.trim())
          ? Number.parseInt(res.retryAfter.trim(), 10)
          : undefined;
      return {
        ok: false,
        reason:
          `expertise search is rate-limited (HTTP 429): the semantic endpoint ` +
          `allows 10 requests/min and each call runs model inference. ` +
          `${retryNote} Do not retry immediately.`,
        rateLimited: true,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason:
          `expertise search returned HTTP ${res.status} ${res.statusText}` +
          errorDetail(res.text),
      };
    }
    return {
      ok: true,
      status: res.status,
      text: res.text,
      truncated: res.truncated,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `expertise search request failed: ${(err as Error).message}`,
    };
  }
}
