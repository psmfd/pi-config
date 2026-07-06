---
status: Accepted
date: 2026-07-06
---

# ADR-0078: Deterministic task-type capability-matrix routing (feature-flagged)

**Status:** Accepted
**Date:** 2026-07-06
**Tracking issue:** #352
**Related:** [ADR-0031](0031-auto-router.md) (the router this **augments, not supersedes** — the classifier remains the routing front-end; the matrix is a deterministic override layered behind it), [ADR-0076](0076-model-tier-policy-and-precedence-guard.md) (the tier policy whose capable-set data this activates; the `--model` precedence guard fires before any matrix logic, so pinned subagents are untouched), ADR-0035/#538/#364 (the live availability filters the matrix pick composes with), #351/#520/#521 (the measurement pipeline that seeded the matrix and now evaluates it), #541 (the k-recalibration follow-up).

## Context and Problem Statement

Phase 1 (#351) records what each task type really costs; #363 seeded `shared/routing-matrix.json` as inert data. Phase 2 must let the router act on it: for a classified task type, pick the **cheapest capable available** model deterministically instead of trusting the classifier's model choice — without regressing any existing behavior while the feature is off, and without the override ever routing to a model the live filters or the session's `unavailable` set excluded.

## Considered Options

### Q1 — Matrix semantics for unlisted models

| Option | Verdict |
|---|---|
| **Q1.A — Closed world for matrix picks: a model absent from the matrix is never a matrix pick; the classifier may still choose it.** | **Chosen.** The matrix is a hand-vetted capability floor — an override may only redirect toward models a human certified for the task type. Absence never removes a model from routing (the classifier path is untouched), so the floor cannot strand routing; it can only decline to override. |
| Q1.B — Open world: unlisted models are capable of everything. | Rejected — the override could then "deterministically" pick an unvetted model on price alone, which is exactly the race-to-the-bottom the capable-set design exists to prevent. |

### Q2 — Fallback when the matrix yields nothing

**Typed `null` → the classifier's own pick stands, unmodified.** `resolveByTaskType` returns `null` on every empty stage (no matrix, `unknown` task type, empty capable set, no availability/window survivor) — never throws, never an arbitrary pick. The turn still routes (via the classifier's choice) and records `source: "classifier"`. A matrix miss is not a routing failure.

### Q3 — The cost-rank scalar

**`input + k·output` with `k = 1`.** Any k ≠ 1 asserts a specific output:input token-count ratio, and no measured per-task-type ratio existed when this landed — the #351/#521 pipeline gathers exactly that data, and **#541** tracks recalibrating k from it. k is irrelevant to the zero-cost local candidate, which wins its capable set at any k. Deliberately NOT `orderClassifierModels`' input-only sort: that function prices the *classifier side-call* (ADR-0076 Q4b); this scalar prices the *real turn*, where output dominates spend. Ties break deterministically: smaller context window, then `provider/id` string order — the pick never depends on menu order.

### Q4 — Context-window adequacy

**Filter before cost-rank; fail open on unknown usage.** A candidate whose own window would already be past `THRESHOLDS.FORCE_COMPACT_AT` (0.9, `shared/signals.ts`) at the current token count is excluded — routing to it would force immediate compaction, worse than a pricier model with headroom. `getUsage() === null` means *unknown, never empty* (the signals.ts contract): the filter is skipped rather than guessed. No new threshold constant was invented; signals.ts stays the single source of truth.

### Q5 — Validation gates on the pick

**The matrix pick passes the SAME gates as the classifier's choice**: resolved via `resolveChoice` against `built.candidates` (the live-filtered menu — allowlist, Copilot/ADR-0035, Anthropic/#538, oMLX/#364 all compose for free) and re-checked against `unavailable` AFTER the classify loop (the loop can 429 a model into `unavailable` after the menu snapshot — the same race the classifier path already re-checks at the equivalent point). Any gate failure → the classifier's target stands.

### Q6 — Feature flag and cache interaction

**`RouterState.matrixEnabled`, default `false`, toggled by `/auto matrix on|off`; the decision cache is cleared on every toggle.** A prompt hash carries no dependency on the flag, so a decision cached under one mode would silently replay under the other. Clearing the whole cache on this rare, explicit user action is simpler than per-entry mode-stamping and matches the cache's existing "never valid across a context change" discipline. `shared/state.ts`'s `loadState` is a cast, not a merge: a pre-#352 `state.json` loads `matrixEnabled` as `undefined` — consumers truthy-test the flag (never `=== false`), so old state means off, unit-tested.

### Q7 — Measurement honesty

**Every routed decision carries `source: "matrix" | "classifier"`** — on `RouteOutcome`, `CachedDecision`, and every `TaskTypeRecord` (via the sticky label). Without it, post-#352 `task-types.jsonl` data mixes matrix-forced and organic choices indistinguishably, and the dataset the matrix was seeded from becomes self-confirming — the matrix could never be honestly re-evaluated against the very telemetry it influences. Records written before #352 lack the field; consumers (analyze-routing-matrix.sh) default it to `"classifier"` (they predate any matrix influence). Matrix-sourced rows render with a `[matrix]` tag.

### Q8 — Matrix loading

**Async fail-soft loader (`shared/routing-matrix.ts`), loaded once per `session_start`.** Mirrors token-meter's `loadTierMap` (module-relative path, try/catch, per-row filtering) but returns `null` on failure rather than `{}` — "absent" must be distinguishable from "present but empty" because `null` is the resolveByTaskType short-circuit. A missing/corrupt matrix degrades matrix routing to classifier routing; it can never break extension load or a turn. Per-session reload matches the discovery caches' cadence: edits apply next session without a restart.

### Q9 — CI staleness guard

**`validate.sh 9b-routing-matrix-bis`: structure FAILs, judgment WARNs.** FAIL tier = JSON parse, non-empty `models`, well-formed `provider/id` keys, parseable `lastReviewed` — objective defects. WARN tier = `lastReviewed` older than 180 days (the file is human-reviewed, never auto-bumped — a hard age gate would force meaningless date-bump commits) and matrix keys not matching any `agent/agents/*.md` frontmatter `model:` pin (a capability-floor row may legitimately precede agent adoption; live-registry checks are impossible in CI). `capable[] ⊆ TASK_TYPES` is deliberately NOT re-checked in bash — `auto-router/test/routing-matrix.test.ts` imports `TASK_TYPES` directly, a zero-drift mechanism a grep extraction or duplicated list could only be worse than.

## Decision Outcome

Chosen: Q1.A closed-world floor, typed-null fallback, k=1 scalar with deterministic tiebreak, fail-open window filter at FORCE_COMPACT_AT, same-gates revalidation, default-off `matrixEnabled` with cache-clear-on-toggle, `source` threading through outcome/cache/records, fail-soft per-session loader, and the FAIL/WARN-split validate.sh guard. Behavior with the flag off (the default) — or with the matrix missing, empty, or malformed — is byte-identical to pre-#352 routing, unit-tested as a regression fence.
