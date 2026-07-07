# ADR-0084: Auto-router classifier prefers local models by default

**Status:** Accepted
**Date:** 2026-07-07

## Context and Problem Statement

ADR-0076 established the tier ladder for subagent model pins: read-only specialists prefer the local `omlx/coding-workhorse` when credentialed and live. ADR-0031 introduced auto-router; ADR-0078/ADR-0079 activated deterministic matrix routing by default; ADR-0080/ADR-0081 added the spawn-time Copilot fallback and oMLX liveness gate for subagent children. Together those decisions push subagent fan-out to the local workhorse first when possible.

Auto-router's parent-session **classifier trial order** (`orderClassifierModels` in `policy.ts`) was not updated in that arc. It sorts credentialed candidates strictly by `cost.input` ascending, then `contextWindow` ascending. When the local workhorse and a Copilot cost-0 model both cost `$0`, the smaller-window Copilot model runs the classifier — a design accepted at #363 while measurement data was being gathered. With ADR-0076 now settled and #351/#520 measurement data confirming local-first is the desired posture, the classifier side-call should also be tried locally first when a live oMLX candidate exists.

Two additional constraints came out of the security review:

1. **Provider allowlist invariant.** ADR-0083 introduced `orchestratorAllowedProviders`. Any local-first preference must apply *after* that filter, not before, or a Copilot-restricted parent session would re-admit `omlx/*` candidates.
2. **User trust boundary.** The override must be user-layer only (`~/.pi/agent/settings.json`), matching the token-meter/ADR-0073 posture and the ADR-0080 Copilot fallback override pattern: a hostile repo's project-layer settings must not steer where prompts flow.

## Considered Options

* **Option A — Prefer local by default, user-layer opt-out.** `orderClassifierModels` gains a `preferOmlx` parameter defaulting to `true`. When true, credentialed candidates are still cost/window-sorted, then partitioned strictly by `provider === "omlx"` with the omlx group placed first. Reads `extensionSettings.autoRouter.preferLocalOmlx` from `~/.pi/agent/settings.json` (user-layer only) once per `session_start`; malformed or missing values default to `true`.
* **Option B — Opt-in (default `false`).** Same mechanism, opposite default. Preserves current tie-break behavior for hosts that do not opt in.
* **Option C — Inline branch on `cost === 0` ties only.** Change the tiebreak to prefer omlx when both costs are zero, but leave priced comparisons alone. Rejected: does not address the general "prefer local classifier" intent (e.g. a $0.05 Copilot model would still be tried before a $0 local model on the current sort).
* **Option D — Move the preference into the routing matrix.** Rejected: the matrix governs the deterministic *task-type* pick for the real turn, not the classifier trial order. Conflating the two would corrupt the observed-cost data recorded by the #351/#520 measurement pipeline.
* **Option E — Do nothing.** Rejected: leaves the parent classifier defaulting to a paid provider on hosts where a live local workhorse is available, contradicting ADR-0076's stated intent and inflating routing side-call cost.

## Decision Outcome

Chosen option: **A — prefer local by default with user-layer opt-out**.

`orderClassifierModels` accepts an optional `preferOmlx: boolean` parameter defaulting to `true`. The function still sorts by `cost.input` ascending, then `contextWindow` ascending, and honors an explicit `classifierModel` pin unchanged (highest precedence). After that base sort, when `preferOmlx` is true and no configured pin was hit, credentialed candidates are partitioned by strict provider equality (`c.provider === "omlx"`), with the omlx group placed ahead of the rest while preserving within-group cost/window order.

Auto-router reads `extensionSettings.autoRouter.preferLocalOmlx` from `~/.pi/agent/settings.json` in `session_start` and passes it through `RouteDeps.preferOmlx` into `route()` and then `orderClassifierModels`. The read follows the ADR-0080 posture exactly: user-layer path via `path.join(os.homedir(), ".pi", "agent", "settings.json")`, `try/catch` on `readFile` and `JSON.parse`, strict boolean validation (`typeof v === "boolean"`), unknown or malformed → default `true`. Project-layer `.pi/settings.json` is deliberately not consulted.

The change is intentionally scoped to classifier trial ordering. The following are **not** touched by this ADR:

* `resolveByTaskType` (matrix routing) — still uses `costRank` and its own deterministic tiebreaks.
* `buildRoutingPrompt` menu ordering — the classifier picks by `provider/id` string from the menu, not by position, so re-ordering the display would be cosmetic and is skipped.
* `argv-guard.ts` — an explicit `--model` still short-circuits `before_agent_start` before any classifier logic runs.
* The subagent spawn-time gate and oMLX liveness probe — those govern child argv `--model` resolution, not parent classifier trial order.

The provider-allowlist invariant is preserved by data-flow position: `built.candidates` reaches `orderClassifierModels` already narrowed by `providerAllowlist` inside `getCandidates`, so the omlx-first partition operates on the already-restricted set. A comment in `policy.ts` documents the invariant to guard against future refactor drift.

## Consequences

* Good: On hosts with a live local workhorse, the parent session's classifier side-call is free and burns no frontier quota, matching ADR-0076's tier intent for subagent fan-out.
* Good: The user-layer-only override preserves the ADR-0073/ADR-0080 trust boundary — a project cannot steer parent-session spend.
* Good: Preserves every existing precedence: `argv-guard`, configured `classifierModel` pin, `orchestratorAllowedProviders`, matrix routing all continue to work identically.
* Good: The liveness/availability filter chain (`resolveOmlxFilter` → `getCandidates`) already drops dead `omlx/*` candidates before `orderClassifierModels` sees them, so the preference cannot re-admit a down workhorse.
* Bad: A subtle behavior change in the cost-0 tie-break case. Previously a 128k Copilot cost-0 model would classify ahead of the 131k workhorse; now the workhorse leads. Documented in the README and CHANGELOG.
* Bad: Adds one small user-layer settings field to explain. Kept minimal (single boolean) and follows the established Copilot-fallback shape so operators recognize the pattern.
* Neutral: Priced-vs-priced tiebreaks are unchanged in the common case because credentialed omlx candidates are cost-0 or absent; the omlx-first partition only re-orders when a live omlx is present alongside other candidates.

## More Information

Implementation surfaces:

* `agent/extensions/auto-router/policy.ts` — `orderClassifierModels` gains `preferOmlx` parameter and the strict-provider-equality partition; carries an inline scoping comment.
* `agent/extensions/auto-router/route.ts` — `RouteDeps.preferOmlx` threads the boolean into the classifier call.
* `agent/extensions/auto-router/index.ts` — `readPreferLocalOmlxSetting()` (user-layer read; `try/catch`, strict boolean, default `true`); module-level `preferLocalOmlx` set on `session_start`; passed via `RouteDeps` from `before_agent_start`.
* `agent/extensions/auto-router/test/policy.test.ts` — updated tie-break expectation and new coverage for `preferOmlx=false`, configured-pin precedence, multiple-omlx ordering, and no-omlx no-op.
* `agent/extensions/auto-router/README.md` — documents the new user-layer setting.
* `agent/settings.example.json` — adds `extensionSettings.autoRouter.preferLocalOmlx` example.

Related ADRs: ADR-0031, ADR-0035, ADR-0073, ADR-0076, ADR-0078, ADR-0079, ADR-0080, ADR-0081, ADR-0083.

Tracking: issue #589.
