/**
 * repo-dash data layer (ADR-0137, #981).
 *
 * Every GitHub read on this path goes through the *same* shared plan builders
 * and the *same* `assertReadOnlyPlan` gate the model-facing `github-read` tools
 * use. repo-dash therefore inherits that argv safety rather than reimplementing
 * it — the whole reason the core was extracted to `shared/` instead of being
 * duplicated here.
 */

import { assertReadOnlyPlan, buildOperationPlan } from "../shared/github-read-catalog.ts";
import { parseAndProjectJson } from "../shared/github-read-formatting.ts";
import { runGh, sanitizeDiagnostic } from "../shared/github-read-runner.ts";
import type { GhRunResult, OperationPlan } from "../shared/github-read-types.ts";
import { stripUnsafe } from "./reference.ts";

/** Injectable runner seam so tests never spawn `gh`. */
export type GhRunner = (
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<GhRunResult>;

/**
 * What a panel needs from one issue or pull request.
 *
 * The free-text fields are sanitized at construction in `toRow`, so a `DashRow`
 * is safe to render or reference without any caller remembering to clean it.
 * That is the point: the sanitizer used to be applied only on the
 * reference-into-prompt path, which left `panel.ts` rendering raw titles into
 * the terminal — and pi-tui's `truncateToWidth` deliberately preserves ANSI
 * sequences and returns short strings byte-for-byte, so escapes in a title
 * reached the terminal intact (#989).
 */
export interface DashRow {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string;
  readonly updatedAt: string;
  readonly isDraft?: boolean;
}

export type DashKind = "issues" | "prs";

/**
 * What a panel needs from one workflow run (#987).
 *
 * Deliberately a **sibling** of `DashRow`, not a widening of it and not a union
 * arm. The two are never mixed in one collection — an `/issues` panel holds
 * only `DashRow`, a `/ci` panel only `DashRunRow` — so a union would just move
 * the optional-field problem into a `switch` at every read site, and widening
 * `DashRow` with `conclusion?`/`status?` would let an issue row carry run
 * fields the type system no longer objects to. `RepoDashPanel` is generic over
 * the row type instead; see `panel.ts`.
 *
 * `status` and `conclusion` are both kept, unmerged: collapsing them is
 * `run-status.ts`'s job, and doing it here would discard the distinction
 * between "finished" and "finished successfully".
 */
export interface DashRunRow {
  /** The run id — the API's primary key, and the only repo-unique handle. */
  readonly id: number;
  /** Per-workflow counter. Display only: NOT unique within a repository. */
  readonly runNumber: number;
  readonly workflowName: string;
  readonly displayTitle: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headBranch: string;
  readonly event: string;
  readonly actor: string;
  readonly updatedAt: string;
}

/** Panels list open items only; the whole point is a glanceable working set. */
const PANEL_LIMIT = 50;

/** Runs are noisier than issues; a shorter window is the glanceable one. */
const RUN_LIMIT = 20;

function fail(what: string, result: GhRunResult): never {
  throw new Error(`repo-dash ${what} failed: ${sanitizeDiagnostic(result.stderr) || `gh exited ${result.exitCode}`}`);
}

/**
 * Resolve the repository the session is sitting in.
 *
 * `validateRepository` in the shared validation layer demands an explicit
 * `owner/name` and deliberately performs no cwd derivation, so the panels have
 * to establish it first. `gh repo view` reads it from the cwd's remote.
 *
 * Note this plan is hand-built rather than produced by `buildOperationPlan` —
 * that function requires the repository this call exists to discover, so it
 * cannot serve here. It is still put through `assertReadOnlyPlan`, which is the
 * actual security control: `["repo", "view"]` is an allowlisted safe prefix, so
 * a shape drift in this vector fails closed exactly like any other.
 */
export async function resolveRepository(signal?: AbortSignal, run: GhRunner = runGh): Promise<string> {
  const plan: OperationPlan = {
    args: ["repo", "view", "--json", "nameWithOwner"],
    format: "json",
    containsUntrustedContent: false,
  };
  assertReadOnlyPlan(plan);
  const result = await run(plan.args, signal, 10_000);
  if (result.exitCode !== 0) fail("could not resolve the current repository", result);
  const parsed = parseAndProjectJson(result.stdout, ["nameWithOwner"]) as { nameWithOwner?: unknown };
  const name = parsed.nameWithOwner;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("repo-dash could not resolve the current repository: gh returned no nameWithOwner");
  }
  return name;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Map one projected `gh` record onto a panel row, tolerating absent fields. */
function toRow(raw: unknown): DashRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const number = record.number;
  if (typeof number !== "number" || !Number.isInteger(number)) return undefined;
  const author = record.author;
  const login = typeof author === "object" && author !== null
    ? asString((author as Record<string, unknown>).login)
    : "";
  // `title` and `author` are the two free-text fields here — everything an
  // attacker who can file an issue controls. `state` and `updatedAt` come from
  // fixed GitHub vocabularies and `updatedAt` is sliced to ten characters
  // before display, so they are left alone rather than nominally cleaned.
  const row: DashRow = {
    number,
    title: stripUnsafe(asString(record.title)),
    state: asString(record.state),
    author: stripUnsafe(login),
    updatedAt: asString(record.updatedAt),
    ...(typeof record.isDraft === "boolean" ? { isDraft: record.isDraft } : {}),
  };
  return row;
}

