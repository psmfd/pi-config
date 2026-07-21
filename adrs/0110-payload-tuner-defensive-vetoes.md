---
status: Accepted
date: 2026-07-20
---

# ADR-0110: payload-tuner — defensive per-field vetoes over the match/apply model

**Status:** Accepted
**Date:** 2026-07-20
**Related:** [ADR-0106](0106-payload-tuner-extension.md) (the extension this hardens — additive, NOT superseded: its four original invariants stand), pi_config #778 (delivery issue), #769 (original delivery), psmfd/local-llm#44 (the live `enable_thinking` rule this must not disturb)

## Context and Problem Statement

ADR-0106's payload-tuner applies a matched rule's `apply` block in full,
unconditionally. Its fail-open invariant covers *the extension's own
errors* — not a successfully-applied mutation that is semantically invalid
for the target API, which 400s downstream at the provider. Three concrete
gaps (all verified against the pinned pi-ai 0.80.10 adapter source):

1. `chat_template_kwargs` merged onto any matched payload — cloud
   endpoints may reject unknown wire fields. Notably, **API family alone
   cannot gate this**: GitHub Copilot routes several cloud models (Claude
   Fable 5, Gemini, GPT-4.1, Kimi) through `api: "openai-completions"` on
   `https://api.individual.githubcopilot.com` (this repo's own
   `models-store.json` carries the entries).
2. The `maxTokensCap` clamp inspected only `max_tokens` /
   `max_completion_tokens` — a silent no-op against the Responses family,
   where plain/Azure adapters emit `max_output_tokens` (server minimum
   16). The default `openai-codex-responses` provider emits **no**
   token-limit field at all, so no clamp is possible there by
   construction.
3. Every adapter runs `buildParams` first and ships the hook's return
   verbatim with no re-validation. The Anthropic adapter deliberately
   omits `temperature` when extended thinking is enabled
   (`anthropic-messages.js:736-738`) and derives the thinking budget from
   `max_tokens` *before* the hook — so a rule's `temperature` write undoes
   the adapter's guard, and a downward `maxTokensCap` clamp can push
   `max_tokens` below `thinking.budget_tokens`; either 400s. The adapter
   never wires `top_p`, which Anthropic's API documentation (not the
   adapter source — flagged as docs-inferred) forbids alongside thinking.

## Considered Options

1. **API-family-only gate** for kwargs — rejected: the verified Copilot
   false positive above.
2. **baseUrl-only gate** — rejected: a future local-serving family that
   is not `openai-completions` would wrongly pass kwargs shaped for
   completions servers; provider ids are arbitrary user strings, so a
   provider list does not generalize either.
3. **Combined predicate + per-field vetoes** (chosen).
4. **Whole-rule skip** when any field is unsafe — rejected: a rule pairing
   `chatTemplateKwargs` with `temperature` should keep applying the safe
   fields (the live oMLX rule pattern must degrade gracefully, not
   disappear).

## Decision Outcome

A pure filter (`lib/guards.ts` `filterApplyForContext`) runs in the
dispatcher **before** `applyRule`, reducing a matched rule's `apply` block
to the context-safe subset. `applyRule` keeps its ADR-0106 contract: a
pure function over `(payload, tweaks)`.

- **`chatTemplateKwargs`** applies only when `model.api ===
  "openai-completions"` **and** `isPrivateOrLoopbackHost(model.baseUrl)`
  (localhost/`::1`, 127/8, 10/8, 172.16/12, 192.168/16). Defense-in-depth:
  each signal covers the other's failure mode. This is a structural
  network classification, not a hostname allowlist — ADR-0106's
  no-hardcoded-hostnames posture is preserved. Unknown api or unparseable
  baseUrl fails toward suppression (the untouched payload is always
  valid).
- **`temperature`, `topP`, `maxTokensCap`** are vetoed when the payload
  carries an active thinking config (`payload.thinking` is an object with
  `type !== "disabled"` — Anthropic-shaped; completions-style thinking
  formats use different shapes and cannot false-positive). The
  `maxTokensCap` half guards the budget-derivation conflict; the `topP`
  half is docs-inferred and conservative (being wrong costs an unapplied
  tweak, never a broken request).
- **Clamp coverage**: `max_output_tokens` joins the clamp's field list,
  floored at 16 for that field only (the documented Responses server
  minimum — clamping below it would trade the old silent no-op for a new
  400). Never-raise/never-add semantics unchanged; `openai-codex-responses`
  remains a no-op by design and is recorded as such rather than left
  implicit.
- **Observability**: vetoes are silent per request (the extension's
  pull-based convention) but counted per field; `/payload-tuner` reports
  `suppressed: <field>=<n>` so a matched rule doing less than configured
  is visible — without this, a partially-suppressed rule looks fully
  "tuned" in the status line.
- **Contract change named**: "a matched rule's `apply` block is applied in
  full" becomes "…applied except for known-unsafe field/context
  combinations, visibly counted." No settings-schema change; the guards
  are behavioral. The kwargs-stability invariant is unaffected — for a
  fixed resolved model the gate's inputs are constant within a session,
  so suppression is deterministic per model, not per turn.

## Consequences

- The live oMLX rule (`omlx/coding-workhorse`, localhost,
  `openai-completions`) is bit-for-bit unaffected — regression-tested with
  an api-bearing fixture (previously no test pinned `api` at all).
- A remote (public-IP) self-hosted completions server would now have
  kwargs suppressed; the counter surfaces it, and a future opt-in
  override can be added if that becomes a real deployment (none exists
  today).
- Extension remains unmirrored/unpinned (ADR-0106 scope exclusion) — no
  distribution surfaces.
- Doc-sync: extension README ("What it tunes" guards column, new
  "Defensive vetoes" section, "Verified payload shape" extension to the
  Responses/Anthropic families), repo README ADR list.
