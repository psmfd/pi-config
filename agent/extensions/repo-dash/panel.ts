/**
 * repo-dash TUI panel (ADR-0137, #981).
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
 */

import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";

import type { DashKind, DashRow } from "./data.ts";
import { formatReference } from "./reference.ts";

/** Rows visible at once before the list scrolls. */
const MAX_VISIBLE = 12;

/** The reference-into-prompt key, mirroring GitHub Copilot CLI's `c`. */
const REFERENCE_KEY = "c";

const HEADINGS: Readonly<Record<DashKind, string>> = {
  issues: "Open issues",
  prs: "Open pull requests",
};

function describe(row: DashRow): string {
  const parts: string[] = [];
  if (row.isDraft) parts.push("draft");
  if (row.state) parts.push(row.state.toLowerCase());
  if (row.author) parts.push(`@${row.author}`);
  if (row.updatedAt) parts.push(row.updatedAt.slice(0, 10));
  return parts.join(" · ");
}

/**
 * Build the select items for a set of rows.
 *
 * Exported so the label/description shaping is testable without a terminal —
 * `SelectItem.value` carries the issue number as a string because that is the
 * handle the caller maps back to a row.
 */
export function toSelectItems(rows: readonly DashRow[]): SelectItem[] {
  return rows.map((row) => {
    const item: SelectItem = {
      value: String(row.number),
      label: `#${row.number} ${row.title}`.trim(),
      description: describe(row),
    };
    return item;
  });
}

export interface PanelResult {
  /** The reference text to insert, or undefined when the operator cancelled. */
  readonly reference?: string;
}

/**
 * A summonable issues/PR panel.
 *
 * `done` is the `ctx.ui.custom` completion callback; calling it closes the
 * overlay and resolves the promise the command is awaiting. Every exit path
 * calls it exactly once — an overlay that never calls `done` wedges the
 * session, which is the failure mode worth being careful about here.
 */
export class RepoDashPanel extends Container {
  private readonly list: SelectList;
  private readonly rows: readonly DashRow[];
  private settled = false;

  constructor(kind: DashKind, rows: readonly DashRow[], private readonly done: (result: PanelResult) => void) {
    super();
    this.rows = rows;

    const heading = rows.length > 0
      ? `${HEADINGS[kind]} — enter or ${REFERENCE_KEY} to reference, esc to close`
      : `${HEADINGS[kind]} — none found, esc to close`;
    this.addChild(new Text(heading));

    this.list = new SelectList(toSelectItems(rows), MAX_VISIBLE, getSelectListTheme());
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
    const row = this.rows.find((candidate) => String(candidate.number) === value);
    this.finish(row ? { reference: formatReference(row.number, row.title) } : {});
  }

  private finish(result: PanelResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(result);
  }
}
