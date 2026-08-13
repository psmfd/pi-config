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

/** Panels list open items only; the whole point is a glanceable working set. */
const PANEL_LIMIT = 50;

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
