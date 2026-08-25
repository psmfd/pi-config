---
description: Prefer custom subagents over inline handling and serialize every multi-agent invocation
---

# Agent-First Selection

Custom subagents encode curated expertise and run in isolated subprocesses with restricted tools. Skipping a matching custom subagent discards both knowledge and blast-radius isolation.

## Selection Protocol

1. Check every catalog entry in `agent/AGENTS.md`; do not stop at the first plausible match.
2. Invoke a matching specialist with single mode when only one is needed.
3. When multiple specialists are relevant, invoke all of them in one ordered `sequence: [...]` call. They run one at a time with independent prompts.
4. Preserve specialist count and coverage; serialization is not permission to drop slower or redundant-looking lenses.
5. Prefer pre-composed `/review`, `/security-review`, and `/full-review` workflows.
6. Handle a domain inline only when no cataloged agent covers it. The orchestrator still owns cross-domain synthesis after the complete sequence.

## Skills Are Not Agents

Skills are knowledge files, not invocable wrappers. Only names in the generated agent catalog are valid `agent:` values. Never infer an agent name from a skill directory.

## Serial Independence

A `sequence` is for independent work. Every brief is self-contained and later agents receive no earlier output. Use `chain` only when a later dependent step intentionally consumes `{previous}`; chain remains fail-fast and does not satisfy independent consensus replication.

## Narrow Exemptions

- No matching catalog agent exists.
- The current process is itself a subagent and must return cross-domain concerns to its parent.
- The user requested a literal single tool invocation.
- The orchestrator is directly executing an already-approved implementation plan.

Cross-domain synthesis is not an inline exemption: invoke the relevant agents serially first, then synthesize.

## Non-Exempt Rationalizations

Invocation overhead, confidence in the answer, or already-loaded skill text do not justify skipping a matching subagent.
