---
status: Accepted
date: 2026-07-11
---

# ADR-0090: Stable orchestrator and subagent model policy under active auto-router

**Status:** Accepted
**Date:** 2026-07-11
**Related:** [ADR-0078](0078-matrix-routing-task-type-override.md), [ADR-0079](0079-matrix-routing-default-on.md), [ADR-0083](0083-orchestrator-subagent-model-policy-split.md), [ADR-0084](0084-auto-router-prefer-local-classifier.md), [ADR-0085](0085-mutation-heavy-agents-stick-to-primary.md), [ADR-0094](0094-local-llm-role-lever.md), [ADR-0104](0104-deterministic-model-availability-snapshots.md), #655, #656, #657, #658, #659, #660, #661, #746

## Context and Problem Statement

The current auto-router and subagent policy split is intentionally conservative:
parent-session routing can choose a model per prompt, while subagent wrapper
frontmatter pins and spawn-time liveness/fallback gates decide child models.
That split avoided accidental child overrides, but it left three gaps now called
out by operator requirements:

1. With `/auto on`, the parent/orchestrator model can drift from prompt to
   prompt. Operators want a stable exact orchestrator model that changes only
   when the user changes it.
2. Some subagents should not use a local LLM. Those children need a provider
   model selected by a capability/cost policy instead of inheriting the parent
   primary or relying on ad-hoc pins.
3. Local-eligible subagents should use the local oMLX `coding-workhorse` by
   default, and model display should tell the operator which effective model a
   child actually used.

The existing matrix routing work already defines a task-type capability floor,
but its ranking language must be sharpened: routing should pick a model only
after capability and availability filtering, local LLMs must rank first when
local use is allowed, and matrix freshness must remain explicit/human-invoked
rather than automatic background policy mutation.

## Decision Outcome

Adopt a stable-router/subagent policy with these terms and invariants:

1. **Orchestrator model lock.** While auto-router is active, the parent session
   may be locked to an exact available `provider/id`. The router must not change
   that exact orchestrator model merely because a classifier/matrix decision for
   a prompt would choose something else. User action changes or clears the lock.
2. **Effective subagent model.** Subagent status/title output should display the
   effective model selected after wrapper pin, liveness gate, fallback, provider
   matrix, or session-default resolution. If it is not known at spawn time, show
   a pending state and update when telemetry reveals it.
3. **Capability floor before rank.** A model must clear the task/subagent
   capability floor before it can be ranked. Matrix absence is closed-world for
   matrix picks but does not remove a model from non-matrix classifier choices.
4. **Local-first cheapest-capable ranking.** When local use is allowed, strict
   local provider matches (`provider === "omlx"` today) rank above non-local
   providers. Within a lane, choose the cheapest capable model using the
   ADR-0078 scalar `input + k·output` with `k = 1`, then smaller context window,
   then `provider/id` lexical order for deterministic ties.
5. **Local-forbidden subagents filter local first.** A child that is not allowed
   to use local LLMs (including unpinned wrappers that omit `tools`, because pi
   defaults may include mutation-capable tools) removes local candidates before
   applying the same capability and cost ranking across allowed providers. If no non-local provider-matrix
   pick exists, the child fails closed instead of inheriting a possibly-local
   session model. OpenAI is the first non-local provider target, but the policy
   is provider-generic and must support Anthropic, Copilot, and local providers
   as matrix rows/config permit.
6. **User-invoked matrix freshness.** Routing never silently refreshes or
   rewrites the capability/provider matrix during prompt classification or
   subagent spawn. Operators invoke status/review/refresh workflows explicitly.
   Those workflows report or replace memory evidence only; a human separately
   edits policy and lands it through reviewed source control and validation.

## Considered Options

1. **Keep current behavior.** The parent can keep changing models under
   `/auto on`, and unpinned children may inherit or be re-routed by child
   processes. Rejected because it violates the operator requirement for a stable
   orchestrator and predictable child policy.
2. **Provider-only parent restriction.** Existing `/auto primary providers ...`
   narrows the parent menu but still permits per-prompt model changes inside the
   provider. Rejected as insufficient; exact model stability is a separate
   concept.
3. **Static wrapper pins for every child.** Encode all child choices as
   frontmatter `model:` pins. Rejected because local-forbidden provider choices
   need capability/cost ranking and provider availability without editing every
   wrapper for every provider rollout.
4. **Automatic matrix refresh.** Refresh capability/provider metadata in the
   background. Rejected because it makes routing decisions less reproducible and
   lets a live endpoint silently mutate policy.
5. **Shared ranking primitive.** Centralize capability-floor filtering and
   local-first cheapest-capable ranking in `shared/` so auto-router and subagent
   policy consume the same deterministic semantics. Accepted.

## Consequences

- Router decisions become easier to explain: first capability, then local
  eligibility, then cost, then deterministic tie-breaks.
- Subagent child routing can become explicit by passing a concrete `--model`,
  keeping child auto-router processes inert and avoiding surprise parent-model
  inheritance.
- Local LLM usage is maximized where allowed, while local-forbidden agents have
  a clear provider-matrix path.
- More policy surfaces exist: exact orchestrator lock state, subagent local
  eligibility, provider matrix rows, and matrix review commands. These require
  tests and documentation.
- Automatic freshness is deliberately not provided. Operators explicitly
  refresh availability evidence, inspect review proposals, and then make any
  capability-policy change manually through source control.

## Implementation Clarification (2026-07-16)

This clarification records the completed #746 implementation without changing
the accepted decision. It is an amendment rather than a successor because no
policy boundary changed: ADR-0104 already owns the canonical-snapshot
architecture, while ADR-0090 still owns explicit freshness and human-only
capability-policy mutation.

- `/auto matrix status [--json]` builds or reuses ADR-0104's canonical snapshot
  and reports typed matrix, generation/hash, filter, coverage, and policy inputs.
- `/auto matrix review [--json]` peeks only at an existing snapshot and emits
  deterministic facts, observations, and human-action proposals. It has no
  apply mode and cannot grant capability or choose a tier.
- `/auto matrix refresh [--retry-unavailable]` is explicit and memory-only: it
  reloads reviewed policy, clears provider/snapshot/decision caches, and builds
  one replacement generation. The transient unavailable set is preserved unless
  retry is requested.
- Parent and subagent policy consume the same frozen Copilot/Anthropic/oMLX
  evidence. Concrete first-party child models are matrix-selected from
  `local-llm` eligibility and optional `capability-tier`; exact wrapper pins
  remain supported but are not used by current first-party wrappers.
- Pi v0.80.6 reloads edited `models.json` through `/model`; operators open that
  picker before refresh when registry configuration changed.
- The maintained schema and side-effect contract is
  [the standalone matrix lifecycle v1 reference](https://github.com/psmfd/pi-auto-router/blob/main/MATRIX_LIFECYCLE_V1.md).

## Implementation Notes

- `agent/extensions/shared/model-ranking.ts` owns `costRank`, local-lane
  ordering, and capability-pick resolution.
- `agent/extensions/auto-router/policy.ts` delegates matrix picks to the shared
  ranking primitive while preserving its public exports for existing tests.
- Exact orchestrator locking, subagent local-eligibility/provider-matrix
  routing, effective-model display, typed status, explicit refresh, and
  deterministic review proposals are implemented by #655–#661 and #746–#751.
