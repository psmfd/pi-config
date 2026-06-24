/**
 * expertise-client — `/health/ready` preflight (ADR-0028).
 *
 * Every tool call gates on readiness first so a not-yet-ready local API
 * surfaces a clear, fail-closed refusal instead of a confusing mid-call
 * error. Readiness is liveness evidence only — it is NOT proof of
 * authentication (the endpoint is unauthenticated upstream).
 */

import type { ClientConfig } from "./config.ts";
import { apiGet } from "./http.ts";

export const HEALTH_READY_PATH = "/health/ready";

export type HealthResult = { ready: true } | { ready: false; reason: string };

export interface HealthOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Probe `/health/ready`; fail closed on any non-200 or network error. */
export async function checkReady(
  config: ClientConfig,
  options: HealthOptions = {},
): Promise<HealthResult> {
  try {
    const res = await apiGet(config, HEALTH_READY_PATH, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (res.status === 200) return { ready: true };
    return {
      ready: false,
      reason: `${HEALTH_READY_PATH} returned HTTP ${res.status} ${res.statusText}`,
    };
  } catch (err) {
    return {
      ready: false,
      reason: `${HEALTH_READY_PATH} unreachable: ${(err as Error).message}`,
    };
  }
}
