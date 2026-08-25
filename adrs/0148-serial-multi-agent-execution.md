---
status: Accepted
date: 2026-08-25
---

# ADR-0148: Serial multi-agent execution and consensus replication

**Status:** Accepted
**Date:** 2026-08-25
**Tracking issue:** #1055
**Partially supersedes:** [ADR-0001](0001-subagent-orchestration-substrate.md), [ADR-0004](0004-consensus-by-replication.md), and [ADR-0095](0095-deterministic-expertise-fanout-gate.md)

## Context and Problem Statement

The orchestration substrate required concurrent fanout for multi-agent research, review, and replicated consensus. Invocation counts supplied useful coverage, but concurrency coupled independent children to provider capacity, local-memory pressure, overlapping prefill, nondeterministic completion order, and batch-specific handoff workarounds. Mitigations such as provider-aware concurrency caps and prompt-footprint reductions treated symptoms while retaining the scheduling source.

The desired invariant is coverage, not simultaneity: research still needs at least three invocations, `/review` still needs three reviewers, `/full-review` still needs four, and replicated consensus still needs multiple independent samples.

## Considered Options

### Keep parallel execution with lower concurrency limits

Rejected. A limit above one preserves resource overlap and scheduling nondeterminism; a limit of one is serial execution under a misleading API.

### Reuse dependent `chain`

Rejected. Chain propagates `{previous}`, returns primarily the final step, and stops at the first failure. Independent research and consensus require no prior-output leakage, complete result aggregation, and continue-on-failure behavior.

### Add serial mode while retaining parallel mode temporarily

Rejected. First-party policy would remain ambiguous and old callers could silently preserve the behavior being retired. This repository controls its orchestration callers and can migrate atomically.

### Replace parallel tasks with independent serial sequence

Accepted.

## Decision Outcome

The `subagent` tool exposes three modes:

- `single`: one isolated child;
- `sequence`: up to eight independent items, executed in caller order with concurrency exactly one, continuing after child failures and returning every result;
- `chain`: dependent serial steps with optional `{previous}`, stopping on the first failure.

The former `tasks` parallel mode is removed rather than deprecated. One frozen model-availability/routing snapshot serves the whole sequence, while live session deny state remains visible between children.

Research uses one `sequence` call with at least three invocations. Synthesis and Agent Efficacy Reporting occur only after the sequence completes. Workflow invocation counts do not change.

Consensus-by-replication becomes serial replication: the initial run is followed by N−1 explicit sequence entries using the same agent, byte-identical prompt, source scope, and canonical expertise block. Earlier outputs are never inserted into later replicas. Failed runs are not votes. The existing unanimous, majority, even-split, and singleton-novel aggregation ladder remains.

The historically named `expertise-fanout-gate` retains its component identity for installation and telemetry compatibility, but its runtime trigger changes from `tasks` to research-shaped `sequence`. It performs one search and injects the identical canonical block into every sequence item before execution.

## Consequences

### Positive

- No concurrent child prefill or tool execution within one orchestration call.
- Deterministic start and result order.
- Independent failures do not erase later specialist coverage.
- Replicated consensus is protected from prior-result anchoring.
- Invocation-count and expertise-coverage policy remains intact.

### Negative

- Multi-agent wall-clock latency becomes cumulative.
- Immediate schema removal breaks callers still sending `tasks`.
- Historical parallel terminology requires coordinated rule, prompt, reference, test, and patch-manifest migration.

## Supersession Scope

ADR-0001 remains authoritative for isolated subprocesses, wrappers, tool restrictions, and parent-owned routing; its parallel scheduling decision is superseded.

ADR-0004 remains the historical rationale for replication and its aggregation ladder; its single-call parallel composition is superseded by explicit serial replicas.

ADR-0095 remains authoritative for deterministic canonical search, approval binding, and authentication boundaries; its parallel-task trigger is superseded by serial-sequence derivation.
