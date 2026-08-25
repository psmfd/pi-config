---
description: Enforce serial multi-agent research with minimum three invocations, complete synthesis, and agent efficacy reporting
---

# Research Serial Execution

This rule is mandatory. When `orchestrator-protocol.md` classifies a task as Research, invoke the required specialists one at a time in one `subagent` `sequence` call.

## When This Rule Applies

It applies to investigation, debugging, exploration, tool evaluation, architecture or infrastructure decisions, comparisons, and domain questions covered by custom subagents.

## Requirements

- Invoke at least three subagents unless fewer than three relevant catalog entries exist.
- Use one `subagent` call with `sequence: [...]`; invocation count and specialist coverage do not decrease.
- Sequence order is deterministic and concurrency is exactly one.
- Independent items receive isolated prompts. Never expose an earlier result to a later item or use `{previous}` in `sequence`.
- Wait for the complete sequence before synthesis. Do not present or act on partial results.
- A failed item does not stop later independent items. Report incomplete coverage and exclude failures from votes.
- Compare and combine results; identify disagreements and justify the selected position.

## What Counts Toward the Minimum

- Catalog subagents count once per independent invocation.
- Inline work counts only when no custom subagent covers the angle.
- Different prompts to the same agent do not create replicated consensus.
- N serial invocations of the same agent with the identical prompt and canonical expertise block count as serial replication. See `consensus-by-replication.md`.
- `/review` and `/full-review` satisfy the count with their three- and four-item serial sequences.

## Agent-Behavioral Composition

A change to agent constraints, wrappers, prompts, skills, or rules must include `code-review-expert` as one of the three sequence items for requirement fidelity. A typical sequence is subject expert, structural/docs expert, then code reviewer. This does not apply to typo-only or additive factual content.

## Ground-Truth Source Precondition

Review agents must read the actual source before findings. Each review brief must include `Source path:` naming a readable working tree, revision range plus repository, or explicit files. Missing or unreadable source produces `PRECONDITION_FAILURE`, not speculative findings. Every finding must cite observed `file:line` evidence. Advisory research with no artifact must identify itself as research mode.

## Dependency Liveliness

Recommendations for external dependencies must assess last release, recent commits, issue/PR activity, contributor concentration, issue age, and CI health. Report:

```text
Liveliness: Active | Maintenance-only | Stale | Abandoned
Last release: <date or none>
Commit activity: <summary>
Risk level: Low | Medium | High
```

Do not recommend an abandoned dependency without explicit justification and mitigation.

## Agent Efficacy Reporting

Every research, planning, review, and implementation phase that invokes subagents ends with an Agent Efficacy Report after the full sequence completes. Include:

1. Each agent, outcome, contribution, and usefulness.
2. Disagreements and the selected resolution, or `None`.
3. Synergies between outputs.
4. Specific custom-agent improvement opportunities.
5. A machine-readable aggregate verdict using most-severe-wins where verdicts apply.

Never issue an efficacy report between sequence items; that could anchor later independent runs.
