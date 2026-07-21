---
status: Accepted
date: 2026-07-20
---

# ADR-0107: compaction-optimizer — context-window-relative token gate and measured hybrid defaults

**Status:** Accepted
**Date:** 2026-07-20
**Amends:** [ADR-0019](0019-compaction-optimizer-extension.md) § Decision Outcome — hybrid fall-through heuristics (supersession by addition: the original prose is unchanged; a forward-pointer blockquote there references this ADR)
**Related:** pi_config #244 (delivery issue; measurement record in its comments), #254 (output-side shrink ladder — deliberately separate, see Consequences), #677 (compaction timing; this ADR is its prerequisite), #242 (path-taken notify that surfaced the defect), #253 (`previousSummaryMaxChars` precedent)

## Context and Problem Statement

The hybrid mode selector (ADR-0019) routes each compaction to the air-gapped
deterministic builder or pi's LLM summarizer via `decideHybrid()`. Its token
gate compared `tokensBefore` against an absolute `hybrid.maxTokens` default of
60 000 — a value that predates real-world measurement.

Pi's threshold auto-compaction fires at ~0.9 × the active model's context
window (`FORCE_COMPACT_AT` in `shared/signals.ts`), so at the moment
`session_before_compact` fires, `tokensBefore` ≈ 0.9 × contextWindow **by
construction**: ~118 K on the 131 K local workhorse, 180 K+ on frontier
models. The 60 000 default therefore guaranteed `too-many-tokens`
fall-through on essentially every threshold compaction — the extension was
functionally idle in its primary use case (#244), and the operator ran a
`maxTokens: 400000` workaround.

On-host measurement (recorded on #244, 2026-07-20) confirmed and extended
this: across 4 ground-truth compaction windows and 16 approximated windows
from 10 real sessions, `maxOrphanAssistantTokens=2000` was the *most*
frequently tripped gate (all 4 real compactions; sole fall-through reason in
2 of them; real range 4 248–22 585 tokens), and `maxMessages=200` tripped at
p90=360/max=451 messages. Builder-cost benchmarks showed the deterministic
builder runs in < 1 ms at 280 K tokens / 629 messages with ~2.5 K-token
output — the cost-bounding rationale for a low absolute token gate is void.

## Considered Options

1. **Raise the absolute `maxTokens` default** (e.g. 200 K or 400 K).
2. **Context-window-relative gate with an absolute floor** — new
   `hybrid.maxTokensFraction`; effective ceiling
   `max(maxTokens, maxTokensFraction × contextWindow)`.
3. **Drop the token gate entirely** — remove `too-many-tokens` from the
   decision tree.

## Decision Outcome

**Option 2 — relative-with-a-floor**, plus measured re-grounding of the other
thresholds.

- New setting `hybrid.maxTokensFraction` (default `1.0`, project-layer clamp
  `[0, 5]`, allowlisted for project override like the other `hybrid.*`
  thresholds). With a known context window, the `too-many-tokens` gate fires
  only when `tokenEstimate > max(maxTokens, maxTokensFraction × contextWindow)`.
- `hybrid.maxTokens` remains as the **absolute floor** and the sole gate when
  the window is unknown; its default rises 60 000 → **200 000**.
- `index.ts` reads `ctx.model?.contextWindow` in the `session_before_compact`
  handler and passes it to `decideHybrid()` as a new optional
  `HybridInput.contextWindow` field — the function stays pure (no `ctx`
  access). Unknown, zero, or non-finite windows fail open to the absolute
  floor (prior behavior with a saner default).
- Measured re-grounding of the remaining thresholds (#244 acceptance
  criterion 3): `maxMessages` 200 → **500** (real p90=360, max=451; builder
  walks 629 messages in 0.75 ms), `maxOrphanAssistantTokens` 2 000 →
  **30 000** (real p90=22 585, max=22 795), `minToolCallRatio` **held** at
  0.3 (real compactions measured 0.42–0.48; the gate correctly diverts only
  tool-sparse conversational sessions).
- `HybridResult.reason` vocabulary is **unchanged** — `too-many-tokens` now
  means "exceeded the effective ceiling." `metrics` gains an additive
  `effectiveMaxTokens` field for transparency.

### Why not the alternatives

- **Option 1** leaves the structural defect: any fixed number is wrong for
  some model's window and needs re-tuning whenever the model roster changes.
- **Option 3** violates #244's own out-of-scope constraint ("stay within the
  stable `HybridResult.reason` vocabulary" — removing a reason is a
  vocabulary change consumers can observe) and removes the guard against
  pathological single-blob payloads that the floor still provides when the
  window is unknown.

### Back-compat guarantee

The `max()` combinator means the window-derived ceiling can only **widen**
the gate relative to an explicit absolute `maxTokens` override, never narrow
it: a user who set `maxTokens: 400000` keeps at least a 400 000 ceiling on
every model, including small-window local models (regression-tested in
`test/hybrid.test.ts`). Post-change, that operator override is redundant on
every currently registered model and can be removed.

### Contract note (extends ADR-0019 § Contracts We Rely On)

`ExtensionContext.model` is typed `Model<any> | undefined` with
`Model.contextWindow: number` in the vendored pi type definitions
(`dist/core/extensions/types.d.ts`, pi v0.75.5 pin), and
`ctx.model?.contextWindow` is the established read idiom already used by
`shared/signals.ts`, `context-manager`, and `auto-router` (ADR-0030). The
`undefined` case is handled fail-open. This is the same first-party
verification bar ADR-0019's contracts table applies; the field is read from
the handler's `ctx`, not from `CompactionPreparation`.

## Consequences

- Threshold compactions on all registered models now take the air-gapped
  deterministic path unless a content gate (ratio, orphan text, custom
  instructions) diverts them — the extension's primary purpose (ADR-0019)
  is functional at threshold sizes for the first time.
- Compactions up to ~283 K observed tokens now reach the deterministic
  builder. Benchmarks show sub-millisecond build time and ~2.5 K-token output
  at that scale for orchestrator-shaped corpora, and the builder's
  per-section caps bound most sections; an **aggregate** output ceiling
  (worst case: very many user turns at 2 000 capped chars each) remains
  deliberately out of scope here and is tracked as #254's shrink ladder.
  Interim risk accepted: it existed identically for every compaction under
  the operator's 400 000 workaround.
- The schema mirror (`settings.schema.json`), README threshold/clamp tables,
  and fixture tests are updated in lockstep with `lib/settings.ts` per the
  extension's established doc-sync obligations.
