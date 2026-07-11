---
status: Accepted
date: 2026-07-06
---

# ADR-0081: Spawn-time oMLX liveness gate for subagent pins

**Status:** Accepted
**Date:** 2026-07-06
**Tracking issue:** #534
**Related:** [ADR-0076](0076-model-tier-policy-and-precedence-guard.md) (Q2.D deferred this exact scope to #534 — this ADR graduates it as a sibling, the same lineage that produced ADR-0078 and ADR-0080 from that ADR's other two named deferrals; ADR-0076's body is not edited), [ADR-0080](0080-copilot-fallback-rung.md) (the Copilot fallback rung a liveness-dropped pin now falls into), [ADR-0035](0035-copilot-live-model-discovery.md) / #364 (the live-probe pattern this reuses).

## Context and Problem Statement

The #519 spawn gate checks **registry presence** only: a slash-qualified `omlx/coding-workhorse` pin reaches a child's `--model` whenever the oMLX provider is registered, regardless of whether the local server is actually up. With the server down, every pinned fan-out child gets the pin and dies at the first provider request. ADR-0076 Q2.D named this gap and deferred it to #534, noting `omlx-discovery.ts` (#364) already has the right probe semantics and would move to `shared/`.

## Considered Options

### Q1 — Integration mechanism (the load-bearing decision)

**Chosen: hybrid — pre-filter the decision, a note-only param for honesty.** The pass/fail decision is made by removing confirmed-down `omlx/*` ids from the effective `availableIds` *before* `resolveModelPin` runs (`filterDownOmlxIds`), so the existing pinned→fallback→default ladder (ADR-0080) treats a down pin exactly as a registry-absent one and the Copilot rung engages with **zero new branching**. Layered on top, a note-only 4th param `servedOmlxIds` lets the note distinguish "the oMLX server appears to be down" / "up but not serving this model" from the generic "not available on this host" — a real operational distinction (restart the process vs. edit `models.json`). Rejected: (a) pure pre-filter with no note param — loses the down-vs-absent distinction, actively misleading during diagnosis; (b) a liveness param that also drives the decision — duplicates the has/absent branching `availableIds` already does, doubling the surface that must stay in sync. The hybrid is the ADR-0080 tier-gated-vs-absent idiom applied to a second axis.

### Q2 — Fail-open semantics at the gate

**Preserve #364's dual contract exactly.** `resolveOmlxFilter` returns `null` for an inconclusive probe (timeout, 401/5xx, malformed) OR no omlx registered → **fail open** (pass the pin, same as today; a saturated-but-alive server mid-prefill is never falsely dropped). A non-null `Set` is authoritative **even when empty** (connection refused → server confirmed down → drop every omlx id). `filterDownOmlxIds` branches on `=== null`, never a truthy `.size` check — an empty Set is truthy, so a `.size` guard would silently defeat the confirmed-down case (the exact bug this gate exists to close). Registry-unreadable (`availableIds === null`) also passes through untouched: liveness never converts the gate's fail-open posture to fail-closed.

### Q3 — Probe placement and cost

**Once per tool call, lazy.** `buildOmlxLiveness` probes a single time in `execute()` (never per child — a fan-out of up to 8 children at concurrency 4 must not thundering-herd the local server), and only when some `omlx/*` id is registry-present (a host with no oMLX block pays zero — no network call). Mirrors ADR-0080 Q3's once-per-call discipline for the Copilot probe. The subagent extension registers its own `session_start` `clearOmlxCache()` so freshness never depends on auto-router being loaded in the same process.

**Clarification (#651):** the selected probe base follows the same local-only trust boundary while avoiding a duplicate localhost source of truth: explicit dependency override / `OMLX_BASE_URL` / configured `omlx` provider `baseUrl` / `http://localhost:8000/v1`, then loopback validation. A configured non-loopback provider URL remains out of scope and fails open (no probe) rather than probing default localhost and deriving a false "server down" signal for a different endpoint. True non-loopback oMLX support would require a separate ADR.

### Q4 — Module relocation

`omlx-discovery.ts` and its test move `auto-router/` → `shared/` (its one non-builtin import, `FetchLike` from `copilot-discovery.ts`, is already in `shared/` post-#536, so the move is import-trivial); two auto-router import sites rewrite to `../shared/`; the `pi-auto-router` mirror `inline:` list gains `omlx-discovery`. The subagent extension ships via the replace-mode `pi-config` target and needs no mirror wiring (same conclusion ADR-0080 recorded for the Copilot rung).

## Decision Outcome

`filterDownOmlxIds` pre-filters the effective menu; `resolveModelPin` gains a note-only `servedOmlxIds` param + `pinAbsenceReason` helper; `buildOmlxLiveness` probes once per `execute()`, lazily; the `session_start` hook clears the oMLX cache. Behavior is byte-identical to pre-#534 whenever the probe is inconclusive or no omlx pin is in play.

### Accepted residual

The shared discovery cache has a 60s TTL, so the spawn gate can act on state up to 60s stale (a server that died or recovered within the window). This **narrows** ADR-0076's "registry presence ≠ liveness" gap from "always" to "up to 60s," rather than fully closing it — consistent with ADR-0035/ADR-0080's already-accepted staleness for the Copilot probe.

## Doc-Impact

| Surface | Classification | Reason |
|---|---|---|
| `adrs/0081-*.md` | in-scope | this ADR |
| `agent/extensions/subagent/README.md` | in-scope | liveness dimension in the spawn-gate section |
| `agent/extensions/auto-router/README.md` | in-scope | `../shared/omlx-discovery.ts` in the Files table + the #364 section relocation note |
| `agent/extensions/shared/README.md` | in-scope | new `omlx-discovery.ts` module row + subagent added to the consumer list |
| `agent/AGENTS.md` | in-scope | model-pin prose gains "registered-but-down oMLX" |
| `agent/skills/pi-agent-expert/references/subagent-internals.md` | in-scope | the `resolveModelPin` gate comment |
| `README.md` | in-scope | ADR-0081 index row + directory-tree file move |
| `mirror/targets.yml` | in-scope | `omlx-discovery` in `pi-auto-router.inline` |
| `scripts/validate.sh` | not-a-thing | test runners are glob-based; no check names the module |
| `agent/models.example.json` | not-a-thing | provider registration unchanged |
