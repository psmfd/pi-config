---
description: Require parallel subagent briefs to use a file-based handoff contract (REPORT_FILE path + summary + verdict) as a fallback for the upstream parallel-output truncation defect
---

# Rule: subagent-parallel-handoff

**Scope:** Every parallel `subagent` invocation (`tasks: [...]` mode) issued by the orchestrator.

**Synopsis:** Briefs sent to parallel subagents must instruct each agent to write its full report to a known temp path and return a path + summary + verdict. The orchestrator then reads the files to obtain full content. This is a fallback safety net for the parallel-output truncation defect (see [Background](#background)).

## Background

Pi's vendored subagent extension (`agent/extensions/subagent/index.ts`) historically returned only a 100-character preview per task to the parent model in parallel mode; the full per-task output was sent to TUI `details` only and was therefore invisible to the orchestrator LLM. This silently degraded every research fan-out mandated by [`research-parallelism.md`](research-parallelism.md).

That defect is fixed in this repo by a downstream patch (see `agent/extensions/subagent/README.md` "Local patches" and pi_config issue #44; upstream report in #46). This rule remains in force as belt-and-suspenders coverage for scenarios where the patch is absent — for example:

- A fresh pi reinstall before `setup.sh` has re-symlinked the patched extension.
- An upstream snapshot bump that overwrites the local override before the patch is re-applied.
- Running this orchestration pattern under a different pi installation that lacks the patch.

## The contract

When the orchestrator fans out via `subagent` `tasks: [...]`, each task brief **must** instruct the subagent to return its report in **one of two forms**. Paraphrasing is fine; the return elements are mandatory.

### Form A — file handoff (default for write-capable agents)

Write the full report to `/tmp/subagent-<your-agent-name>-<unix-timestamp>.md`. The final response to the orchestrator must contain, in order:

1. The absolute path to that file on its own line, prefixed with `REPORT_FILE:` (followed by a single space and the path).
2. A 5-line executive summary.
3. A machine-readable verdict line (`VERDICT: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | INFO`).

### Form B — inline return (read-only agents)

If the subagent's policy or tool surface forbids filesystem writes — e.g. read-only agents per their wrapper `mode:` such as `code-review-expert`, `security-review-expert`, `checkmarx-expert`, `linter`, `docs-expert` — return the full report inline within a sentinel-bracketed block. The final response must contain, in order:

1. The full report between `<!-- BEGIN REPORT -->` and `<!-- END REPORT -->` markers on their own lines.
2. A 5-line executive summary.
3. A machine-readable verdict line (`VERDICT: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | INFO`).

The `REPORT_FILE:` line is omitted in Form B. Orchestrator parsers should match the **first** `<!-- BEGIN REPORT -->` and the **last** `<!-- END REPORT -->` to tolerate nested quotation of prior reports.

### Recommended brief language

Orchestrators may copy-paste the following directive into each parallel task brief:

> Write your full report to `/tmp/subagent-<name>-<unix-timestamp>.md` and return `REPORT_FILE: <absolute path>` if your policy and tools permit filesystem writes; otherwise return the full report inline between `<!-- BEGIN REPORT -->` and `<!-- END REPORT -->` markers. In both cases, follow with a 5-line executive summary and a `VERDICT: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | INFO` line.

### Orchestrator obligations

The orchestrator then:

1. Parses each subagent return for **either** a `REPORT_FILE:` line **or** a `<!-- BEGIN REPORT -->` … `<!-- END REPORT -->` block.
2. For Form A: reads the referenced file to recover the full report. For Form B: extracts the inline block as-is.
3. Synthesizes across the recovered reports.
4. Aggregates verdicts using the most-severe-wins convention from [`structured-review-format.md`](structured-review-format.md).

## When the rule does **not** apply

- **Single mode** (`{ agent, task }`): full output is already returned by the extension. No handoff required.
- **Chain mode** (`{ chain: [...] }`): only the final step's full output is returned, but `{previous}` propagation between steps means each subagent already saw the prior full output. Use file handoff only if the chain ends in a step whose output you need to dissect in detail.
- **Subagents acting as subagents:** subagents are forbidden from invoking other subagents (see [`orchestrator-protocol.md`](orchestrator-protocol.md)), so this rule has no nested case.

## Enforcement

This rule is currently enforced at the orchestrator layer (in this AGENTS.md context). Future automation could add a `subagent` extension hook that injects the contract automatically; until then, treat omission as a protocol violation worth a self-correction note in the Agent Efficacy Report.

## Related

- pi_config issue #44 — local patch fixing the underlying defect
- pi_config issue #45 — this rule
- pi_config issue #46 — upstream report
- [`research-parallelism.md`](research-parallelism.md) — the rule that mandates 3+ parallel subagents for research tasks
- [`orchestrator-protocol.md`](orchestrator-protocol.md) — sub-agent obligations and orchestrator duties
