---
status: Accepted
date: 2026-07-20
---

# ADR-0109: compaction-optimizer — prefix-cache-aware when-policy (defer mid-phase, trigger at phase boundaries)

**Status:** Accepted
**Date:** 2026-07-20
**Amends:** [ADR-0019](0019-compaction-optimizer-extension.md) § charter — the extension now owns compaction *timing* alongside summary *construction* (supersession by addition: a third forward-pointer blockquote in ADR-0019; original prose unchanged)
**Related:** pi_config #677 (delivery issue), #244/[ADR-0107](0107-compaction-hybrid-relative-token-gate.md) (prerequisite: window-relative input gate keeps policy-triggered compactions air-gapped), #254/[ADR-0108](0108-compaction-output-shrink-ladder.md) (bounded output), #772 (unified optimization-layer state — `shared/phase-state.ts` is its expected foundation), [ADR-0094](0094-local-llm-role-lever.md)/[ADR-0106](0106-payload-tuner-extension.md) (user-layer-only trust posture for local-LLM levers), psmfd/local-llm#44 + workhorse-probes (motivating measurements: ~24.6 s cold vs ~7 s warm prefill on the M5 Max host)

## Context and Problem Statement

compaction-optimizer controlled only *how* a compaction summarizes; *when*
was pi's token-threshold trigger — the worst timing on a prefix-cached,
prefill-bound local host: compaction rewrites the conversation prefix,
invalidating the oMLX block-hash KV cache, so the next turn pays a full
cold prefill. A threshold fire mid-fan-out stacks that cost across
concurrent subagents. Both control points exist in pi's extension API
(`{cancel: true}` from `session_before_compact`; `ctx.compact()`), but no
extension in this repo had ever used either, and no live cross-extension
phase signal existed.

## Considered Options

1. **Deferral-only V1**, proactive trigger deferred until a phase signal
   exists — safe but leaves the cohesion gap (compactions still happen at
   arbitrary moments, just bounded-late).
2. **Full when-policy with a shared phase-state module** (chosen) — build
   the missing signal properly in `shared/` and ship deferral + proactive
   trigger together.
3. **Upstream pi feature** (native phase-aware compaction) — out of our
   control and unnecessary given the extension API suffices.

## Decision Outcome

Option 2. Three parts:

### 1. `shared/phase-state.ts` — session-keyed in-memory phase signals

Producers: auto-router publishes its task-type label at routing time
(label-change stamps the turn; republishing the same label does not reset
the boundary clock); compaction-optimizer wires `turn_end` (turn counter)
and the generic `tool_execution_start/end` events filtered on
`toolName === "subagent"` (in-flight fan-out tracking — the same
zero-coupling pattern expertise-fanout-gate established). Consumers: the
when-policy below; #772's unified state is expected to build on or beside
this module rather than add a second store. Process-local, no I/O; a
session with no recorded state reads as "no signal", never as a phase
judgment.

### 2. Deferral (`session_before_compact` veto)

Pure gate `decideDefer` (`lib/timing.ts`), AND-chained early returns whose
only path to `{cancel: true}` requires ALL of: `timing.enabled`;
`event.reason === "threshold"` (strict equality — unknown values never
defer); provider ∈ `timing.providers`; known positive `contextWindow`
(**no absolute-token fallback**, deliberately unlike ADR-0107's input
gate: cancelling is the dangerous direction, so an uncomputable ceiling
resolves to "do not defer"); `tokensBefore` below
`deferCeilingFraction × contextWindow`; deferrals below `maxDeferrals`;
and a positive mid-phase signal (fan-out in flight, or task-type label
unchanged for more than `boundaryWindowTurns`). The veto runs immediately
after settings load and **before** the file-tracker prune and snapshot
capture — both are wasted work on a deferred fire, and a cancelled
compaction never commits (verified: pi's cancel branch returns before
`appendCompaction`; `session_compact`/archive never fire; `fileOps` is
rebuilt fresh on every `prepareCompaction`, so prune-then-cancel cannot
corrupt state). One toast per deferral episode (`notifyOnce` keyed
`defer:<session>:active`), re-armed when a compaction commits.

### 3. Proactive phase-boundary trigger (`agent_settled`)

