/**
 * expertise-client — read-side `expertise_search` (ADR-0028).
 *
 * Phase-1 search path against the local API. The exact route is an upstream
 * contract assumption documented in README.md § Assumptions and is centralized
 * here so a single edit re-points it once the API surface is frozen.
 */

import type { ClientConfig } from "./config.ts";
import { apiGet } from "./http.ts";

export const SEARCH_PATH = "/expertise/search";

export interface SearchParams {
  query: string;
  limit?: number;
}

export type SearchResult =
  | { ok: true; status: number; text: string; truncated: boolean }
  | { ok: false; reason: string };

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
  const searchParams: Record<string, string> = { query: params.query };
  if (params.limit !== undefined && Number.isFinite(params.limit)) {
    searchParams.limit = String(Math.max(1, Math.trunc(params.limit)));
  }

  try {
    const res = await apiGet(config, SEARCH_PATH, {
      searchParams,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `expertise search returned HTTP ${res.status} ${res.statusText}`,
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
