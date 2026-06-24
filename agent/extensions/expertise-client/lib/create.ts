/**
 * expertise-client — create-only write path `expertise_create` (ADR-0028, #318).
 *
 * Transport-only: POSTs a single expertise entry to the local API. The exact
 * route and body schema are upstream contract ASSUMPTIONS (tracked under #149),
 * centralized here so a single edit re-points them once the API surface is
 * frozen. Mutating semantics are strictly create-only — no update, delete,
 * archive, or approve.
 *
 * Idempotency: a fresh `Idempotency-Key` is generated per create request via
 * `crypto.randomUUID()`. This matches ADR-0028 ("generated per create
 * request"). It does NOT provide cross-call retry de-duplication — two
 * identical create bodies sent as two calls produce two distinct keys and two
 * entries. Do not "fix" this toward content-hash keying without a contract
 * decision (#149).
 */

import { randomUUID } from "node:crypto";

import type { ClientConfig } from "./config.ts";
import { apiPost } from "./http.ts";

export const CREATE_PATH = "/expertise";

/**
 * Create-entry shape. Conservative, named parameter set passed as JSON.
 * Documented as an assumption pending the frozen upstream schema (#149).
 */
export interface CreateParams {
  /** Required. Short title of the expertise entry. */
  title: string;
  /** Required. Body content of the entry. */
  content: string;
  /** Optional. Free-form tags. */
  tags?: string[];
  /** Optional. Provenance, e.g. "pi-session". */
  source?: string;
}

export type CreateResult =
  | { ok: true; status: number; text: string; truncated: boolean }
  | { ok: false; reason: string };

export interface CreateOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Create a single expertise entry. Create-only; never updates or deletes. */
export async function createExpertise(
  config: ClientConfig,
  params: CreateParams,
  options: CreateOptions = {},
): Promise<CreateResult> {
  const body: CreateParams = {
    title: params.title,
    content: params.content,
    ...(params.tags !== undefined ? { tags: params.tags } : {}),
    ...(params.source !== undefined ? { source: params.source } : {}),
  };

  try {
    const res = await apiPost(config, CREATE_PATH, {
      body,
      extraHeaders: { "Idempotency-Key": randomUUID() },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `expertise create returned HTTP ${res.status} ${res.statusText}`,
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
      reason: `expertise create request failed: ${(err as Error).message}`,
    };
  }
}
