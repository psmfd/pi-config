/**
 * CI-status widget: line formatting and poll policy (ADR-0140, #987).
 *
 * Deliberately free of every pi and pi-tui type. The widget is repo-dash's
 * first *standing background activity* — everything before it ran only when the
 * operator pressed a key — so the parts worth getting right are the parts that
 * decide whether a `gh` process is spawned at all: the idle gate, the
 * single-flight guard, the interval floor, and the failure backoff. Those live
 * here, behind injected `now`/`isIdle`/`load` seams, so each can be tested
 * against a fake clock rather than inferred from a running terminal.
 *
 * `index.ts` owns the timer and the `ctx.ui.setWidget` call; this module owns
 * when a poll is allowed and what the lines say.
 */

import type { DashRunRow } from "./data.ts";
import { deriveRunOutcome, describeRunOutcome, glyphForRunOutcome } from "./run-status.ts";

/**
 * Seconds between polls while the session sits idle.
 *
 * The budget this spends is the point of the number, so it is recorded rather
 * than tuned by feel. GitHub's authenticated REST limit is 5000 requests/hour;
 * one poll per minute is 60/hour, or 1.2% of that budget, against the same
 * token `github-read`'s model-facing tools draw on. A 10s interval would be
 * 7.2% for information that changes on the order of minutes.
 *
 * This is also the *floor*, not merely the period: `agent_settled` calls `tick`
 * on the same eligibility check, so an operator running many short turns cannot
 * drive polling faster than this.
 */
export const POLL_INTERVAL_MS = 60_000;

/** Ceiling for failure backoff — roughly four polls' worth of silence. */
export const MAX_BACKOFF_MS = 15 * 60_000;

/** After this long without a successful poll, the displayed data is marked stale. */
export const STALE_AFTER_MS = 5 * 60_000;

/** Distinct workflows shown. Beyond a handful the line stops being glanceable. */
const MAX_WORKFLOWS = 4;

/** Code-point bound on each workflow/branch name inside a widget line. */
const NAME_LIMIT = 20;

/** One successful read of the recent runs. */
export interface CiSnapshot {
  readonly rows: readonly DashRunRow[];
  readonly fetchedAtMs: number;
  /**
   * Branch this snapshot was scoped to, when scoping succeeded (#1005).
   *
   * Carried on the snapshot rather than passed alongside it so the empty case
   * can name the branch: "no recent runs" and "no recent runs for `dev`" are
   * different claims, and on a freshly pushed branch the second is the true
   * and useful one. Absent means the read was repository-wide.
   */
  readonly branch?: string;
}

/**
 * Bound a display fragment by code points.
 *
 * Code points rather than UTF-16 units for the same reason `sanitizeTitle`
 * counts them: `.slice` on units severs a surrogate pair and emits a lone
 * surrogate. Content reaching here is already `stripUnsafe`d at the data
 * boundary, so this is a width concern only, not a safety one.
 */
function clip(value: string, limit: number): string {
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return `${points.slice(0, limit - 1).join("")}…`;
}

/**
 * Reduce a run list to the newest run per workflow.
 *
 * Sorted defensively by `updatedAt` rather than trusting the API's ordering:
 * the Actions endpoint returns most-recent-first today, but the widget's whole
 * claim is "this is the current state", and silently depending on an unstated
 * ordering is how that claim would become false without anything failing.
 * Timestamps are ISO-8601, so a lexicographic compare is a chronological one;
 * a row with an empty `updatedAt` sorts last rather than winning its workflow.
 */
