---
status: Accepted
date: 2026-07-23
---

# ADR-0122: bound subagent runtime provider failover before tool execution

**Status:** Accepted
**Date:** 2026-07-23
**Related:** [ADR-0080](0080-copilot-fallback-rung.md), [ADR-0083](0083-orchestrator-subagent-model-policy-split.md), [ADR-0090](0090-stable-router-subagent-model-policy.md), [ADR-0094](0094-local-llm-role-lever.md), [ADR-0104](0104-deterministic-model-availability-snapshots.md), #868.

## Context and Problem Statement

Subagent model fallback was limited to spawn-time availability. An unpinned
wrapper could be policy-selected onto a credentialed, live model, spawn
successfully, and then receive a provider HTTP 429 or quota-exhaustion response.
The child terminated even when another provider had an eligible reviewed matrix
row. Parent provider restrictions did not help because ADR-0083 deliberately
keeps parent routing policy separate from child policy.

Blindly replaying a failed child is unsafe. A child may have already edited
files, run shell commands, or called an external API before its provider error.
Retrying such work could duplicate non-idempotent effects. Provider stderr is
also not a trustworthy retry signal because tools and arbitrary child processes
can write similar text.

ADR-0104 keeps runtime provider-deny evidence separate from the immutable
availability snapshot, but its process-local deny set was owned only by
auto-router. Subagent selection supplied a new empty set for every pick, so a
child-observed 429 could not affect reselection or parent routing.

## Considered Options

1. **Return every runtime provider error without retry.** Rejected because a
   reviewed alternate provider may be available and quota failure is not a task
   failure.
2. **Retry every 429-shaped failure.** Rejected because replay after a tool edge
   can duplicate writes or external side effects, and stderr-only matching can
   misclassify tool output.
3. **Refresh provider discovery and the availability snapshot after failure.**
   Rejected because runtime deny evidence is transient and must not replace the
   immutable ADR-0104 generation or silently refresh reviewed policy inputs.
4. **Retry once before any tool execution, using shared session deny state.**
   Chosen. It improves availability while preserving a strict replay boundary.

## Decision Outcome

Introduce one process-local session-unavailable model set shared by auto-router
and subagent selection. The set contains qualified `provider/id` values only,
is cleared at session start, and is cleared in-session only by the existing
`/auto matrix refresh --retry-unavailable` command. It remains dynamic evidence:
it neither mutates `routing-matrix.json` nor changes the canonical availability
snapshot generation or hash.

An unpinned, policy-selected child may retry exactly once when all of these are
true:

1. The child emits a structured assistant `message_end` event.
2. `stopReason` is `error` and `errorMessage` conclusively matches provider
   429/quota/rate-limit forms.
3. No `tool_execution_start`, `tool_execution_update`, or
   `tool_execution_end` event was observed during that attempt.
4. Policy reselection against the same candidate snapshot and reviewed matrix,
   excluding the newly denied model, returns an eligible alternate.

The original task, working directory, wrapper, tool allowlist, guard profile,
environment policy, expertise injection, abort signal, and snapshot identity are
preserved. The logical task has a maximum of two child spawns. A second provider
failure is final and the second rate-limited model is also denied.

No runtime retry occurs for:

- explicit wrapper `model:` pins;
- session-default children that had no policy-selected model;
- aborts, spawn failures, stderr-only matches, generic provider failures, or
  tool-result text containing 429 language;
- any attempt that emitted a tool-execution event.

Explicit pins remain authoritative and return their original failure. This
avoids silently overriding an operator's exact model decision.

Structured result details record attempted models, failed and fallback model,
outcome, and snapshot generation/hash. Rendering reports successful, failed,
no-alternate, and refused-after-tool outcomes without retaining arbitrary raw
provider error text in the failover telemetry. Usage from both attempts is
aggregated into the logical child result.

## Consequences

- Quota exhaustion can fail over from Copilot to an eligible Codex or other
  provider row without changing wrapper policy.
- Auto-router and child policy stop selecting a model that either path observed
  as rate-limited during the session.
- Parallel tasks share deny evidence; tasks already in flight may each complete
  their independently bounded first attempt, but each logical task can add at
  most one replacement spawn.
- Availability is intentionally sacrificed after any tool edge. Operators see
  why retry was refused rather than risking duplicate mutations.
- A provider whose quota recovers during the session remains excluded until
  explicit retry-unavailable refresh or the next session.
- The subagent extension gains downstream patch #17 and the auto-router mirror
  must inline the new shared module.

## Verification

- Shared tests cover rate-limit recognition, qualified model IDs, and clearing.
- Policy tests prove denied models are excluded from deterministic reselection.
- Spawn integration tests cover successful fallback with aggregated usage,
  second 429, no alternate, explicit pin, session-default and stderr/generic
  errors, abort, post-tool refusal, and parallel/chain ordering.
- Auto-router tests retain explicit clear/preserve behavior for session deny
  state.
- Required gates: shared, auto-router, and subagent suites; extension type-check
  and lint; subagent drift validation; mirror validation; full repository
  validation and aggregate review.