/**
 * Convert a projected `gh ... list --json` payload into panel rows.
 *
 * Exported for tests: this is where a GitHub response shape change would first
 * show up, and it must degrade to "fewer rows" rather than throwing — a panel
 * that dies on one malformed record is worse than one that omits it.
 */
export function toRows(parsed: unknown): DashRow[] {
  if (!Array.isArray(parsed)) return [];
  const rows: DashRow[] = [];
  for (const entry of parsed) {
    const row = toRow(entry);
    if (row) rows.push(row);
  }
  return rows;
}

/** Fetch the open issues or pull requests for a repository. */
export async function fetchRows(
  kind: DashKind,
  repository: string,
  signal?: AbortSignal,
  run: GhRunner = runGh,
): Promise<DashRow[]> {
  const plan = buildOperationPlan(kind === "issues" ? "issues" : "pull_requests", {
    operation: "list",
    repository,
    state: "open",
    limit: PANEL_LIMIT,
  });
  assertReadOnlyPlan(plan);
  const result = await run(plan.args, signal, plan.timeoutMs);
  if (result.exitCode !== 0) fail(`could not list ${kind}`, result);
  return toRows(parseAndProjectJson(result.stdout, plan.fields));
}

/** Map one projected workflow-run record onto a panel row. */
function toRunRow(raw: unknown): DashRunRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "number" || !Number.isInteger(id)) return undefined;
  const actor = record.actor;
  const login = typeof actor === "object" && actor !== null
    ? asString((actor as Record<string, unknown>).login)
    : "";
  const conclusion = record.conclusion;
  // Sanitized here for the same reason `toRow` sanitizes: the row is rendered
  // straight into the terminal and may ride into the prompt buffer. Four fields
  // are attacker-influenced free text — `display_title` is a commit message or
  // PR title; the run `name` can be set per-run via a workflow's `run-name:`,
  // which routinely interpolates that same text; branch names are chosen by
  // whoever pushes the branch or opens the fork PR; and the actor login follows
  // `toRow`'s existing defence-in-depth treatment of `author.login`. The rest —
  // status/conclusion/event enums, the numeric ids, and the ISO timestamp — are
  // fixed vocabularies and are deliberately left alone rather than nominally
  // cleaned.
  const row: DashRunRow = {
    id,
    runNumber: typeof record.run_number === "number" ? record.run_number : 0,
    workflowName: stripUnsafe(asString(record.name)),
    displayTitle: stripUnsafe(asString(record.display_title)),
    status: asString(record.status),
    conclusion: typeof conclusion === "string" ? conclusion : null,
    headBranch: stripUnsafe(asString(record.head_branch)),
    event: asString(record.event),
    actor: stripUnsafe(login),
    updatedAt: asString(record.updated_at),
  };
  return row;
}

/**
 * Convert a projected `actions/runs` payload into panel rows.
 *
 * The Actions API wraps its list in `{ total_count, workflow_runs: [...] }`
 * rather than returning a bare array the way `gh issue list` does, so this
 * cannot reuse `toRows`' `Array.isArray` guard — that check would silently
 * yield zero rows for every response. Same degradation contract as `toRows`:
 * a malformed record is dropped, never thrown on.
 */
export function toRunRows(parsed: unknown): DashRunRow[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const runs = (parsed as Record<string, unknown>).workflow_runs;
  if (!Array.isArray(runs)) return [];
  const rows: DashRunRow[] = [];
  for (const entry of runs) {
    const row = toRunRow(entry);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Fetch recent workflow runs, optionally scoped to one branch.
 *
 * `branch` is optional by design: a detached HEAD has no branch to filter on,
 * and an unfiltered repository-wide list is the useful degradation rather than
 * an error.
 */
export async function fetchRuns(
  repository: string,
  branch?: string,
  signal?: AbortSignal,
  run: GhRunner = runGh,
  limit: number = RUN_LIMIT,
): Promise<DashRunRow[]> {
  const plan = buildOperationPlan("actions", {
    operation: "runs",
    repository,
    limit,
    ...(branch ? { ref: branch } : {}),
  });
  assertReadOnlyPlan(plan);
  const result = await run(plan.args, signal, plan.timeoutMs);
  if (result.exitCode !== 0) fail("could not list workflow runs", result);
  return toRunRows(parseAndProjectJson(result.stdout, plan.fields));
}
