---
description: Require multi-result serial subagent briefs to use durable Form A or complete inline Form B handoffs
---

# Subagent Sequence Handoff

**Scope:** Every multi-item `subagent` `sequence` invocation.

Each independent item must return its full report in one of two forms so the orchestrator can aggregate complete evidence after the sequence.

## Form A — Artifact

Use for write-capable agents:

```text
REPORT_FILE: <path under the approved artifact location>
Summary: <one-line summary>
Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE
```

The report file contains the full findings. Tier 3 review artifacts must use `artifact_review` under `.review/`.

## Form B — Inline

Use for read-only agents:

````text
```report
<complete report>
```
Summary: <one-line summary>
Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE
````

The fenced block must be complete and self-contained.

## Serial Independence

- Do not reference another sequence item's output.
- Do not ask later items to verify or extend earlier items unless using dependent `chain` mode instead.
- The orchestrator waits for all items and performs aggregation only afterward.
- A failed item does not suppress reports from later items.

## Expertise Candidates

Expertise candidates are additional payloads, never replacements for Form A/B. The subagent extension extracts and coalesces candidates across all completed sequence items. `expertise-fanout-gate` retains its established component name and surfaces coalesced groups for interactive approval; children never invoke `expertise_create`.

## Aggregate Verdict

Use `structured-review-format.md`: `NEEDS_CHANGES` wins over `PASS_WITH_WARNINGS`, which wins over `PASS`. `PRECONDITION_FAILURE` marks incomplete coverage but does not overwrite successful reviewers' substantive verdicts.
