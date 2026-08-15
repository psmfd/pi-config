---
status: Accepted
date: 2026-08-14
---

# ADR-0140: repo-dash's CI widget is opt-in, idle-gated, and outside the model's context

**Status:** Accepted — approved with the #987 Phase 2 implementation plan on 2026-08-14.

**Related:** [ADR-0137](0137-github-read-core-shared-extraction.md) (the shared read core and the no-tools constraint this widget must not breach), [ADR-0139](0139-extension-tool-capability-declaration.md) (the mechanical gate on that constraint, and its explicit limits), [ADR-0123](0123-typed-read-only-github-and-git-tools.md) (the untrusted-content posture carried here), [ADR-0073](0073-token-meter-extension.md) (the user-layer opt-in precedent), [ADR-0120](0120-worktree-session-isolation.md) (per-session worktrees, which is why "the current branch" is ambiguous).

## Context and Problem Statement

Phase 1 of repo-dash (#981) shipped three summonable panels. Every one of them runs **only when the operator presses a key**: a command handler spawns `gh`, renders an overlay, and exits. The extension holds no timer, keeps no state between invocations, and makes no network call the operator did not just ask for.

Issue #987 Phase 2 asks for a CI-status widget — a persistent line above the editor showing recent workflow-run outcomes, refreshed while the session is idle. That is a categorically different thing from a panel, and the difference is the reason this needs a decision record rather than being a third command:

> **Never poll during a turn.** Every refresh spawns `gh`; doing that mid-turn competes with the agent's own work and burns rate limit. The idle gate is the point of the feature, not a nicety.
>
> **Rate-limit budget.** Decide and document a refresh interval. An always-on widget is a standing API cost against the same token the model's `github-read` calls use.

This is repo-dash's **first standing background activity**. Three properties that were previously true by construction stop being free:

1. **No unrequested network traffic.** A panel's `gh` spawn is a direct consequence of a keystroke. A timer's is not.
2. **No contention with the agent.** A panel cannot run mid-turn, because the operator cannot summon one mid-turn. A timer can.
3. **Nothing enters the model's context.** ADR-0137's constraint is about `pi.registerTool`, and ADR-0139 is explicit that its gate proves only "no new tool schema", **not** the broader "does not widen model reach" — it names `pi.on` hooks and `ctx.ui.setEditorText` as separate vectors under separate controls. A widget rendering untrusted GitHub content is a third thing that has to be checked rather than assumed.

## Decision Drivers

- **Opt-in, because standing network activity is not a default anyone consented to.** The cost is small but it is continuous, and it is charged to the operator's token.
- **The idle gate must be structural, not best-effort.** "We try not to poll during turns" is not the constraint #987 states.
- **A widget must not become an injection vector.** If widget content can reach the model, then any repository the operator opens can put text in front of it — a far worse position than the panels, which at least require a keystroke and show the operator what is being inserted.
- **Degrade honestly.** A CI indicator that silently shows old data is worse than no indicator, because the operator acts on it.
- **Do not bundle unrelated risk.** The first PR to introduce background activity should not also introduce a new subprocess vector.

## Considered Options

| Option | Verdict |
| --- | --- |
| **Opt-in via user-layer settings + per-session `/ci widget on`, idle-gated, 60s floor** | **Chosen.** Detailed below. |
| On by default, idle-gated | Rejected. Turns every session in every repository into a standing API consumer without the operator ever asking. The 1.2% budget figure is defensible *because* someone chose it. |
| Project-layer settings key | Rejected, and more firmly than for token-meter. A project-layer switch would let any cloned repository begin polling the GitHub API on session start, against the operator's own token. |
| Poll on a timer with no idle gate | Rejected — the constraint #987 exists to state. |
| `agent_end` as the edge trigger | Rejected on reading the runtime. See below. |
| Operator-tunable interval | Rejected. The interval is a rate-limit budget decision, not a preference; exposing it invites a 1s setting that burns the model's own budget. A fixed documented constant answers #987's "decide and document" better than a knob. |
| Branch-scoped runs (what #987 literally asks for) | **Deferred to #1005.** See below. |

## Decision Outcome

### Opt-in, user layer only

The persistent default is `extensionSettings.repoDash.ciWidget` in `~/.pi/agent/settings.json`, read from the **user layer only**, exactly as token-meter reads its own toggle (ADR-0073). A malformed, unreadable, or absent settings file resolves to `false`: an opt-in feature must never be switched on by a parse failure.

The reason for excluding the project layer is stronger here than it was for token-meter. Token-meter's project-layer exclusion closes a "hostile repo hides its cost" gap — an observability concern. This toggle *starts network activity*, so a project-layer switch would let a cloned repository initiate standing GitHub API traffic against the operator's token before the operator has done anything but open a session.

`/ci widget on|off|status` toggles for the current session only, so the feature can be tried without editing a file. `/ci` with no argument still opens the Phase 1 panel; the widget subcommand is additive.

### Idle gate, single-flight, and one interval floor

`CiWidgetPoller.tick()` refuses in three ordered checks, each load-bearing:

1. **Not idle** — `ctx.isIdle() && !ctx.hasPendingMessages()`. The second conjunct matters as much as the first: between a queued message being accepted and the next agent loop starting, the session is momentarily "idle" while being anything but.
2. **In flight** — a slow `gh` or a hung network must not accumulate overlapping children as the interval keeps firing.
3. **Too soon** — `now < nextEligibleMs`, which carries both the normal cadence and the failure backoff.

A refused-for-being-too-soon tick still **repaints**, because the displayed age and the staleness marker are functions of the clock rather than of the data.

### 60 seconds, and why

One poll per minute against GitHub's 5000/hour authenticated REST limit is 60/hour — **1.2% of the budget**, drawn from the same token `github-read`'s model-facing tools use. A 10s interval would be 7.2% for information that changes on the order of minutes.

The number is a **floor**, not merely a period. The `agent_settled` edge trigger calls the same `tick()` through the same eligibility check, so a burst of short turns cannot drive polling faster than once a minute, while a long turn is followed by an immediate refresh the moment it settles — which is exactly when the operator looks.

### `agent_settled`, not `agent_end`

`agent_end` fires when the agent loop ends, but the runtime documents that an automatic retry, a compaction, or a queued continuation may still follow it. Polling there would land mid-work, defeating the gate. `AgentSettledEvent` is documented as firing "after an agent run has fully settled and no automatic retry, compaction, or queued continuation will run" — the actual idle boundary. This was found by reading `core/extensions/types.d.ts`; both events are plausible from their names alone, and the wrong one fails silently by polling slightly too early.

### Failure backoff applies to every failure

On any failed poll the next attempt is `min(60s × 2^failures, 15min)` away, and the **previous snapshot is retained** so the widget degrades to marked-stale rather than blank.

Backing off on every failure rather than only on 403/429 is deliberate. Telling a rate-limit rejection apart from a network error means parsing `gh` stderr, and the asymmetry favours the blunt rule: the cost of over-applying it is slower recovery from a transient blip, while the cost of under-applying it is hammering an endpoint that is already refusing us.

### Honest degradation

An empty widget reads as "CI is fine", so the widget never blanks to indicate a problem. It shows the last known state with a `stale` marker and, where one exists, the failure text. Before the first successful poll it renders **nothing at all** rather than a placeholder, so an enabled widget reserves no vertical space until it has something to say.

### Widget content is outside the model's context

Verified against the runtime rather than assumed. `setExtensionWidget` (`modes/interactive/interactive-mode.js:1641`) touches only the widget maps and calls `renderWidgets()`. It never calls `appendEntry`, never touches the session entry log, and never contributes to the system prompt. Widget text is terminal chrome.

The consequence is that untrusted `display_title` content is an **ANSI and layout hazard, not a prompt-injection vector** — a materially different threat model from the reference-into-prompt path, where the operator usually submits the buffer verbatim. It is handled accordingly:

- Sanitization is inherited, not re-implemented: `toRunRow` already runs `stripUnsafe` over `display_title`, the run `name`, `head_branch`, and the actor login at the data boundary (the #989 fix), so a `DashRunRow` is safe by construction before `widget.ts` ever sees it.
- Widget-specific bounds are width concerns on top of that: workflow and branch names are clipped to 20 **code points** (units would sever surrogate pairs), and outcome glyphs are ASCII, because a wide emoji shifts the line in a terminal whose font is unknown.

This property is **not** mechanically gated. ADR-0139's `§6b-quinquies` checks `pi.registerTool` call sites and nothing else; it would not notice a future `setWidget` implementation that fed the entry log. The check is the verification recorded here, and it is a point-in-time reading of the pi runtime — a pin bump could invalidate it.

### Repository-wide, not branch-scoped

> **Amended by [ADR-0141](0141-repo-dash-branch-scoped-ci-widget.md)**
> (2026-08-14): the widget is now scoped to the session's branch. The deferral
> below was a sequencing argument — do not add a second subprocess vector in the
> same change as the first background activity — and it expired once the widget
> landed. `repo-dash/git-branch.ts` spawns `git rev-parse --abbrev-ref HEAD`
> with a constant argv and fails soft to the repository-wide behaviour described
> here, which therefore remains the live fallback rather than dead text. The
> per-entry `@branch` rendering below also stays: it is what the unscoped path
> still uses. ADR-0141 amends this section only; every other decision in this
> record stands. The paragraph below is preserved as originally decided.

Issue #987 asks for "the current branch's run status". What ships is repository-wide recent runs with the branch shown per line. Pi exposes the current git branch to extensions only through `ReadonlyFooterDataProvider`, which is handed exclusively to the factory passed to `ctx.ui.setFooter` — reading it means replacing the entire footer, which would also collide with token-meter's `setStatus` usage. The alternative is spawning `git rev-parse`, which is well-precedented elsewhere in this repo but would put repo-dash's *first* subprocess vector beyond the single gated `gh` path into the same change as its first background activity.

The display is adaptive rather than silently misleading: when the visible runs span more than one branch each entry carries its own `@branch`, so a single trailing branch never implies a filter that is not applied. Tracked as #1005.

## Consequences

**Good.** The idle gate, single-flight guard, interval floor, and backoff are pure policy behind injected `now`/`isIdle`/`load` seams, so each is tested against a fake clock rather than inferred from a running terminal — including the cases that matter most and are least observable by hand: 101 settle events across 100 seconds yielding exactly 2 polls, a slow load not accumulating overlapping children, and a load resolving after `stop()` not repainting a torn-down widget. The `deriveRunOutcome` derivation is shared with the `/ci` panel, so the widget and the panel cannot disagree about the same run.

**Bad.** The widget is a second consumer of the rate-limit budget the model also draws on; under heavy `github-read` use the two compete, and nothing coordinates them. The `stop()`-does-not-emit contract is a real subtlety — it exists so an emit that throws on a stale context cannot recurse back into `stop()` — and it means clearing the widget is the caller's responsibility at two call sites.

**Neutral.** `/ci` now has a subcommand, which is a small discoverability cost against not claiming a second command name. The 60s constant is defensible but not derived from measurement; if the widget proves too stale in practice, the number is one edit and the floor mechanism is unaffected.
