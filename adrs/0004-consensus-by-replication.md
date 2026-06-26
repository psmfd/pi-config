# ADR-0004: Consensus-by-replication as a first-class fan-out shape

**Status:** Accepted
**Date:** 2026-05-19
**Companion to:** [ADR-0001](0001-subagent-orchestration-substrate.md)
**Tracking issue:** #76

## Context and Problem Statement

ADR-0001 established the orchestration substrate and `agent/rules/research-parallelism.md` mandated a ≥3-subagent fan-out for research tasks. The rule, the agent catalog, and the `/review` / `/full-review` workflows are all framed implicitly around **role divergence** — different agent types covering different lenses (e.g. `code-review-expert` + `security-review-expert` + `linter`). The orchestrator picks three complementary specialists, each viewing the artifact through its own discipline.

In practice the orchestrator has been using a second, distinct fan-out shape that the playbook does not name: **consensus-by-replication** — invoking the same subagent N times with identical prompts. Three empirical instances have now produced this pattern, all on a `agent-expertise-api#188` implementation arc:

| Phase | Composition | Open decisions | Consensus outcome | Notes |
|---|---|---|---|---|
| Planning | 3× `dotnet-expert`, identical brief | 10 | 6 unanimous, 2 split 2:1, 1 split 1:1:1, 1 deferred | Splits landed exactly on consumer-policy axes (RequireKey default, store lifetime, body cap) — the points that *should* escalate to a human |
| Spike validation | 3× `dotnet-expert`, identical brief | 4 architectural unknowns | 4 unanimous → PATTERN_VALIDATED | Independently confirmed the placeholder-then-update pattern, byte-equal replay, OnCompleted persistence, dedicated NpgsqlDataSource |
| Review-fix validation | 3× `dotnet-expert`, identical brief | 6 reviewer concerns | 5 unanimous fixes, 1 already-correct (false alarm in review) | Replication caught a reviewer false positive that a single agent would have acted on |

The pattern's measurable properties from those runs:

- **Independent reasoning chains over the same prompt produce different artifacts.** Three contributions appeared in exactly one of the three planning instances (`FOR UPDATE` waiter strategy, principal-sub in hash inputs, architecture test for filter attachment) and would have been lost in a single-agent run.
- **Splits surface escalation points the orchestrator could not otherwise detect.** The decisions that fragmented under replication were precisely the ones requiring product judgement (operator-facing policy, blast-radius trade-offs).
- **Cost scales linearly with N.** Three runs of an identical brief cost ~3× the tokens. The benefit is variance-on-recommendations and dissent surfacing — not coverage breadth.
- **The aggregation rule is not the same as for divergent fan-outs.** `structured-review-format.md` defines most-severe-wins for *verdicts*; that semantics does not transfer to *design recommendations* (a 2:1 split on "default true vs default false" cannot be resolved by severity).

These properties make consensus-by-replication structurally distinct from role divergence, not a special case of it. The playbook currently has no language for choosing between them, no aggregation rule for design-recommendation splits, and no guidance on composing the two shapes in one fan-out call.

## Considered Options

- **Option A** — **Codify as a new behavioral rule (`rules/consensus-by-replication.md`) and a companion ADR**, integrated into the existing `research-parallelism.md` minimum-fan-out mandate via cross-reference. Update the AGENTS.md Behavioral rules table.
- **Option B** — **Extend `research-parallelism.md` in place** with a "fan-out composition" section, no separate file. Lower file count; loses the affordance that the rule synopses in AGENTS.md surface as discrete entries.
- **Option C** — **ADR only, no rule file.** Document the pattern as a design decision; leave operational guidance to orchestrator judgement. Loses the always-in-context synopsis path that makes other rules reliably consulted.
- **Option D** — **Defer.** Continue using the pattern informally; revisit when a fourth distinct instance emerges. Risks the orchestrator drifting back to single-shot for design work because the technique has no documented home.

## Decision Outcome

Chosen option: **A — new rule file + companion ADR**.

The pattern is now backed by a 3-for-3 efficacy record across distinct phases of a single implementation arc (planning, spike validation, review-fix validation). Each instance produced behaviour the playbook treats as desirable (dissent surfaced, design choices independently corroborated, false-positive reviews caught), and each is replicable without per-task customisation — there is a real, teachable technique here that warrants codification.

