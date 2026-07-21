---
status: Accepted
date: 2026-07-19
---

# ADR-0106: payload-tuner — per-request wire-payload tuning for local models

**Status:** Accepted
**Date:** 2026-07-19
**Related:** [ADR-0032](0032-context-manager.md) (context-manager; the prefix-churn invariant and the payload-rewriter rejections this ADR reconciles with), [ADR-0034](0034-cache-ratio-measurement.md) (suite-wide cache-ratio invariant and measurement protocol), [ADR-0094](0094-local-llm-role-lever.md) (user-layer-only trust posture for local-LLM levers), pi_config #769 (delivery issue), #677 (prefill-bound compaction timing; shared oMLX motivation), psmfd/local-llm#44 (`enable_thinking` A/B probe; this extension is its lever).

## Context and Problem Statement

The suite optimizes token spend at compaction time (compaction-optimizer,
ADR-0019) and continuously via cache-safe tail elision (context-manager,
ADR-0032), but nothing conditions the **outgoing provider request** on the
resolved model. For local oMLX models this leaves known quality/latency
levers unpulled: the GLM workhorse emits a thinking preamble on every
tool-call turn (pure latency/token overhead — psmfd/local-llm#44 measures
it), local model families need non-default sampling to behave, and
generation length is unclamped against the local context budget.

An "always-on prompt optimizer" that rewrites message content per request
was considered and rejected: ADR-0032 already established the binding
invariant that per-request prefix rewrites invalidate provider prompt
caching from the change point forward and can cost more than they save —
the exact failure mode for which `pi-dcp` and `pi-context-prune` were
rejected. On prefill-bound local hosts the penalty is measured (~24.6 s
cold vs ~7 s warm prefill on the M5 Max oMLX host, per #677).

## Considered Options

1. **Rule-based request-option tuning at `before_provider_request`** —
   mutate only non-prefix request fields (`chat_template_kwargs`, sampling,
   `max_tokens`), conditioned on the resolved model.
2. **Content rewriting at the `context` hook** — rejected: duplicates
   context-manager's territory; any content trimming beyond its
   frozen-decision elision violates the ADR-0032 invariant.
3. **Static per-model config in `models.json`** — rejected: pi's provider
   block cannot express extra body fields like `chat_template_kwargs`, and
   a models.json entry cannot be toggled per-rule or carry glob matching.
4. **Do nothing** — rejected: leaves the #44 lever unpulled and no sanctioned
   place to normalize local-model sampling.

## Decision Outcome

Chosen option 1: a new extension `agent/extensions/payload-tuner/`
registering one `before_provider_request` handler (the extension-facing
payload hook in pi-coding-agent 0.80.10: event `{ type, payload: unknown }`;
a non-`undefined` return replaces the payload; handler errors are caught by
the extension runner, so the chain fails open). The resolved model comes
from `ctx.model` (the extension-level event carries no model object; the
pi-agent-core-internal `before_provider_payload` name is not
extension-visible).

Per request: match `ctx.model` against user-configured rules
(`provider` / `baseUrl` glob / `modelId` glob — no hardcoded hostnames;
first matching rule wins), then apply the rule's tweaks to the wire
payload:

1. **`chat_template_kwargs` injection** (e.g. `enable_thinking: false`).
2. **Sampling normalization** — `temperature` / `top_p` per rule.
3. **`max_tokens` clamp** — caps whichever of `max_tokens` /
   `max_completion_tokens` the adapter emitted; never raises.

### Invariants

- **Never touches `messages`, `system`/instructions, or tools content.**
  Prefix-cache-safe by construction: the mutated fields are not part of the
  cached prefix. This is the reconciliation with ADR-0032 — that rejection
  covered content/prefix rewriting; this extension mutates request options
  only.
- **Kwargs stable per session+model.** `chat_template_kwargs` changes the
  server-side rendered prompt, so a rule's kwargs must not vary
  turn-to-turn (oMLX prefix-cache churn). Rules are static config, which
  satisfies this naturally; the invariant is stated so future dynamic
  features do not violate it.
- **Fail open.** Any error, malformed rules, or unrecognized payload shape
  returns `undefined` (payload unchanged). Tuning never blocks a turn.
- **User-layer settings only.** `extensionSettings.payloadTuner` is read
  from `~/.pi/agent/settings.json` exclusively; the project layer is
  ignored entirely (ADR-0094 posture — a hostile repo must not steer
  sampling or strip thinking on local models). Inert by default
  (`enabled` defaults to false).
- **Idempotent.** Set-based application: applying a rule to an
  already-tuned payload is byte-identical (regression-tested, mirroring
  context-manager's stability test).

### Fan-out coverage

Subagents are separate `pi` processes with their own user-layer extension
discovery, so every fan-out child self-loads the tuner and applies the same
static rules independently. No cross-process coordination is needed
precisely because v1 holds no dynamic state.

### Suite interaction

The hook fires after auto-router has resolved the model, and the extension
reads nothing the router's classifier depends on — zero routing
distortion. No other extension in this repo mutates
`before_provider_request`; load-order chaining (extension discovery order)
is therefore a non-issue today and is noted here for the future.

### Measurement

No new meter. token-meter provides per-request usage per child; A/B
evidence for `enable_thinking` belongs to psmfd/local-llm#44's probe
harness, with ADR-0034's CFIT/cost protocol as the regression gate where
applicable.

### Scope exclusions (v1)

- Not mirrored (`mirror/targets.yml` untouched) until the rules schema
  stabilizes.
- No dynamic/per-turn conditioning of kwargs (see kwargs-stability
  invariant).
- No content optimization of any kind — token savings remain owned by
  context-manager (continuous) and compaction-optimizer (#244/#254/#677,
  episodic).
