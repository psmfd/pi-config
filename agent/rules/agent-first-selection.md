---
description: Prefer custom subagents over inline handling for domain-specific tasks
---

# Agent-First Selection

Custom subagents exist because they encode domain expertise, known fragilities, and validated patterns that an inline-reasoning pass lacks. They also run in **isolated subprocesses** with restricted tool sets — handling delegated work inline discards both curated knowledge AND blast-radius isolation. Skipping a custom subagent when one covers the domain is a protocol violation.

## Selection Protocol

Before delegating work, follow this protocol strictly:

1. **Check whether a custom subagent covers the task domain.** Consult the agent catalog in [`AGENTS.md`](../AGENTS.md). Check EVERY agent — do not stop at the first plausible match. Tasks frequently touch multiple domains.
2. **If a custom subagent exists, invoke it** via the `subagent` tool with `agent: "<name>"`.
3. **If multiple custom subagents are relevant, invoke all of them in parallel** via a single `subagent` call with `tasks: [...]`. A task touching GitHub CLI and git workflows requires BOTH `gh-cli-expert` and `gitflow-expert`, not just whichever one you think of first. The subagent tool's parallel mode is capped at 8 tasks / 4 concurrent.
4. **Prefer the slash workflows when they fit** — `/review`, `/security-review`, `/full-review` (and any future `/...` prompts in `agent/prompts/`) are pre-composed routing decisions and reduce both your token cost and the chance of mis-routing.
5. **Handle work inline only when no custom subagent covers the domain** — the task falls outside all cataloged domains, or requires cross-domain synthesis that no single subagent handles. Even then, supplement with custom subagents for any domain-specific subtasks.

## Skills Are Not Agents

The `<available_skills>` block injected at session start lists **skills** (`~/.pi/agent/skills/<name>/SKILL.md`) — domain-knowledge files that the model loads into its own context via `read`. Skills are **not** invocable via the `subagent` tool. The only valid `agent:` values are the entries in the catalog table in [`AGENTS.md`](../AGENTS.md), each backed by a wrapper at `agent/agents/<name>.md`.

A skill named `foo-expert` does **not** imply the existence of a `foo-expert` agent. Many skills exist without a matching wrapper; loading the skill inline is the correct route in that case (per the "no matching subagent" exemption below). Routing to a non-existent agent name causes the child `pi` subprocess to exit non-zero with an "unknown agent" error, which — combined with the parallel-mode aggregation defect tracked in pi_config issue #44 — surfaces to the orchestrator as the ambiguous `(no output)` summary, easily mistaken for a transport or rate-limit failure. **Always cross-reference the AGENTS.md catalog table before constructing a `subagent` invocation; do not infer agent names from the skills list.**

## Narrow Exemptions

- **No matching subagent for the domain** — the task falls outside all cataloged subagent domains. Inline handling is correct. But verify this by scanning the full catalog, not by assuming.
- **Operating as a subagent** — the parent session already selected the appropriate subagent for the task. Per `orchestrator-protocol.md`'s Sub-Agent Obligations, do not chain further delegation.
- **Cross-domain synthesis** — the task requires combining perspectives from multiple domains and no single subagent covers the full scope. Use parallel mode in the `subagent` tool to fan out across the relevant custom subagents.

## What Is NOT an Exemption

- **"Subagent invocation overhead exceeds the benefit"** — this is not your call to make. The overhead of spawning a subagent is a few hundred milliseconds. The cost of skipping domain expertise is wrong answers, missed edge cases, lost isolation, and user trust erosion. Invoke the subagent.
- **"I already know the answer"** — your confidence is not a substitute for domain expertise. The subagent may surface fragilities, caveats, or patterns you are not aware of.
- **"The model already loaded the SKILL.md"** — loading a skill in your context is not equivalent to running its agent in an isolated subprocess with restricted tools. The wrapper exists for a reason.