A separate rule file is preferred over an in-place edit of `research-parallelism.md` because the AGENTS.md Behavioral rules table renders one row per rule. A discrete row for consensus-by-replication makes the technique discoverable at orchestration time; folded into the parallelism rule it would be a paragraph the model scrolls past. The two rules cross-reference each other: `research-parallelism.md` continues to set the ≥3 minimum (replication satisfies that minimum the same way divergence does); `consensus-by-replication.md` adds the choose-between-shapes and aggregate-design-splits guidance.

The rule names a single rationalisation pattern explicitly as forbidden: **"the same subagent invoked twice with different prompts"** does NOT count as replication (it produces non-comparable artifacts) and continues to not count toward the parallelism minimum, per the existing language in `research-parallelism.md` § What Counts Toward the Minimum.

Composition is allowed: a fan-out can mix replication and divergence in one `subagent.tasks: [...]` call (e.g. 2× `dotnet-expert` + 1× `security-review-expert` for a security-sensitive .NET design). The aggregation rule for the divergent slot is unchanged (most-severe-wins for verdicts); the aggregation rule for the replicated slots follows the new rule (consensus / 2:1 / 1:1:1 ladder).

### Aggregation ladder for replicated outputs

- **Unanimous (N:0).** Adopt without modification.
- **Majority split (e.g. 2:1, 3:1).** Orchestrator chooses, documents the dissent verbatim in the Agent Efficacy Report. Default to majority unless the minority position cites first-party evidence the majority missed.
- **Even split (1:1:1, 2:2).** Escalate to the user. The pattern's value here is exactly to surface "this is not a technical decision."
- **Singleton novel contribution** — a high-value point made by exactly one instance and not refuted by the others. Adopt and credit. The planning instance examples (`FOR UPDATE` waiter strategy, principal-sub in hash inputs) are canonical.

### Choosing replication vs divergence

| Use replication when | Use divergence when |
|---|---|
| Implementation planning with ≥3 open design decisions | Review of a finished artifact (the lenses ARE different) |
| Spec-interpretation tasks (independent reasoning over the same source) | Cross-domain concerns (e.g. .NET + security + style — three different specialists) |
| Validating a single reviewer's findings against false-positive risk | Coverage breadth is the value |
| Ambiguity-rich research where independent reasoning chains beat lens diversity | The catalog has three specialists each contributing distinct lenses |

Both shapes satisfy `research-parallelism.md`'s ≥3 minimum.

### Tradeoffs

- Good: Names a technique the orchestrator is already using and turns it from latent-pattern into discoverable-protocol
- Good: Provides a deterministic aggregation rule for design-recommendation splits that the most-severe-wins rule does not cover
- Good: Surfaces escalation points (even splits) to the user automatically — the orchestrator does not have to detect them ad-hoc
- Good: Composable with divergence in a single fan-out call
- Bad: Linear cost scaling — 3× replication is 3× tokens. The cost/benefit case is strongest for high-stakes decisions (architectural planning, security-sensitive design) and weak for low-stakes lookups
- Bad: Adds a second fan-out shape to the orchestrator's choice tree — a new failure mode is "chose divergence when replication would have surfaced the right dissent"; the new rule's choose-between table is the primary mitigation
- Bad: Adds ~1 KB to the always-in-context AGENTS.md surface (one synopsis row + one file referenced)

## More Information

### Empirical basis

Full transcripts are retained in the parent pi session for `agent-expertise-api#188`. The summary table above is the evidence base; the issue body (#76) records the planning-phase outcome in more detail.

Three independent runs of the pattern, each producing behaviour the playbook treats as desirable, were the threshold for codification. A single instance is anecdote; two could be coincidence; three across distinct phases of a real implementation arc is a pattern.

### Files added or changed by the implementing PR

- `adrs/0004-consensus-by-replication.md` — this ADR.
- `agent/rules/consensus-by-replication.md` — full rule text with synopses, examples, aggregation ladder.
- `agent/rules/research-parallelism.md` — cross-reference to the new rule in the "What Counts Toward the Minimum" section; no semantic change to the existing parallelism mandate.
- `agent/AGENTS.md` — new row in the Behavioral rules table; cross-reference from the agent catalog explanatory paragraph if useful.
- `README.md` — Architecture Decisions list entry for ADR-0003 (doc-sync pair per `rules/adr-required.md`).

### Future revisitation triggers

- A fourth instance demonstrating a meaningfully different aggregation outcome (e.g. a 1:1:1 split that the user resolved against the orchestrator's recommended escalation path).
- Evidence the technique under-performs vs divergence on a class of tasks the choose-between table currently routes to replication.
- A pi platform change that enables true cross-subprocess result aggregation (would change the cost model and could enable larger N).
