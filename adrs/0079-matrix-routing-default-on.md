---
status: Accepted
date: 2026-07-06
---

# ADR-0079: Matrix routing on by default

**Status:** Accepted
**Date:** 2026-07-06
**Tracking issue:** #353
**Amends:** [ADR-0078](0078-matrix-routing-task-type-override.md) — Q6's default value only. ADR-0078 is not edited; its mechanism decisions (Q1–Q5, Q7–Q9: closed-world floor, null fallback, k=1 scalar, window filter, same-gates revalidation, `source` threading, fail-soft loader, CI guard) all stand unmodified. This mirrors ADR-0077's amendment of ADR-0076's Q4 registration facts.

## Context and Problem Statement

ADR-0078 shipped matrix routing default-off pending operator validation (#350 Phase 3). That validation ran 2026-07-06 on the live host: an identical 15-prompt battery (code-edit, simple-qa, code-review, agentic file-reads, plus long-context and creative controls) under `TOKEN_METER_POLICY_TAG=phase3-off` / `phase3-on`, graded matched-pair with a zero-tolerance regression gate. Result — recorded in the #353 evidence comment: **14/14 quality pairs pass in both arms (zero matrix-attributable regressions)**, the creative control stayed classifier-sourced in both arms (closed-world guarantee held live), and the same battery cost **$0.1494 matrix-off vs $0.0032 matrix-on (97.8% reduction)** — off-arm turns went 18/19 to paid frontier models while the on-arm forced 23/24 to the $0-registered workhorse, with the single frontier turn being the control behaving correctly.

## Considered Options

### Q1 — Flip now, keep burning in, or gate further?

**Flip now.** The gate the issue defined (quality + cost improvement, recorded) is met with a decisive margin. A longer burn-in adds statistical polish a single-operator dev tool does not need; the zero-tolerance matched-pair gate is the honest bar and it passed clean. Opt-out remains one command (`/auto matrix off`, persisted).

### Q2 — What "default on" must actually mean (the load-bearing decision)

`shared/state.ts::loadState` returns a **cast** of the parsed file, never a merge with the default — so a bare `DEFAULT_STATE.matrixEnabled = true` edit would be inert for every operator with an existing `state.json` lacking the key (anyone who ever ran `/auto on`): the field would load `undefined`, truthy-test off, and the "flip" would reach only zero-state fresh installs.

**Chosen: a per-field default-merge scoped to auto-router's `load()`** — `{ ...DEFAULT_STATE, ...raw }`. Semantics: a key absent from the persisted file means "defer to the current shipped default"; a key the file carries — including an **explicitly persisted `false`** from a real `/auto matrix off` — always wins. Rejected: making `loadState` itself merge generically — `indexing` and `context-manager` also consume it, and changing their load semantics is outside this decision's scope. One accepted nuance: operators who toggled the matrix on and off during the #352 era carry an explicit `false` and keep it; that is treated as their choice, not migrated.

## Decision Outcome

`DEFAULT_STATE.matrixEnabled: true` plus the `load()` default-merge. Fresh installs and every state file lacking the key get matrix routing on; explicit opt-outs survive. Doc surfaces stating "default off" updated (auto-router README, routing-matrix.json description, root README index); ADR-0078's file is untouched per the amendment convention.