Pure gate `decideProactive`: enabled + provider listed + known window +
usage ≥ `proactiveAtFraction × window` + no fan-out in flight + the
task-type label changed since the last committed compaction + that change
is within `boundaryWindowTurns`. On fire: arm a session-scoped self-flag,
notify, `ctx.compact({onError: disarm})`. Mis-detection is bounded by
construction: the usage precondition means the worst case is an early
compaction the threshold trigger would soon force anyway — never a novel
one.

### Contracts we rely on (first-party-verified, pinned pi v0.80.10-psmfd.1)

| # | Contract | Source |
|---|---|---|
| 1 | `event.reason: "manual" \| "threshold" \| "overflow"` is a top-level `SessionBeforeCompactEvent` field | `dist/core/extensions/types.d.ts:437`; `docs/compaction.md:279` |
| 2 | `{cancel: true}` on a threshold fire is side-effect-free: `_runAutoCompaction` returns before `appendCompaction`; pi re-checks after every `agent_end` with no cooldown (deferral cadence is extension-owned) | `agent-session.js:1585-1643` |
| 3 | **Cancelling `reason:"overflow"` with `willRetry` wedges the session**: pi strips the failed turn's error message *before* the hook fires; cancel restores nothing and retries nothing | `agent-session.js:1535-1558,1642` |
| 4 | `ctx.compact(options?)` is on the base `ExtensionContext` (callable from any handler), always re-enters `session_before_compact`, and reports `reason:"manual"` — indistinguishable from a user `/compact`, hence the self-flag; the emit is synchronous within the arming call chain, so the flag cannot be consumed by an interleaved compaction | `types.d.ts:199-203,238`; `agent-session.js:1373-1485` |
| 5 | Pi's threshold trigger is `contextTokens > contextWindow − reserveTokens` (default 16384) — an absolute-token cutoff, **not** a fixed fraction | `compaction/compaction.js:137-141`; `docs/compaction.md:35` |
| 6 | The subagent-spawn tool is registered as `name: "subagent"`; `tool_execution_start/end` fire for it like any tool | `agent/extensions/subagent/index.ts:681`; `docs/extensions.md:628-639` |

### Deferral ceiling arithmetic

Deferral band = `reserveTokens − (1 − deferCeilingFraction) × contextWindow`.
On the 131,072-token omlx workhorse with defaults: pi fires at ≈114,688
(87.5 %), ceiling at 117,965 (90 %) → **≈3,277-token band** (roughly 1–3
turns). The band reaches zero at `contextWindow = reserveTokens / (1 −
ceiling)` = 163,840 tokens — on larger-window (cloud) models the policy
can never defer, which is why it is provider-scoped (`["omlx"]`) and why
the ceiling stays a fraction, computed live per fire from
`ctx.model.contextWindow` (the ADR-0107 read idiom). Record kept here so a
future `reserveTokens` or model change re-derives instead of cargo-culting.

### Trust posture and defaults

All `timing.*` keys are **user-layer only** — the project layer is
rejected wholesale (same posture as ADR-0094/ADR-0106 local-LLM levers): a
cloned repository must not influence when this host defers or triggers
compactions. `enabled: false` by default per #677's guardrail; the
operator enables it locally for measurement. `HybridResult.reason` and the
path-taken notify vocabulary are unchanged; the three new notify messages
(defer, ceiling, proactive) are distinct message classes.

### What V1 phase detection does NOT do

No cache-meter CHR input (post-hoc JSONL, session-ambiguous — V2 candidate
via phase-state), no semantic "new goal" detection, no reliance on
auto-router's `task-types.jsonl` (no session id; the live signal now flows
through phase-state instead). Absent signals always read as "not provably
mid-phase" → compact normally.

## Consequences

- The extension's charter expands from *how* to *when + how*; ADR-0019's
  contracts table citations remain at v0.75.5 for the original rows while
  this ADR's table is verified at the current pin.
- Worst-case failure modes are bounded to today's behavior: with the
  policy disabled, misconfigured, or its signals absent, every fire
  proceeds exactly as before; deferral is capped by ceiling + counter;
  proactive fires only where a compaction was imminent.
- Doc-sync: extension README (modes/timing section, notify table, settings
  table), `settings.schema.json`, `shared/README.md` module row,
  auto-router publish hook comment, `security/scanning-decisions.md`
  line-shift note (third), repo README ADR list.
