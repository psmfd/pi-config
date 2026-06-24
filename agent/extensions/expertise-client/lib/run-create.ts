/**
 * expertise-client — create orchestration seam (ADR-0028, #318).
 *
 * `runCreate` owns the create-path policy ladder so it can be covered by fast,
 * hermetic unit tests without constructing the full pi tool object — the same
 * way the search path is testable. `createExpertise` stays pure/transport-only.
 *
 * Order (fail fast, no network call until the gates pass):
 *   1. allowWrite gate     — refuse unless PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1
 *   2. body-secret scan    — refuse if the body carries a credential pattern
 *   3. checkReady          — /health/ready preflight
 *   4. createExpertise     — POST the entry
 *
 * `checkReady`, `createExpertise`, and `scanForSecrets` are injected so tests
 * stay fast and hermetic.
 */

import type { ClientConfig } from "./config.ts";
import type { CreateParams, CreateResult } from "./create.ts";
import { createExpertise } from "./create.ts";
import { checkReady } from "./health.ts";
import { scanForSecrets } from "./secret-scan.ts";

export type RunCreateResult =
  | { ok: true; status: number; text: string; truncated: boolean }
  | { ok: false; reason: string };

export interface RunCreateDeps {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  checkReady?: typeof checkReady;
  createExpertise?: typeof createExpertise;
  scanForSecrets?: typeof scanForSecrets;
}

export async function runCreate(
  config: ClientConfig,
  params: CreateParams,
  deps: RunCreateDeps = {},
): Promise<RunCreateResult> {
  const doCheckReady = deps.checkReady ?? checkReady;
  const doCreate = deps.createExpertise ?? createExpertise;
  const doScan = deps.scanForSecrets ?? scanForSecrets;

  // 1. Write opt-in gate.
  if (!config.allowWrite) {
    return {
      ok: false,
      reason:
        "local write is disabled. Set PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1 " +
        "to opt in to create-only writes (ADR-0028).",
    };
  }

  // 2. Body-secret guard — refuse if the body carries a credential pattern.
  //    Category names only; never echo the matched secret value.
  const categories = doScan(params);
  if (categories.length > 0) {
    return {
      ok: false,
      reason:
        `create body appears to contain a credential ` +
        `(${categories.join(", ")}). Refusing to publish a secret into an ` +
        `expertise entry. Remove the credential and retry.`,
    };
  }

  // 3. Readiness preflight.
  const health = await doCheckReady(config, {
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!health.ready) {
    return { ok: false, reason: `API not ready — ${health.reason}` };
  }

  // 4. Create.
  const result: CreateResult = await doCreate(config, params, {
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return result;
}
