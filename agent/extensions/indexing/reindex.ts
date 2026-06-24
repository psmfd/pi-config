/**
 * indexing/reindex.ts — idle-gated, single-flight background re-index.
 *
 * Fires `ccc index` after a prompt completes, but only when the session is idle
 * (`agent_end` + ctx.isIdle), only one at a time (single-flight lock), and at
 * most once per cooldown window. `ccc index` is incremental — a no-op when
 * nothing changed — so the cooldown is a courtesy throttle, not correctness.
 * The clock is injectable so the cooldown unit-tests deterministically.
 */

import type { DetachedLauncher } from "./types.ts";

export type ReindexOutcome =
  | "started"
  | "skipped-disabled"
  | "skipped-not-idle"
  | "skipped-in-flight"
  | "skipped-cooldown";

export interface ReindexerDeps {
  readonly launcher: DetachedLauncher;
  readonly binary: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Defaults to Date.now; injected in tests. */
  readonly now?: () => number;
  /** Minimum gap between re-index launches (ms). Default 60s. */
  readonly cooldownMs?: number;
}

export class Reindexer {
  private inFlight = false;
  private lastLaunchAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(private readonly deps: ReindexerDeps) {
    this.now = deps.now ?? Date.now;
    this.cooldownMs = deps.cooldownMs ?? 60_000;
  }

  get running(): boolean {
    return this.inFlight;
  }

  /**
   * Attempt a background re-index. `enabled` and `idle` are evaluated by the
   * caller (persisted toggle / session flag, and ctx.isIdle()) and passed in so
   * this stays a pure scheduler over its injected launcher + clock.
   */
  maybeReindex(enabled: boolean, idle: boolean): ReindexOutcome {
    if (!enabled) return "skipped-disabled";
    if (!idle) return "skipped-not-idle";
    if (this.inFlight) return "skipped-in-flight";
    const t = this.now();
    if (t - this.lastLaunchAt < this.cooldownMs) return "skipped-cooldown";

    this.inFlight = true;
    this.lastLaunchAt = t;
    const proc = this.deps.launcher(this.deps.binary, ["index"], {
      cwd: this.deps.cwd,
      env: this.deps.env,
    });
    proc.onExit(() => {
      this.inFlight = false;
    });
    return "started";
  }
}
