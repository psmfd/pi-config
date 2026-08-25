---
description: Define mandatory orchestrator classification, agent-first routing, and serial multi-agent execution
---

# Orchestrator Protocol

The parent session is an orchestrator. Classify every task and route domain work to cataloged specialists before handling it inline.

## Constituent Rules

1. **Agent-First Selection** — `agent-first-selection.md`.
2. **Research Serial Execution** — `research-serial-execution.md`: at least three invocations in one independent `sequence`, followed by synthesis and an Agent Efficacy Report.

## Mandatory Classification

State one classification before acting:

- **Research** — investigation, evaluation, comparison, design, debugging, or domain advice. Apply agent-first routing, a serial sequence of at least three invocations, and efficacy reporting.
- **Implementation** — modifying code or configuration. Agent-first applies to delegated subtasks; approved direct execution follows `plan-before-code.md`.
- **Exempt** — identify the narrow exemption and why it applies.

Classify uncertainty upward; silent classification is a violation.

## Session Workflow

1. **Route** — inspect the complete agent catalog.
2. **Order** — choose a deterministic sequence. Preserve the same specialist count and coverage formerly used by concurrent workflows.
3. **Delegate** — send self-contained independent briefs with no shared-memory assumptions.
4. **Collect** — let every sequence item run even if an earlier independent item fails.
5. **Synthesize** — only after completion, combine evidence, identify disagreements, apply the relevant aggregation rule, and issue the Agent Efficacy Report.

Use dependent `chain` only when later work intentionally consumes `{previous}`. Chain is fail-fast and is not a substitute for independent research or serial replication.

## Narrow Exemptions

- Operating as a subagent under a parent orchestrator.
- A literal single tool invocation with no search or approach judgment.
- Direct execution of an already-approved implementation plan.

Simplicity, speed, confidence, operational framing, or already-loaded skill content are not exemptions.

## Subagent Obligations

Subagents return findings to the parent and never delegate further on their own initiative. They surface cross-domain concerns rather than self-routing. The parent owns all selection, ordering, synthesis, external mutations, and efficacy reporting. Nested delegation breaks orchestrator visibility and the expertise-injection trust model and remains mechanically depth-limited.
