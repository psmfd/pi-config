/**
 * repo-dash TUI panel (ADR-0137, #981; generalized for #987).
 *
 * First `ctx.ui.custom` consumer in this repo. Two contracts are load-bearing
 * and neither is obvious from the type signatures:
 *
 * 1. `Container` implements `render`/`invalidate` but **not** `handleInput` —
 *    it does not forward input to its children. A panel that merely extends
 *    Container renders correctly and is completely unresponsive. Input
 *    forwarding is therefore explicit below.
 * 2. `SelectList.handleInput` only claims up/down/confirm/cancel. Plain
 *    characters pass through untouched, which is what leaves `c` free to act as
 *    the reference-into-prompt key without fighting the list.
 *
 * The panel is **generic over the row type**. Everything structural here —
 * input forwarding, settle-once, the select list — is row-agnostic; only
 * display and reference-building vary between issues/PRs and workflow runs.
 * Parameterizing keeps `DashRow` and `DashRunRow` as unrelated types: no
 * discriminated union to `switch` on at every read site, and no optional-field
 * widening that would let an issue row silently carry a run's `conclusion`.
 */

import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";

import type { DashKind, DashRow, DashRunRow } from "./data.ts";
import { formatReference, formatRunReference } from "./reference.ts";
import { deriveRunOutcome, describeRunOutcome, glyphForRunOutcome } from "./run-status.ts";

/** Rows visible at once before the list scrolls. */
const MAX_VISIBLE = 12;

/** The reference-into-prompt key, mirroring GitHub Copilot CLI's `c`. */
const REFERENCE_KEY = "c";

/**
 * Everything a panel needs to know that depends on what a row *is*.
 *
 * Adding a third panel kind costs one more spec object rather than a new arm
 * threaded through every function in this file.
 */
export interface DashPanelSpec<T> {
  /** Heading when there is at least one row. */
  readonly heading: string;
  /** Heading when the list is empty. */
  readonly emptyHeading: string;
  /** Stable per-row handle; `SelectItem.value` round-trips through this. */
  keyOf(row: T): string;
  toSelectItem(row: T): SelectItem;
  buildReference(row: T): string;
}

function withKeys(heading: string): string {
  return `${heading} — enter or ${REFERENCE_KEY} to reference, esc to close`;
}

// --- issues / pull requests --------------------------------------------------

const ITEM_HEADINGS: Readonly<Record<DashKind, string>> = {
  issues: "Open issues",
  prs: "Open pull requests",
};

function describeItem(row: DashRow): string {
  const parts: string[] = [];
  if (row.isDraft) parts.push("draft");
  if (row.state) parts.push(row.state.toLowerCase());
  if (row.author) parts.push(`@${row.author}`);
  if (row.updatedAt) parts.push(row.updatedAt.slice(0, 10));
  return parts.join(" · ");
}

/**
 * Build the select items for a set of issue/PR rows.
 *
 * Exported so the label/description shaping is testable without a terminal.
 */
export function toSelectItems(rows: readonly DashRow[]): SelectItem[] {
  return rows.map((row) => itemSpec("issues").toSelectItem(row));
}

export function itemSpec(kind: DashKind): DashPanelSpec<DashRow> {
  return {
    heading: withKeys(ITEM_HEADINGS[kind]),
    emptyHeading: `${ITEM_HEADINGS[kind]} — none found, esc to close`,
    keyOf: (row) => String(row.number),
    toSelectItem: (row) => ({
      value: String(row.number),
      label: `#${row.number} ${row.title}`.trim(),
      description: describeItem(row),
    }),
    buildReference: (row) => formatReference(row.number, row.title),
  };
}

// --- workflow runs -----------------------------------------------------------

function describeRun(row: DashRunRow): string {
  const parts: string[] = [describeRunOutcome(deriveRunOutcome(row.status, row.conclusion))];
  if (row.headBranch) parts.push(row.headBranch);
  if (row.event) parts.push(row.event);
  if (row.actor) parts.push(`@${row.actor}`);
  if (row.updatedAt) parts.push(row.updatedAt.slice(0, 10));
  return parts.join(" · ");
}

/**
 * Build the select items for a set of run rows.
 *
 * The label leads with the outcome glyph because that is the one thing the
 * operator is scanning for; `run_number` is shown for human recognition but is
 * never the handle — see `formatRunReference`.
 */
export function toRunSelectItems(rows: readonly DashRunRow[]): SelectItem[] {
  return rows.map((row) => runSpec.toSelectItem(row));
}

export const runSpec: DashPanelSpec<DashRunRow> = {
  heading: withKeys("Recent workflow runs"),
  emptyHeading: "Recent workflow runs — none found, esc to close",
  keyOf: (row) => String(row.id),
  toSelectItem: (row) => ({
    value: String(row.id),
    label: `${glyphForRunOutcome(deriveRunOutcome(row.status, row.conclusion))} ${row.workflowName} #${row.runNumber} ${row.displayTitle}`.trim(),
    description: describeRun(row),
  }),
  buildReference: (row) => formatRunReference(row.id, row.displayTitle),
};

// --- the panel ---------------------------------------------------------------

export interface PanelResult {
  /** The reference text to insert, or undefined when the operator cancelled. */
  readonly reference?: string;
}

/**
 * A summonable panel over any row type.
 *
 * `done` is the `ctx.ui.custom` completion callback; calling it closes the
 * overlay and resolves the promise the command is awaiting. Every exit path
 * calls it exactly once — an overlay that never calls `done` wedges the
 * session, which is the failure mode worth being careful about here.
 */
export class RepoDashPanel<T> extends Container {
  private readonly list: SelectList;
  private readonly rows: readonly T[];
  private readonly spec: DashPanelSpec<T>;
  private settled = false;

  constructor(rows: readonly T[], spec: DashPanelSpec<T>, private readonly done: (result: PanelResult) => void) {
    super();
    this.rows = rows;
    this.spec = spec;

    this.addChild(new Text(rows.length > 0 ? spec.heading : spec.emptyHeading));

    this.list = new SelectList(rows.map((row) => spec.toSelectItem(row)), MAX_VISIBLE, getSelectListTheme());
    this.list.onSelect = (item) => { this.choose(item.value); };
    this.list.onCancel = () => { this.finish({}); };
    this.addChild(this.list);
  }

  /** Container does not forward input to children; this bridges that gap. */
  handleInput(data: string): void {
    if (this.settled) return;
    if (data === REFERENCE_KEY) {
      const selected = this.list.getSelectedItem();
      if (selected) { this.choose(selected.value); return; }
    }
    this.list.handleInput(data);
  }

  private choose(value: string): void {
    const row = this.rows.find((candidate) => this.spec.keyOf(candidate) === value);
    this.finish(row ? { reference: this.spec.buildReference(row) } : {});
  }

  private finish(result: PanelResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(result);
  }
}
