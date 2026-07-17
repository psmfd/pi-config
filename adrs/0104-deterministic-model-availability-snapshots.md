---
status: Accepted
date: 2026-07-16
---

# ADR-0104: share deterministic model-availability snapshots across routing policy

**Status:** Accepted
**Date:** 2026-07-16
**Related:** [ADR-0035](0035-copilot-live-model-discovery.md), [ADR-0078](0078-matrix-routing-task-type-override.md), [ADR-0081](0081-omlx-spawn-liveness-gate.md), [ADR-0090](0090-stable-router-subagent-model-policy.md), #746, #748

## Context and Problem Statement

The capability matrix is a reviewed policy, while `modelRegistry.getAvailable()`
and provider discovery determine which policy rows are usable on one host. The
auto-router parent path applied Copilot, Anthropic, and oMLX live filters. The
subagent provider-matrix path applied only oMLX filtering, while its Copilot
fallback performed a separate discovery. Parent and child could therefore make
different decisions from the same login, and repeated registry/probe reads could
mix observations inside one routing decision.

ADR-0090 requires capability filtering before deterministic ranking and an
explicit, user-invoked freshness model. It does not define how one registry and
provider-availability observation is shared across extension consumers. A
stable ranking function is insufficient when its candidate input changes by
caller or during the decision.

## Considered Options

- **Keep independent parent and subagent discovery.** Rejected. Shared ranking
  cannot compensate for different Copilot/Anthropic/oMLX candidate sets.
- **Probe providers on every prompt and child spawn.** Rejected. TTL-dependent
  observations can change mid-session, complicate explanation, and duplicate
  provider calls during fan-out.
- **Persist availability as capability policy.** Rejected. Host availability is
  ephemeral evidence, not model capability, and must never rewrite
  `routing-matrix.json`.
- **Build one canonical process/session snapshot shared by both consumers.**
  Chosen. It separates reviewed capability from ephemeral availability while
  making each generation reproducible and auditable.

## Decision Outcome

Add a shared availability-snapshot primitive with these invariants:

1. **One registry observation per generation.** Read
   `modelRegistry.getAvailable()` once, then run every provider discovery
   against a fixed wrapper over that exact result.
2. **One provider-filter composition.** Apply Copilot subscription/picker,
   Anthropic served-model, and oMLX server/model evidence in the shared layer.
   Preserve each discovery contract: Copilot and Anthropic failures are
   inconclusive/fail-open; oMLX confirmed-down is a verified empty set.
3. **Canonical immutable output.** Sort candidates and verified model-id sets
   by exact `provider/id`, normalize candidate metadata, and freeze the returned
   arrays/objects.
4. **Stable evidence hash.** Hash canonical registry candidates, filter states,
   and live candidates with SHA-256. Exclude creation time and process-local
   generation number so equivalent evidence has the same hash.
5. **Session-frozen generation.** Parent routing and subagent spawn policy reuse
   the same module-level snapshot until session start or a future explicit
   operator refresh clears it. Concurrent consumers share the same in-flight
   build. Clearing aborts the prior generation so it cannot begin discovery
   after a late registry read; provider-cache epochs ensure a request already
   started before the clear cannot repopulate or overwrite replacement evidence.
6. **Dynamic deny state stays separate.** Provider 429/error observations in
   the auto-router's session-unavailable set are layered after the base
   snapshot. They do not mutate availability evidence or capability policy;
   cached decisions continue to revalidate against that deny set.
7. **No secrets in state or diagnostics.** The snapshot contains provider/model
   identifiers, context/cost metadata, filter states, and hashes only. Managed
   credentials remain request-local inside provider discovery and are never
   cached by the snapshot. Operator status serializes fixed failure codes, not
   arbitrary provider or registry exception text.
8. **Availability never grants capability.** Matrix membership and tier remain
   human-reviewed under ADR-0090. A newly available model is unlisted evidence,
   not an automatically capable row.

The Anthropic discovery module moves into `shared/` beside Copilot and oMLX.
Both auto-router and subagent consume the shared snapshot; subagent pin gates,
fallback selection, and provider-matrix candidates derive from the same
live-filtered IDs.

## Consequences

- Parent and child selection use identical provider availability semantics.
- A model retired by Anthropic or gated by Copilot cannot remain eligible only
  in the subagent provider-matrix path.
- Routing decisions can cite a stable snapshot hash and generation.
- Provider recovery during a session is not observed until an explicit clear;
  session start clears automatically, and `/auto matrix refresh` is the
  implemented operator-controlled in-session replacement path (#749).
- A failed registry read leaves no cached snapshot. Parent routing preserves its
  outer fail-soft behavior; subagent qualified pins retain their historical
  registry-unreadable fail-open behavior while provider-matrix selection has no
  candidates.
- Standalone mirrors must ship the snapshot and all three discovery modules as
  one dependency closure.

## Verification

- Shared tests prove one registry read, all-filter composition, immutable
  canonical ordering, stable hashes under reversed input order, cache reuse,
  explicit generation clearing, stale in-flight provider-write rejection,
  bounded remote discovery, not-applicable providers, and authoritative empty
  oMLX evidence.
- Auto-router tests prove routed candidates come from the shared generation.
- Subagent tests pin the shared snapshot wiring and prevent return to a direct,
  oMLX-only `getCandidates` path.
- Required gates: shared, auto-router, and subagent tests; subagent drift
  validation; extension type-check/lint; mirror dry-run; `scripts/validate.sh`.
