// PI-EXTENSION-CAPABILITY: no-registerTool
// Gated by validate.sh 6b-quinquies (ADR-0139): the declaration and the code must agree.

/**
 * repo-dash — summonable issues/PR panels over the typed GitHub readers.
 *
 * Curated feature plan Track 1.2 (#981); design record ADR-0137.
 *
 * This extension registers commands and shortcuts and **never** calls
 * `pi.registerTool`. That is the load-bearing constraint, not an omission: the
 * model's GitHub reach stays exactly `github-read`'s typed, domain-gated,
 * opt-in-guarded tools. repo-dash widens what the *operator* can see at a
 * keystroke without widening what the *model* can request — and because both
 * sit on the same `assertReadOnlyPlan`, the operator-facing path inherits
 * identical argv safety rather than a parallel implementation of it.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { fetchRows, resolveRepository, type DashKind } from "./data.ts";
import { RepoDashPanel, type PanelResult } from "./panel.ts";
import { appendReference } from "./reference.ts";

/** Session flag mirroring the repo's other off-switches (cf. PI_HASHLINE_EDIT). */
function disabled(): boolean {
  return process.env.PI_REPO_DASH === "0";
}

async function openPanel(ctx: ExtensionCommandContext, kind: DashKind): Promise<void> {
  // Dialogs and custom components are no-ops outside interactive mode, and
  // child subagents always run headless — so bail before doing any work rather
  // than spawning `gh` for output nobody can see.
  if (!ctx.hasUI) {
    return;
  }

  let rows;
  try {
    const repository = await resolveRepository(ctx.signal);
    rows = await fetchRows(kind, repository, ctx.signal);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : `repo-dash could not load ${kind}`, "error");
    return;
  }

  const result: PanelResult = await ctx.ui.custom<PanelResult>(
    (_tui, _theme, _keybindings, done) => new RepoDashPanel(kind, rows, done),
    { overlay: true },
  );

  if (!result.reference) return;
  ctx.ui.setEditorText(appendReference(ctx.ui.getEditorText(), result.reference));
}

export function registerRepoDash(pi: ExtensionAPI): void {
  if (disabled()) return;

  const commands: readonly (readonly [string, DashKind, string])[] = [
    ["issues", "issues", "Browse open issues and reference one into the prompt"],
    ["prs", "prs", "Browse open pull requests and reference one into the prompt"],
  ];

  for (const [name, kind, description] of commands) {
    pi.registerCommand(name, {
      description,
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        await openPanel(ctx, kind);
      },
    });
  }
}

export default function repoDash(pi: ExtensionAPI): void {
  registerRepoDash(pi);
}
