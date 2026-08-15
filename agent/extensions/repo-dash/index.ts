// PI-EXTENSION-CAPABILITY: no-registerTool
// Gated by validate.sh 6b-quinquies (ADR-0139): the declaration and the code must agree.

/**
 * repo-dash — summonable issues/PR/CI panels and an idle-gated CI widget.
 *
 * Curated feature plan Track 1.2 (#981, #987); design records ADR-0137 (the
 * shared read core and the no-tools constraint) and ADR-0140 (the widget).
 *
 * This extension registers commands, shortcuts, and a widget, and **never**
 * calls `pi.registerTool`. That is the load-bearing constraint, not an
 * omission: the model's GitHub reach stays exactly `github-read`'s typed,
 * domain-gated, opt-in-guarded tools. repo-dash widens what the *operator* can
 * see without widening what the *model* can request — and because every path
 * here sits on the same `assertReadOnlyPlan`, the operator-facing side inherits
 * identical argv safety rather than a parallel implementation of it.
 *
 * The widget content is verifiably outside the model's context: `setWidget`
 * writes to the interactive renderer's widget map only, never to the entry log
 * or the system prompt. See ADR-0140.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { fetchRows, fetchRuns, resolveRepository, type DashKind, type DashRunRow } from "./data.ts";
import { currentBranch } from "./git-branch.ts";
import { RepoDashPanel, itemSpec, runSpec, type DashPanelSpec, type PanelResult } from "./panel.ts";
import { appendReference, stripUnsafe } from "./reference.ts";
import { CiWidgetPoller, POLL_INTERVAL_MS, describeWidgetState } from "./widget.ts";

/** Widget registration key; also the handle `setWidget(key, undefined)` clears. */
const WIDGET_KEY = "repo-dash-ci";

/**
 * Runs fetched per widget poll.
 *
 * Smaller than the panel's 20: the widget shows the newest run of at most four
 * distinct workflows, and a shorter list is a smaller response to parse on a
 * standing timer.
 */
const WIDGET_RUN_LIMIT = 12;

/** Session flag mirroring the repo's other off-switches (cf. PI_HASHLINE_EDIT). */
function disabled(): boolean {
  return process.env.PI_REPO_DASH === "0";
}

/**
 * Read the widget's persistent default from the USER settings layer only.
 *
 * Deliberately not the project layer, and for a stronger reason than
 * token-meter's (ADR-0073) precedent: this toggle starts *standing network
 * activity*. A project-layer switch would let any cloned repository begin
 * polling the GitHub API on session start, against the operator's own token,
 * without the operator ever opting in. The per-session `/ci widget on` is the
 * escape hatch for trying it without editing settings.
 */
async function readWidgetEnabled(): Promise<boolean> {
  try {
    const path = join(homedir(), ".pi", "agent", "settings.json");
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as {
      extensionSettings?: { repoDash?: { ciWidget?: unknown } };
    };
    return parsed?.extensionSettings?.repoDash?.ciWidget === true;
  } catch {
    // Absent, unreadable, or malformed settings mean OFF. An opt-in feature must
    // never be enabled by a parse failure.
    return false;
  }
}

/**
 * Load rows, show a panel, and append whatever reference it returns.
 *
 * Generic over the row type so `/ci` is not a third copy of this function: the
 * only things that differ per panel are how rows are loaded and how they are
 * displayed and referenced, and both arrive as parameters.
 */
async function openPanel<T>(
  ctx: ExtensionCommandContext,
  what: string,
  load: (repository: string, signal?: AbortSignal) => Promise<readonly T[]>,
  spec: DashPanelSpec<T>,
): Promise<void> {
  // Dialogs and custom components are no-ops outside interactive mode, and
  // child subagents always run headless — so bail before doing any work rather
  // than spawning `gh` for output nobody can see.
  if (!ctx.hasUI) {
    return;
  }

  let rows: readonly T[];
  try {
    const repository = await resolveRepository(ctx.signal);
    rows = await load(repository, ctx.signal);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : `repo-dash could not load ${what}`, "error");
    return;
  }

  const result: PanelResult = await ctx.ui.custom<PanelResult>(
    (_tui, _theme, _keybindings, done) => new RepoDashPanel<T>(rows, spec, done),
    { overlay: true },
  );

  if (!result.reference) return;
  ctx.ui.setEditorText(appendReference(ctx.ui.getEditorText(), result.reference));
}

