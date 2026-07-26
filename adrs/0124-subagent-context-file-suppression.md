---
status: Accepted
date: 2026-07-25
---

# ADR-0124: default-suppress context-file injection in subagent children

**Status:** Accepted
**Date:** 2026-07-25
**Related:** [ADR-0032](0032-context-manager.md), [ADR-0094](0094-local-llm-role-lever.md), [ADR-0106](0106-payload-tuner-extension.md), [ADR-0118](0118-subagent-spawn-depth-guard.md), #889, local-llm ADR-010.

## Context and Problem Statement

Every subagent child is a full `pi` process. pi's `loadProjectContextFiles()`
runs unconditionally unless `--no-context-files` is passed, loading the global
`~/.pi/agent/AGENTS.md` plus every ancestor `AGENTS.md`/`CLAUDE.md` into a
`<project_context>` block of the child's system prompt. Our subagent extension
never passed that flag, so every spawn cold-prefilled ~36.6KB (~9K tokens) of
the repo's orchestration playbook and project instructions — roughly 80% of the
~11K-token cold prefill measured for a typical wrapper.

That content is leaf-irrelevant by design: `AGENTS.md` defines how the
*orchestrator* classifies and routes work, 20 of 21 first-party wrappers never
reference it, and the orchestrator protocol explicitly forbids children from
self-routing. Under local fan-out it is also the dominant driver of the oMLX
Memory Guard collapse local-llm ADR-010 pinned `--max-concurrent-requests 8`
around: N concurrent cold prefills of duplicated dead-weight content push the
memory enforcer into its ceiling-shrink/prefix-cache-eviction spiral.

A secondary hazard: children re-read these files from disk at spawn time, so an
edit landing mid-fan-out makes otherwise-identical children hash to different
prefix-cache blocks.

Issue #889 requires any mitigation to be deterministic in execution — same
inputs, byte-identical prompt out, no model-in-the-loop reduction.

## Considered Options

1. **Do nothing client-side; rely on server-side tuning** (local-llm #28/#45).
   Rejected: server-side work moves the collapse threshold; it does not remove
   ~9K tokens of per-spawn dead weight, and cloud spawns pay for it too.
2. **Trim or tier skill/wrapper content.** Rejected as wrong-target: skill
   bodies never enter the cold prefill (`disable-model-invocation: true`
   already excludes all 21 first-party skills from `<available_skills>`), and
   wrapper bodies are the smallest contributor. Truncation heuristics also risk
   cutting late-positioned safety constraints.
3. **Condition suppression on the resolved model (local-tier only).** Rejected:
   `pin.modelArg` varies with liveness/failover outcomes, so the same wrapper
   would produce different prefills across spawns — worse for debugging and for
   prefix-cache stability, and cloud spawns would keep paying for content they
   equally do not use.
4. **Pass `--no-context-files` on the child argv by default, with per-wrapper
   opt-in via `context-files: inherit` frontmatter.** Chosen.

## Decision Outcome

The subagent extension (vendored, LOCAL PATCH #18) pushes `--no-context-files`
onto every child argv unless the wrapper declares `context-files: inherit`.

- **Frontmatter contract:** `context-files: none | inherit`, parsed
  exact-value-only like `capability-tier` — a typo lands on the suppressed
  default rather than half-arming a larger prefill. Absent ≡ `none`.
- **Default = suppress.** The evidence (20/21 wrappers, no-self-routing rule)
  favors lean-by-default; new and third-party wrappers stay lean without
  per-file annotation. `pi-agent-expert` opts back in — its domain is this
  configuration itself.
- **Per-wrapper-static, not model-conditioned.** A wrapper's argv — and
  therefore its system prompt — is byte-identical across routing and failover
  outcomes, preserving the prefix-cache posture ADR-0032/ADR-0106 established
  (spawn-time-static, never per-turn or content-conditioned).
- **Enforcement:** `validate.sh` rejects unrecognized `context-files` values;
  `test/agents.test.ts` pins the parse contract and
  `test/spawn-integration.test.ts` pins the argv in both directions.

This is the first ADR to claim spawn-time prefill footprint as a concern;
ADR-0106 explicitly left it unowned ("no content optimization of any kind").
This decision does not touch message content at any hook — it changes what the
child process is asked to load, which upstream already supports as a
first-party flag (verified present in the pinned v0.81.1 binary; the flag and
the surrounding prompt-composition code are unchanged through upstream
v0.82.1).

### Consequences

- Every default-path spawn drops ~9K tokens of cold prefill; the mid-fan-out
  live-file-drift hazard disappears for suppressed children.
- A child that genuinely needs project conventions must either declare
  `context-files: inherit` or read the files with its own tools (visible in
  the activity stream, priced on demand).
- Follow-ups tracked separately: tool-schema advertisement audit (#890),
  spawn-time segment measurement (#891), upstream segment-ordering proposal
  (#892).