export function latestPerWorkflow(rows: readonly DashRunRow[], limit: number = MAX_WORKFLOWS): DashRunRow[] {
  const newestFirst = [...rows].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const seen = new Set<string>();
  const picked: DashRunRow[] = [];
  for (const row of newestFirst) {
    const key = row.workflowName || String(row.id);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(row);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** Render an age as a short human string; the widget has no room for precision. */
export function formatAge(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Build the widget's lines.
 *
 * Returns `undefined` when there is nothing to say — no snapshot and no error —
 * so a freshly enabled widget reserves no vertical space until it has something
 * to show, rather than flashing a placeholder above the editor.
 *
 * A stale snapshot is shown *with* a staleness marker rather than blanked. An
 * empty widget reads as "CI is fine"; a marked-stale one reads as "this is the
 * last thing I could see", which is the honest claim when polling is failing.
 *
 * Branch handling reflects what this widget can actually promise. It is not
 * scoped to the session's branch — pi exposes the git branch only through
 * `setFooter`'s data provider (#1005) — so when the visible runs span more than
 * one branch, each entry carries its own `@branch` rather than letting a single
 * trailing branch imply a filter that is not applied.
 */
export function formatWidgetLines(
  snapshot: CiSnapshot | undefined,
  nowMs: number,
  error?: string,
): string[] | undefined {
  if (!snapshot) {
    return error ? [`CI  ? unavailable — ${clip(error, 60)}`] : undefined;
  }
  if (snapshot.rows.length === 0) {
    // Scoped-and-empty is not the same statement as repo-is-quiet, and on a
    // branch that has just been pushed it is the one the operator needs. There
    // is deliberately no fall back to the repository-wide view here: showing
    // other branches' runs under a scoped widget would be the misleading
    // outcome scoping exists to remove.
    return snapshot.branch
      ? [`CI  no recent runs for ${clip(snapshot.branch, NAME_LIMIT)}`]
      : ["CI  no recent workflow runs"];
  }

  const rows = latestPerWorkflow(snapshot.rows);
  const branches = new Set(rows.map((row) => row.headBranch).filter((branch) => branch.length > 0));
  // With scoping in force every row shares one branch, so this collapses to
  // false on its own and the branch is reported once on the detail line — the
  // per-entry form stays for the unscoped case, where it is what stops a single
  // trailing branch from implying a filter that was never applied.
  const perEntryBranch = branches.size > 1;

  const entries = rows.map((row) => {
    const glyph = glyphForRunOutcome(deriveRunOutcome(row.status, row.conclusion));
    const name = clip(row.workflowName || "workflow", NAME_LIMIT);
    return perEntryBranch && row.headBranch
      ? `${glyph} ${name}@${clip(row.headBranch, NAME_LIMIT)}`
      : `${glyph} ${name}`;
  });

  const ageMs = Math.max(0, nowMs - snapshot.fetchedAtMs);
  const detail: string[] = [];
  if (!perEntryBranch && branches.size === 1) detail.push(clip([...branches][0] ?? "", NAME_LIMIT));
  detail.push(formatAge(ageMs));
  if (ageMs >= STALE_AFTER_MS) detail.push(error ? `stale — ${clip(error, 40)}` : "stale");

  return [`CI  ${entries.join(" · ")}`, `    ${detail.join(" · ")}`];
}

/** One-line summary for `/ci widget status`, which has no width constraint. */
export function describeWidgetState(
  enabled: boolean,
  snapshot: CiSnapshot | undefined,
  nowMs: number,
  error?: string,
): string {
  if (!enabled) return "repo-dash CI widget: OFF";
  if (!snapshot) return `repo-dash CI widget: ON — ${error ? `last poll failed: ${error}` : "no data yet"}`;
  const rows = latestPerWorkflow(snapshot.rows);
  const summary = rows.length > 0
    ? rows.map((row) => `${row.workflowName || "workflow"} ${describeRunOutcome(deriveRunOutcome(row.status, row.conclusion))}`).join(", ")
    : "no recent runs";
  const age = formatAge(Math.max(0, nowMs - snapshot.fetchedAtMs));
  return `repo-dash CI widget: ON — ${summary} (${age})${error ? ` — last poll failed: ${error}` : ""}`;
}

/**
 * What one load produced: the rows, and the branch they were scoped to.
 *
 * The branch rides back with the rows rather than being read from caller state
 * so the snapshot is self-describing — a snapshot always records the scope it
 * was taken under, even if the caller's idea of the branch changed afterwards.
 */
export interface CiLoadResult {
  readonly rows: readonly DashRunRow[];
  readonly branch?: string;
}

/** Injected seams so the poller is testable without a clock, a UI, or `gh`. */
export interface PollerDeps {
  readonly load: () => Promise<CiLoadResult>;
  readonly emit: (lines: string[] | undefined) => void;
  readonly now: () => number;
  readonly isIdle: () => boolean;
}

/**
 * Decides when to spawn `gh`, and holds the last thing it saw.
 *
 * `stop()` deliberately does **not** emit. Clearing the widget is the caller's
 * job, because the caller is also the thing that knows whether the UI context
 * is still alive — an emit-on-stop would recurse straight back into `stop()`
 * when the reason for stopping is that emitting just threw.
 */
export class CiWidgetPoller {
  private snapshot: CiSnapshot | undefined;
  private lastError: string | undefined;
  private failures = 0;
  private inFlight = false;
  private nextEligibleMs = 0;
  private stopped = false;

  constructor(private readonly deps: PollerDeps) {}

  /** The last successful read, for `/ci widget status`. */
  getSnapshot(): CiSnapshot | undefined {
    return this.snapshot;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  /** Repaint from existing state. Never fetches; safe to call at any time. */
  render(): void {
    if (this.stopped) return;
    this.deps.emit(formatWidgetLines(this.snapshot, this.deps.now(), this.lastError));
  }

  /**
   * Poll if allowed, then repaint.
   *
   * Called from both the interval and `agent_settled`, on purpose: they share
   * one eligibility check, so the edge trigger delivers a fresh read the moment
   * a long turn ends without letting a burst of short turns poll faster than
   * `POLL_INTERVAL_MS`.
   *
   * The three refusals are ordered cheapest-first and each is load-bearing:
   *
   * 1. **Not idle** — the constraint #987 calls the point of the feature.
   *    Spawning `gh` mid-turn competes with the agent's own tool calls for the
   *    same rate limit.
   * 2. **In flight** — a slow `gh` (or a hung network) must not accumulate
   *    overlapping children as the interval keeps firing.
   * 3. **Too soon** — the interval floor, which also carries failure backoff.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.deps.isIdle()) return;
    if (this.inFlight) return;

    const now = this.deps.now();
    if (now < this.nextEligibleMs) {
      // Still repaint: the age and staleness marker are functions of the clock,
      // not of the data, so they must advance between fetches.
      this.render();
      return;
    }

    this.inFlight = true;
    try {
      const loaded = await this.deps.load();
      if (this.stopped) return;
      this.snapshot = {
        rows: loaded.rows,
        fetchedAtMs: this.deps.now(),
        ...(loaded.branch ? { branch: loaded.branch } : {}),
      };
      this.lastError = undefined;
      this.failures = 0;
      this.nextEligibleMs = this.deps.now() + POLL_INTERVAL_MS;
    } catch (error) {
      if (this.stopped) return;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.failures += 1;
      // Backoff applies to every failure, not only 403/429. Telling a rate-limit
      // rejection apart from a network error means parsing `gh` stderr, and
      // backing off on both is the strictly safer read: the cost is a slower
      // recovery from a transient blip, and the alternative cost is hammering an
      // endpoint that is already refusing us. The prior snapshot is deliberately
      // retained so the widget degrades to marked-stale rather than blank.
      this.nextEligibleMs = this.deps.now()
        + Math.min(POLL_INTERVAL_MS * 2 ** this.failures, MAX_BACKOFF_MS);
    } finally {
      this.inFlight = false;
    }
    this.render();
  }

  /** Permanently disable this poller. Idempotent; emits nothing. */
  stop(): void {
    this.stopped = true;
  }
}