export function registerRepoDash(pi: ExtensionAPI): void {
  if (disabled()) return;

  let poller: CiWidgetPoller | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Both resolved once per session rather than per poll. Neither can change
  // under a running session — the cwd is fixed, and ADR-0120 pins each session
  // to its own worktree with its own branch — so re-resolving would put a second
  // and third subprocess on the polling path for values already known.
  let repository: string | undefined;
  let branch: string | undefined;
  let branchResolved = false;

  /** Tear the widget down. Idempotent, and never throws. */
  function stopWidget(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    poller?.stop();
    poller = undefined;
  }

  /** Clear the widget from the UI, tolerating an already-dead context. */
  function clearWidget(ctx: ExtensionContext): void {
    try {
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // The context is stale (runtime reload or session replacement). Nothing
      // left to clear.
    }
  }

  function startWidget(ctx: ExtensionContext): void {
    if (poller !== undefined || !ctx.hasUI) return;

    poller = new CiWidgetPoller({
      load: async () => {
        repository ??= await resolveRepository();
        // Guarded on a flag, not on `branch !== undefined`: an unscopable
        // session (detached HEAD, no repository) legitimately resolves to
        // undefined, and without the flag that would re-spawn `git` on every
        // poll forever.
        if (!branchResolved) {
          branch = await currentBranch();
          branchResolved = true;
        }
        const rows: readonly DashRunRow[] = await fetchRuns(
          repository,
          branch,
          undefined,
          undefined,
          WIDGET_RUN_LIMIT,
        );
        return { rows, branch };
      },
      emit: (lines) => {
        try {
          ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
        } catch {
          // A stale context throws here. Stop rather than leave a timer alive
          // against a dead UI — `stop()` does not emit, so this cannot recurse.
          stopWidget();
        }
      },
      now: () => Date.now(),
      // `hasPendingMessages` matters as much as `isIdle`: between a queued
      // message being accepted and the next agent loop starting, the session is
      // momentarily "idle" while being anything but.
      isIdle: () => ctx.isIdle() && !ctx.hasPendingMessages(),
    });

    timer = setInterval(() => {
      void poller?.tick();
    }, POLL_INTERVAL_MS);
    // Never hold the process open for a status display.
    timer.unref?.();

    void poller.tick();
  }

  const itemCommands: readonly (readonly [string, DashKind, string])[] = [
    ["issues", "issues", "Browse open issues and reference one into the prompt"],
    ["prs", "prs", "Browse open pull requests and reference one into the prompt"],
  ];

  for (const [name, kind, description] of itemCommands) {
    pi.registerCommand(name, {
      description,
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        await openPanel(ctx, kind, (repo, signal) => fetchRows(kind, repo, signal), itemSpec(kind));
      },
    });
  }

  pi.registerCommand("ci", {
    description: "Workflow runs: /ci opens the panel, /ci widget [on|off|status] controls the CI widget",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const raw = (args ?? "").trim();
      if (raw.length === 0) {
        await openPanel(ctx, "workflow runs", (repo, signal) => fetchRuns(repo, undefined, signal), runSpec);
        return;
      }

      const parts = raw.split(/\s+/);
      if ((parts[0] ?? "").toLowerCase() !== "widget") {
        // Echoed back through the sanitizer for the same reason panel rows go
        // through it: this string reaches the terminal, and nothing guarantees
        // `notify` strips escapes.
        ctx.ui.notify(
          `repo-dash: unknown /ci argument "${stripUnsafe(raw)}" — use /ci, or /ci widget [on|off|status]`,
          "warning",
        );
        return;
      }

      const sub = (parts[1] ?? "status").toLowerCase();
      if (sub === "on") {
        startWidget(ctx);
        ctx.ui.notify("repo-dash CI widget: ON for this session (persist with extensionSettings.repoDash.ciWidget)", "info");
        return;
      }
      if (sub === "off") {
        stopWidget();
        clearWidget(ctx);
        ctx.ui.notify("repo-dash CI widget: OFF for this session", "info");
        return;
      }
      if (sub === "status") {
        ctx.ui.notify(
          describeWidgetState(poller !== undefined, poller?.getSnapshot(), Date.now(), poller?.getLastError()),
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `repo-dash: unknown widget action "${stripUnsafe(sub)}" — use on, off, or status`,
        "warning",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (await readWidgetEnabled()) startWidget(ctx);
  });

  // `agent_settled`, not `agent_end`: the latter fires when the loop ends but an
  // automatic retry, a compaction, or a queued continuation may still run, so
  // polling there would land mid-work — exactly what the idle gate exists to
  // prevent. `agent_settled` is documented as firing only once none of those
  // remain, which is the real idle boundary.
  pi.on("agent_settled", async () => {
    await poller?.tick();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopWidget();
    clearWidget(ctx);
  });
}

export default function repoDash(pi: ExtensionAPI): void {
  registerRepoDash(pi);
}
