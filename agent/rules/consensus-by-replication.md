---
description: Codify consensus-by-replication as a first-class fan-out shape alongside role divergence, with aggregation rules for design-recommendation splits
---

# Consensus by Replication

This rule names a second fan-out shape for subagent orchestration. Both shapes — replication and divergence — satisfy `research-parallelism.md`'s ≥3-subagent minimum. The choice between them, and the aggregation rule for replicated outputs, is what this rule covers.

Full design rationale lives in [ADR-0004](../../adrs/0004-consensus-by-replication.md). The empirical basis is recorded in issue #76.

## When This Rule Applies

When a task calls for parallel fan-out under `research-parallelism.md` AND meets one of the following:

- Implementation planning with ≥3 open design decisions
- Spec interpretation where independent reasoning chains over the same source are more valuable than independent expertise lenses
- Validating a single reviewer's findings against false-positive risk
- Ambiguity-rich research where the question is not "what lens do we apply" but "do independent thinkers reach the same answer"

When the task instead calls for distinct lenses on a finished artifact (a finished PR, a security review of an existing module, a multi-discipline architecture review), use **divergence** — the existing default — and this rule does not apply.

The two shapes are composable in one fan-out call (see § Composition).

## What Counts as Replication

- N invocations of the **same** subagent
- With **identical** prompts (Source path, Brief, Output Format)
- Submitted as a single `subagent` call with `tasks: [...]`

The same subagent invoked twice with **different** prompts is NOT replication — it produces non-comparable artifacts, and `research-parallelism.md` § What Counts Toward the Minimum already excludes that shape from the parallelism minimum. This rule does not change that exclusion.

N is typically 3, matching the parallelism floor. N > 3 is allowed where the decision stakes warrant the linear token cost; the aggregation ladder below scales without modification.

## Choosing Between Replication and Divergence

| Replication | Divergence |
|---|---|
| Planning a new implementation with multiple open design axes | Reviewing a finished artifact (e.g. `/review` on a diff) |
| Independent reasoning over an ambiguous spec | Cross-domain coverage (.NET + security + style) |
| Validating reviewer findings against false-positive risk | The catalog has three specialists each contributing distinct lenses |
| Spike validation — independent corroboration of an architectural pattern | Coverage breadth is the explicit goal |

The cost/benefit case for replication is strongest where dissent has product value (escalation surfaces) and weakest where coverage breadth is the goal (multi-discipline reviews).

## Aggregation Ladder for Replicated Outputs

This ladder is distinct from `structured-review-format.md`'s most-severe-wins rule. Most-severe-wins is for **verdicts** (PASS / NEEDS_CHANGES / etc.); replication aggregation is for **design recommendations** where severity is not the comparison axis.

- **Unanimous (N:0).** Adopt without modification. Confidence in the recommendation is now multi-instance corroborated.
- **Majority split (2:1, 3:1, etc.).** Orchestrator chooses; documents the dissent verbatim in the Agent Efficacy Report. Default is to follow the majority. The dissenting position is adopted only when it cites first-party evidence the majority missed (e.g. a doc link, a code snippet from the source-of-truth). "More elaborate reasoning" is not first-party evidence.
- **Even split (1:1:1, 2:2).** Escalate to the user. The pattern's value here is exactly to surface "this is not a technical decision — it requires product or operator judgement." Do not silently break the tie.
- **Singleton novel contribution.** A high-value point made by exactly one instance and not refuted by the others. Adopt and credit the instance in the Agent Efficacy Report. (Examples from #76: `FOR UPDATE` waiter strategy, principal-sub in hash inputs, architecture test for filter attachment — each surfaced in 1 of 3 planning instances.)

## Composition

Replication and divergence can be mixed in one `subagent.tasks: [...]` call. Typical patterns:

- **2× domain-expert + 1× security-review-expert** — replicated planning for a security-sensitive change, with security as a parallel divergent lens.
- **3× domain-expert + 1× code-review-expert** — replication-validated design + requirement-fidelity reviewer (within the 4-task cap; 4 tasks is allowed by the extension).

Aggregation is per-slot:

- Replicated slots aggregate via the ladder above.
- Divergent slots aggregate via `structured-review-format.md`'s most-severe-wins (for verdicts) or per-domain merge.

The fan-out remains a single `subagent` call; sequential follow-ups are not composition under this rule.

## Cost

- Linear in N. Three replicated runs of a 30-second brief cost ~3× the tokens and ~3× the wall time, capped by the extension's concurrency limit (4).
- The cost case is justified by either (a) high stakes per decision — architectural planning, security-sensitive design, spec interpretation — or (b) explicit need to surface dissent. For low-stakes lookups, a single agent is correct.

## Agent Efficacy Report Additions

For runs that include replication, the Agent Efficacy Report (per `research-parallelism.md` § Agent Efficacy Reporting) gains two structural requirements:

1. **Replication summary** — N runs, agreement matrix per open decision (unanimous / majority / even / singleton).
2. **Singleton contributions credited explicitly** — each novel high-value point named, with which instance produced it.

The disagreements section already exists in the standard report; for replicated fan-outs it MUST enumerate every non-unanimous decision, not just the highlight.

## Worked Example

`agent-expertise-api#188` planning phase (recorded in pi_config #76):

- **Composition.** 3× `dotnet-expert`, identical 4-page brief covering 10 open design decisions for an Idempotency-Key implementation.
- **Outcome.** 6 unanimous decisions adopted. 2 decisions split 2:1 (RequireKey default soft vs hard; store as singleton vs scoped) — both escalated to the user as product/operator policy axes. 1 decision split 1:1:1 on a sizing parameter (response body cap) — escalated to the user with the three positions enumerated.
- **Singletons adopted.** `FOR UPDATE` waiter strategy (instance B), principal-sub in hash inputs (instance C), architecture test asserting filter attachment to exactly three endpoints (instance A) — all three landed in the implementation; none had been raised by the other two instances.
- **Outcome consistency.** Subsequent spike (3× same shape) confirmed the architectural pattern PATTERN_VALIDATED with 4-of-4 unanimous; subsequent review-fix validation (3× same shape) corrected 5 reviewer findings and identified 1 as a false positive that a single agent would have acted on.

Three runs across three distinct phases, each producing behaviour the playbook treats as desirable, is what motivated ADR-0004 and this rule.

## Anti-Patterns

- **Repeating the same agent until you get the answer you wanted.** Re-running because the first three replicated did not match a prior conviction is not replication — it is shopping. Document the original ladder outcome and escalate; do not iterate.
- **Treating a majority as unanimous.** A 2:1 split is dissent. The Agent Efficacy Report MUST record the minority position verbatim, even when the majority is adopted.
- **Silently breaking a 1:1:1 tie.** Even splits escalate. The pattern's value is the escalation surface; collapsing it to an orchestrator preference defeats the technique.
- **Using replication for finished-artifact review.** `/review` is divergence by design. Replicating `code-review-expert` 3× over a diff does not surface lenses the catalog already provides; it costs tokens without benefit.
