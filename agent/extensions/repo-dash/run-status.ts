/**
 * Workflow-run outcome derivation (ADR-0137, #987).
 *
 * Pure, TUI-free, and deliberately the ONLY place a run's `status`/`conclusion`
 * pair is collapsed into one displayable outcome. The `/ci` panel and the
 * CI-status widget both call this: two independent derivations would eventually
 * disagree about the same run, and the disagreement would show up as a widget
 * claiming success next to a panel row that says otherwise.
 *
 * The distinction this exists to preserve is the one #987 names: a `completed`
 * run can be a failure. `status` says whether the run finished; `conclusion`
 * says how. Mapping `conclusion` onto `state` — the shape the issue/PR rows
 * use — would lose exactly the bit that matters.
 */

/** What the operator actually needs to know about a run, in one value. */
export type RunOutcome =
  | "queued"
  | "in_progress"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "stale"
  | "unknown";

/**
 * Conclusions GitHub documents for a completed run.
 *
 * An unrecognized value degrades to `unknown` rather than being passed through:
 * the API has grown conclusions before (`startup_failure`), and a value this
 * module has never seen must not be rendered as though it were understood.
 */
const KNOWN_CONCLUSIONS: ReadonlySet<string> = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
]);

/** Pre-completion statuses. GitHub also emits `waiting`/`requested`/`pending`. */
const PENDING_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "waiting",
  "requested",
  "pending",
  "in_progress",
]);

/**
 * Collapse a run's `status`/`conclusion` pair into one outcome.
 *
 * `conclusion` is null until `status === "completed"`, so it is only consulted
 * once the run has finished. A completed run with a null or unrecognized
 * conclusion is `unknown` — not `success`, which is the failure-open mistake
 * this function exists to make impossible.
 */
export function deriveRunOutcome(status: string, conclusion: string | null): RunOutcome {
  if (status !== "completed") {
    if (status === "in_progress") return "in_progress";
    return PENDING_STATUSES.has(status) ? "queued" : "unknown";
  }
  if (conclusion !== null && KNOWN_CONCLUSIONS.has(conclusion)) return conclusion as RunOutcome;
  return "unknown";
}

/** Single-word label for an outcome, for panel rows and widget lines alike. */
export function describeRunOutcome(outcome: RunOutcome): string {
  return outcome === "in_progress" ? "running" : outcome.replace(/_/g, " ");
}

/**
 * A one-character glyph for an outcome.
 *
 * ASCII only, deliberately: the widget renders into a terminal whose font and
 * width behaviour are unknown, and a wide emoji would shift the line. Colour is
 * not applied here — the panel and the widget theme their own output.
 */
export function glyphForRunOutcome(outcome: RunOutcome): string {
  switch (outcome) {
    case "success": return "+";
    case "failure": case "timed_out": return "x";
    case "in_progress": return ">";
    case "queued": return ".";
    case "cancelled": case "skipped": case "stale": return "-";
    case "action_required": return "!";
    case "neutral": case "unknown": return "?";
  }
}

/** Whether an outcome means the run finished unsuccessfully. */
export function isFailedOutcome(outcome: RunOutcome): boolean {
  return outcome === "failure" || outcome === "timed_out" || outcome === "action_required";
}
