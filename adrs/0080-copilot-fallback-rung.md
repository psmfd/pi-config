---
status: Accepted
date: 2026-07-06
---

# ADR-0080: Copilot fallback rung in the subagent spawn gate

**Status:** Accepted
**Date:** 2026-07-06
**Tracking issue:** #536
**Related:** [ADR-0076](0076-model-tier-policy-and-precedence-guard.md) (the tier ladder whose deferred Copilot rung this implements — named there twice as tracked #536 scope; this ADR is a sibling per the ADR-0078 graduation precedent, not an amendment), [ADR-0035](0035-copilot-live-model-discovery.md) (the live tier filter this reuses), #546 (matrix-aware selection, the deferred next iteration), #534 (spawn-time liveness gating for the omlx rung).

## Context and Problem Statement

The #519 spawn gate drops an unresolvable frontmatter `model:` pin entirely — the child inherits the session default, typically a **paid frontier API model**. ADR-0076's ladder puts the Copilot subscription between those rungs: frontier-adjacent quality at subscription (credit) cost, no marginal API dollars. With the workhorse pin covering 14 read-only fan-out specialists, a dead oMLX server currently sends the entire fan-out to the most expensive rung.

## Considered Options

### Q1 — Ladder shape

**A dropped qualified pin consults one Copilot fallback before the session default; a dropped `github-copilot/*` pin never substitutes a sibling.** A dropped Copilot pin usually means the whole rung is dead (not logged in) — substituting another Copilot id would mislead; the rarer stale-id case still reads better as an explicit note than a silent sibling swap. The gate's fail-open contract is untouched: an unreadable registry passes the pin through verbatim and never consults the fallback (no data to ground a substitution). Every outcome carries a distinct `kind` (`pinned | fallback | default`) and a note naming the rung the child actually ran on — the #519 single "session default" string cannot express substitution honestly.

### Q2 — Fallback target

**Fixed constant `github-copilot/gpt-5-mini`, overridable via user-layer `extensionSettings.subagent.copilotFallbackModel`.** Live research (2026-07-06) established that GitHub retired premium-request multipliers on 2026-06-01 for AI-Credits billing: tokens are billed at published API rates, no 0x/included model exists anymore, and gpt-5-mini is the cheapest picker-enabled chat model ($0.25/$2.00 per Mtok — roughly 0.9 credits per typical read-only child vs ~15 for an Opus-class model; an order of magnitude more fan-outs per monthly allowance). A considered alternative — anchoring to the review trio's `claude-opus-4.7` to keep one canonical Copilot binding — was rejected: the trio pin is the ladder's *quality* rung; this is the *fan-out* rung, and quota economics dominate for 3–14 cheap children per orchestration turn. Matrix-based selection (capable sets per task type) is deferred to #546 — the matrix has no Copilot rows yet. Registry-cost ranking was rejected per the issue. **Correction recorded:** the issue's "registry list prices overstate a subscriber's marginal (quota) cost" premise is stale since the AI-Credits shift — credits bill at list rates, so token-meter's `costTotal` now approximates credit burn (the cache-field unreliability caveat stands).

### Q3 — Live tier-gating

**Required in v1, reusing the existing ADR-0035 module — `copilot-discovery.ts` moves to `shared/`.** Registry presence cannot see subscription gating (the exact over-reporting ADR-0035 exists for); a registered-but-gated `--model` spawns fine and fails at the child's first request — bounded (one failed child, or one stopped chain step; parallel siblings unaffected) but not rare enough to accept when Opus-class gating on Individual plans is documented in ADR-0076 itself. Duplicating a minimal probe in subagent/ was rejected (the ADR-0053 drift lesson). The live set is resolved **once per tool call** — never per agent, so a cold cache cannot thundering-herd at fan-out concurrency — and only lazily, when the fallback id is actually registry-present. Discovery failure yields `liveEnabledIds: null` = fail-open (the registry check alone decides); the subagent extension registers its own `session_start` cache clear so freshness never depends on auto-router being installed. Mirror impact: `pi-auto-router`'s `inline:` list gains the module (7 import sites rewritten); the subagent extension ships via the replace-mode `pi-config` target, which needs no inline work.

### Q4 — Settings trust boundary

User-layer `~/.pi/agent/settings.json` only, the token-meter/ADR-0073 posture: a hostile repo's project-layer settings must not be able to redirect fan-out spend to an expensive model. Any unreadable/malformed value — including a non-`github-copilot/` or slash-less id — falls back to the built-in default (`sanitizeFallbackModelId`).

## Decision Outcome

Three-outcome ladder in `resolveModelPin(pin, availableIds, fallback?)` with `kind` threading to every result surface's `pinNote`; `github-copilot/gpt-5-mini` default with the user-layer override; live tier-gating via the relocated shared `copilot-discovery.ts`, resolved once per call, fail-open on discovery failure; copilot→copilot substitution excluded; #519's fail-open registry contract and byte-identical no-fallback behavior regression-tested.
