---
status: Superseded
date: 2026-07-21
---

# ADR-0117: per-compaction metrics ledger with self-reported cost bases

**Status:** Superseded by [ADR-0151](0151-compaction-reported-usage.md)
**Date:** 2026-07-21
**Related:** [ADR-0019](0019-compaction-optimizer-extension.md) (compaction-optimizer — amended by addition, the ADR-0107/0108/0109 precedent), [ADR-0034](0034-cache-ratio-measurement.md) (cache-meter's `turns.jsonl` — the extension-owned-ledger precedent), [ADR-0073](0073-token-meter-extension.md) / [ADR-0077](0077-routing-policy-tag-and-streaming-usage.md) (token-meter field vocabulary + policy-tag A/B), pi_config #838 (this feature), #840 (upstream: pi discards summarizer usage), #839 (the cloud summarizer this ledger's A/B gates).

Superseded by ADR-0151 after pinned pi began persisting summarizer usage on committed compaction entries. The historical body below is preserved unchanged.

## Context and Problem Statement

Nothing persists per-compaction data. The `session_before_compact` handler computes the dispatch path, shrink-ladder rung, fall-through reason, and `tokensBefore` — then discards them as ephemeral `ctx.ui.notify()` messages (#242). Worse, the cost of pi's built-in LLM summarization is **structurally invisible**: pi core's `generateSummary()` reads only the completion's text and stop reason — `response.usage` is discarded inside the compiled binary, `CompactionResult`/`CompactionEntry` carry no usage field, and the call bypasses the session event bus entirely, so no `message_end` fires and no metering extension can observe it (verified against the pinned pi v0.80.10 vendored dist; upstream ask filed as #840).

The cheap-cloud-summarizer proposal (#839) needs a cost/savings A/B — deterministic vs cloud vs pi-default — and there is no data to run it on.

## Considered Options

1. **Extend token-meter's ledger with compaction rows.** Rejected: `sessions/<id>.jsonl` is a single-writer `message_end` log whose per-turn counter and aggregation semantics assume every record is a real assistant turn; compaction rows have no turn position. Cross-extension imports are also banned outside `shared/` (ADR-0088).
2. **Wait for upstream usage propagation (#840).** Rejected as the only path: even a prompt upstream fix leaves the dispatch-path/rung/latency dimensions unrecorded, and the A/B is needed now.
3. **A compaction-optimizer-owned `events.jsonl`, self-reporting with explicit cost bases.** Chosen.

## Decision Outcome

**Option 3.** `lib/events.ts` appends one JSONL record per **committed** compaction to `~/.pi/agent/extensions/compaction-optimizer/events.jsonl` (extension-owned append-only ledger, the cache-meter `turns.jsonl` placement). `scripts/compaction-metrics.sh` renders the per-compaction table and per-path (or policy × path) rollups.

**Single emit site at commit.** `session_before_compact` stashes a pending record (path, reason, rung, `tokensBefore`, active-model rates from `ctx.model.cost`, `performance.now()` stamp); `session_compact` completes and appends it. Consequences: cancelled/deferred compactions never produce rows, and `latencyMs` spans the real compaction pause — including pi's LLM summarizer run on fall-through paths.

**Cost bases** — the ledger is honest about what each figure is:

- **`zero`** — deterministic builder, no model call. The `counterfactualDefaultCostUSD` column prices what pi's default summarizer would have cost (`tokensBefore` × input rate + this compaction's own summary size as the output-token proxy).
- **`derived`** — pi's built-in summarizer ran on the active model. Reconstructed from `tokensBefore` × input rate plus the committed `CompactionEntry.summary`'s estimated tokens × output rate. **Upper bound** — blind to the provider prefix-cache split; the rate/estimate components are logged so reports can show bounds. This is the best obtainable figure until #840 lands upstream.
- **`reported`** — reserved for a compaction-optimizer-initiated summarizer call that sees the provider's actual usage (#839's direct `complete()` call).

**Field vocabulary** follows token-meter/cache-meter (`ts`/`model`/`provider`/`policy`) for cross-ledger joins; the `TOKEN_METER_POLICY_TAG` env read is a deliberate tiny lockstep duplication of token-meter's contract (the ADR-0071 posture), not an import. Session-level A/B remains available for free via the existing `--compare-policies` rails; the CHR-recovery join against cache-meter `turns.jsonl` is documented procedure (single-live-session, ts-proximity), not automated.

**Observational invariant:** the emitter never influences dispatch and never blocks a compaction — append failures degrade to a one-shot notify. `events.enabled` (default true) is project-layer allowlisted as a boolean, matching `archive.enabled`.

## Consequences

- **Positive:** every committed compaction is measurable (path, rung, reason, tokens, latency, cost with explicit basis); the #839 go/no-go can be made from data; the deterministic interim guard on the omlx host starts accumulating baseline rows immediately.
- **Neutral:** a few hundred bytes per compaction in the extension's own gitignored subtree; one more `--self-test`-style script surface (`compaction-metrics.sh`).
- **Accepted:** `derived` rows overstate the default path's true billed cost when provider prefix caching applied — bounded, component-logged, and resolved for good only by #840. The counterfactual's output-token proxy (own summary size) is an estimate by construction.
