---
status: Accepted
date: 2026-06-11
---

# ADR-0034: suite-wide prefix-churn / cache-ratio measurement

**Status:** Accepted
**Date:** 2026-06-11
**Tracking issue:** #338
**Related:** #327 (suite), #330 (auto-router), #334 (context-manager), #336 (indexing), [ADR-0031](0031-auto-router.md), [ADR-0032](0032-context-manager.md) (the cached-prefix invariant this measures), [ADR-0033](0033-codebase-indexing.md), [ADR-0030](0030-shared-foundation.md)

## Context and Problem Statement

The Pi Extension Suite (#327) carries one **binding** invariant ([`notes/pi-extension-suite-plan.md`](../notes/pi-extension-suite-plan.md) § "Do Not Churn the Prefix"):

> Provider prompt caching prices cached input tokens ~10× below fresh. Any feature that rewrites the message **prefix** on each call invalidates the cache from the change-point forward and can cost more than the tokens it removes. Prune append-side; batch prunes.

ADR-0032's context-manager was designed expressly to honor it (frozen-at-first-sight per-`toolCallId` elision). #338 is the empirical gate: a measurement that watches the cached-vs-fresh input-token ratio per provider, with each suite extension enabled, to confirm no extension churns the prefix and no configuration regresses token cost. This ADR records how that measurement is built and the provider limitation it must tolerate.

## Considered Options

1. **Measure via `before_provider_request` / `after_provider_response`** (the plan's amendment E) — inspect the outgoing payload / response headers.
2. **Measure via `message_end` `usage`** (chosen) — read pi's normalized per-turn token usage.
3. **Synthetic-only test** — assert prefix stability by hashing the sent message array without a real provider.

### Why `message_end` usage

`after_provider_response` fires before the response body is consumed, so usage is not yet populated. `message_end` on an assistant message exposes `usage.{input, output, cacheRead, cacheWrite, cost.total}` (verified against pi v0.79.0; the same fields the subagent extension accumulates). Critically, `usage.input` is **fresh input only** — `max(0, promptTokens − cacheRead − cacheWrite)` — so the cache-hit ratio is directly `cacheRead / (cacheRead + input)`. This is the authoritative signal.

A synthetic-only test cannot observe real provider cache behavior (cache hits depend on the provider keying the prefix), so it would verify our *intent* but not the *outcome*. We keep a synthetic element only as the analysis-logic self-test (below), not as the measurement itself.

## Decision Outcome

**Chosen: option 2 — a read-only `cache-meter` recorder on `message_end` plus an offline analysis script, run by an operator over real sessions.**

### Components

- **`agent/extensions/cache-meter/`** — gated on `CACHE_METER_CONFIG` (inert otherwise), appends one JSONL record per assistant turn `{ts, turn, model, provider, input, cacheRead, cacheWrite, output, costTotal, config}`. The handler is **observational**: it returns `undefined`, never a replacement message — a measurement tool that rewrote the message would itself churn the prefix it measures.
- **`scripts/analyze-cache-ratio.sh`** — per-config cache-hit ratio (CHR `= ΣcacheRead / Σ(cacheRead + input)`) and fresh-input/cost deltas vs a baseline, with threshold flags (`--min-ratio`, `--max-cfit-delta`, `--max-cost-delta`) and a structured PASS/FAIL report. Ships a `--self-test` over fixtures.
- **`scripts/run-cache-ratio.sh`** — operator runbook (the live run can't be automated).

### Measurement protocol (recorded for reproducibility)

Baseline (all suite extensions off) → +auto-router → +context-manager → +indexing, each over an **identical fixed prompt battery**, model **held constant** (except the dedicated auto-router run), turns 1–2 discarded as warmup. Legitimate cache resets (an auto-router model switch; indexing's one-time `search_codebase` tool registration) are distinguished from prefix-rewrite churn and are not failures. A config PASSes when CHR holds (or is SKIPped for a non-reporting provider) and fresh-input/cost stay within tolerance of baseline; a regression is filed back to the offending extension's issue with the measured evidence.

### The provider limitation (binding constraint on the live run)

Authoritative CHR requires a provider that reports cache tokens. The **Anthropic** path (`anthropic-messages`) populates both `cacheRead` and `cacheWrite`; OpenAI-style paths populate `cacheRead` only. The user's default **github-copilot** provider currently reports **both as 0** (Copilot SDK issue #1073, open). The analysis therefore treats an all-zero-cache config as **SKIP** on the CHR gate (never a false PASS) and falls back to the fresh-input (CFIT) regression as a proxy, yielding `PASS_WITH_WARNINGS` at best for that provider. A true CHR measurement runs against Anthropic-direct.

### CI posture

The **live measurement is NOT a `validate.sh` check** — it needs real provider sessions, an API key, and human-driven prompts. Only the **analysis-logic self-test** and the recorder's **unit tests** are CI-gated, so the math and plumbing are regression-tested even though the live data collection is not.

## Consequences

- **Good:** a reproducible, provider-aware gate for the suite's load-bearing invariant; the recorder is inert in normal use and cannot itself churn the prefix; analysis logic is unit-gated.
- **Bad / costs:** the headline CHR number is only authoritative on a cache-reporting provider; on github-copilot the gate degrades to the CFIT proxy until #1073 is fixed. The live run is manual (no CI automation is possible without real sessions).
- **Follow-up:** Stage B — run the battery and record per-config results in #338; if a provider probe confirms 0 cache fields, document it against #1073 and report CFIT-only.

## More Information

- `agent/extensions/cache-meter/`, `scripts/analyze-cache-ratio.sh`, `scripts/run-cache-ratio.sh`.
- Field semantics verified in `~/.cache/pi_config/pi-v0.79.0/pi/docs/{extensions,custom-provider,rpc,models}.md`.
- The invariant under test: ADR-0032 § cached-prefix design; [`notes/pi-extension-suite-plan.md`](../notes/pi-extension-suite-plan.md).
