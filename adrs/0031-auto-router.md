---
status: Accepted
date: 2026-06-09
---

# ADR-0031: auto-router extension (per-prompt model selection)

**Status:** Accepted
**Date:** 2026-06-09
**Tracking issue:** #330
**Related:** #327 (suite), #328 (Phase 0 verification), [ADR-0030](0030-shared-foundation.md) (`shared/` foundation it consumes), [ADR-0021](0021-extension-type-checking-and-linting.md) (no per-extension `package.json`)

## Context and Problem Statement

The Pi Extension Suite (#327) optimizes session cost on three axes; auto-router owns "cost per token" by choosing a per-prompt model instead of pinning one. No maintained extension does classifier-routed selection, so this workstream is a build (the suite's only unconditional build besides `shared/`).

Phase 0 (#328) verified the runtime surface against the shipped **pi v0.79.0** distribution. Two plan assumptions were wrong and are corrected here.

## Considered Options

1. **Build a custom classifier-routed extension** (chosen) — `before_agent_start` runs a cheap classifier that picks a credentialed model; `pi.setModel()` applies it before the first provider request.
2. **Adopt an existing extension** — none exists for classifier-routed selection.
3. **Manual `/model` only** — the status quo; no per-prompt optimization. Retained as the fallback (routing never overrides a turn it cannot improve).

## Decision Outcome

**Build**, consuming `shared/` for signals, the credentialed candidate menu, the cost table, notify, and state.

### Mechanism (verified v0.79.0)

- `before_agent_start` (fires once per prompt, before the turn loop) → `policy.ts` builds the candidate menu (`modelRegistry.getAvailable()` — credentialed only) + the usage signal, `classifier.ts` calls a cheap model, the choice resolves to a registry model, and `pi.setModel(model)` applies it. `model_select` reflects the routed model; `/auto`+`--auto` toggle; state persists via `shared/state.ts`.
- **Fallback is total:** no candidates, no credential, parse/network error, abort, `setModel === false`, or an out-of-menu choice all keep the current model. Routing never throws out of `before_agent_start`.
- **Decision cache:** a per-session, in-memory `promptHash → provider/id` map avoids re-classifying identical prompts. Not persisted (models/credentials change between sessions).
- **Classifier failover:** the classifier model is tried cheapest-first across the credentialed candidates; a provider error (e.g. a 429 quota/rate error — surfaced live during #330 validation) marks that model unavailable for the session and fails over to the next, exhausting the list before falling back. The per-session unavailable-set also excludes quota-dead models from routing targets and clears on `session_start`. (A timed cooldown instead of session-scope is a possible refinement.)

### Phase 0 corrections to the plan

1. **`complete()`, not `streamSimple`.** The plan specified `pi-ai` `getModel` + `streamSimple` for the classifier side-call. In v0.79.0 `streamSimple` is a *provider-implementation* hook (`docs/custom-provider.md`); the one-shot extension call is **`complete(model, { systemPrompt, messages }, { apiKey, headers, signal })`** (`examples/extensions/qna.ts`), with credentials from `ctx.modelRegistry.getApiKeyAndHeaders()`. pi-ai v0.78.0 requires the `apiKey` to be passed explicitly.
2. **No `package.json`.** The plan listed a `package.json` declaring deps; per ADR-0021 this repo's extensions carry none (deps resolve from the `extension-deps` cache). Dropped.
3. **`shared/notify.ts` level values.** Integrating the real `ExtensionContext` revealed `ctx.ui.notify` accepts only `"info" | "error" | "warning"` — ADR-0030's `shared/notify.ts` had guessed `"warn"`/`"success"`. Fixed in this change, with the missing `notify` unit test added. This is the integration check ADR-0030 anticipated: `shared/`'s structural typing could not catch the mismatch until a real consumer used the live `ctx`.

### Testability

`policy.ts`, `classifier.ts`, `state.ts`, and `route.ts` are pure/structurally typed; `complete` is injected so parse/policy/fallback/cache logic unit-tests offline. Live routing quality (does it pick sensible models against real credentials?) cannot be asserted offline and is validated by a probe run in a real pi session, recorded on the PR.

## Consequences

- **Positive:** cheap-model routing with a hard fallback that can never degrade a turn; deterministic, offline-testable core; reuses `shared/` (no duplicated thresholds/cost). The `complete()` correction and notify-level fix harden the suite foundation for the remaining workstreams.
- **Negative / trade-offs:** one extra cheap round-trip per *novel* prompt (mitigated by the decision cache + tight prompt). Routing quality depends on the classifier model and prompt; tunable via the `classifierModel`/`allowlist` state and validated live, not in CI.
- **Deferred:** mid-loop escalation (`turn_start`+`setModel`) and the indexing-bias policy (needs Workstream C) — post-v1.

## More Information

- Phase 0 record + citations: issue #328.
- Plan of record: [`notes/pi-extension-suite-plan.md`](../notes/pi-extension-suite-plan.md) (rev 2) § "Workstream A — auto-router".
