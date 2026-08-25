---
description: Codify consensus by serial replication using identical isolated runs and an explicit aggregation ladder
---

# Consensus by Serial Replication

Serial replication invokes the same subagent N times, one at a time, with the identical prompt and identical canonical expertise block. It is the consensus form of `research-serial-execution.md`; role divergence remains the complementary form.

Design rationale is superseded by ADR-0148; ADR-0004 remains the historical record of the former parallel protocol.

## When to Replicate

Use serial replication when confidence in interpretation matters more than breadth, including architecture choices, ambiguous specifications, reviewer-finding validation, and decisions whose recommendation may vary between model runs. Use divergent specialists when the problem spans distinct domains.

## Independence Contract

A replicated slot must have:

- the same agent wrapper;
- byte-identical task text;
- the same `cwd` and source scope;
- the same canonical expertise injection;
- no `{previous}` placeholder;
- no prior result, synthesis, commentary, or vote included in a later prompt.

Represent replicas explicitly as repeated `sequence` entries. There is no replication flag and no hidden retry:

```json
{
  "sequence": [
    { "agent": "pi-agent-expert", "task": "<identical prompt>" },
    { "agent": "pi-agent-expert", "task": "<identical prompt>" },
    { "agent": "pi-agent-expert", "task": "<identical prompt>" }
  ]
}
```

N is normally three. Additional replicas increase confidence at linear token and latency cost. A failed run is not a vote. Retry only under an explicitly declared retry policy; otherwise report incomplete consensus.

## Aggregation Ladder

Aggregate only after every replica finishes:

1. **Unanimous** — adopt the shared recommendation.
2. **Majority** — the orchestrator chooses the majority position and documents dissent.
3. **Even split** — escalate the decision to the user.
4. **Singleton novel contribution** — evaluate it separately; adopt useful evidence and credit the replica without treating novelty as a majority vote.

## Composition with Divergence

Replication and divergence may share one serial `sequence`. Group identical entries into replicated slots and other agents into divergent slots. Preserve the planned invocation count and deterministic order. Aggregate replicated slots with the ladder above, then combine them with divergent specialist findings using structured-review most-severe-wins rules where applicable.

## Efficacy Report Additions

For each replicated slot, report:

- replica count and successful vote count;
- agreement level;
- every non-unanimous decision;
- failed/non-voting runs;
- singleton novel contributions and whether they were adopted.
