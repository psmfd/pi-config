---
status: Accepted
date: 2026-07-21
---

# ADR-0118: subagent spawn-depth guard (default max depth 1)

**Status:** Accepted
**Date:** 2026-07-21
**Related:** pi_config #841 (this hardening), [ADR-0091](0091-report-only-guard-profile.md) (the `PI_GUARD_PROFILE` set-or-delete env-signal pattern this guard mirrors), [ADR-0093](0093-guard-profile-shadowing-gate.md) (fail-closed spawn-side gates precedent), #606 / epic #595 (`buildChildEnv` — the child-env seam the depth stamp rides on), `agent/rules/orchestrator-protocol.md` § Sub-Agent Obligations (the behavioral rule this backs mechanically).

## Context and Problem Statement

The subagent extension spawns children as full `pi` processes that load the entire extension set — including the `subagent` extension itself — constrained only by the wrapper's `tools:` frontmatter. A wrapper that grants (or defaults to) the `subagent` tool therefore lets children fan out grandchildren invisibly: unbounded depth, no orchestrator visibility, multiplying token spend. The orchestrator-protocol rule prohibits exactly this ("do not spawn additional agents on your own initiative"), but nothing enforced it mechanically — the gap was verified by code read during the #839 cloud-summarizer spike (no depth counter, no nesting marker, no `--no-extensions`/`--no-tools` on the spawn argv anywhere in `subagent/*.ts`).

## Considered Options

1. **Depth-guard env var.** Parent stamps every child with `PI_SUBAGENT_DEPTH` = own depth + 1; the tool refuses to spawn once the process's depth has reached a configured maximum (default 1). Chosen.
2. **Spawn-time flags (`--no-tools`, or a tools list minus `subagent`).** Rejected as the primary mechanism: it only protects wrappers that declare a restricted tool list, must be reasoned about per-wrapper, and silently changes the child's tool surface rather than producing an explicit, teachable refusal. Made unnecessary by option 1, which covers every wrapper uniformly.
3. **Behavioral rule only (status quo).** Rejected — the rule already existed and the gap stood; prompt-level obligations do not bound a mis-instructed or third-party wrapper.

## Decision Outcome

**Option 1.** Two seams, both unit-tested without a spawn harness:

- **`sanitize-env.ts`** exports `SUBAGENT_DEPTH_ENV` (`PI_SUBAGENT_DEPTH`) and `readSpawnDepth()` (non-negative-integer parse; absent/garbage/negative/fractional all read 0). `buildChildEnv` stamps every child with `readSpawnDepth(parent) + 1` — **set-or-increment** semantics, the ADR-0091 philosophy: the child's value is always recomputed from the parsed parent value, never inherited verbatim, so a mangled value resets the chain instead of compounding. The `PI_` prefix already passes strict env mode, so both env modes propagate the stamp.
- **`index.ts`** refuses at the very top of `execute()` — before agent discovery, availability snapshots, or any spawn work — when `readSpawnDepth(process.env) >= maxSpawnDepth`. The refusal text names the depth, the limit, and the protocol rationale (return findings to the parent, which owns delegation), and points at the override.

**Limit and override.** Default `maxSpawnDepth` is **1**: the orchestrator (depth 0) spawns children; children do not spawn grandchildren. Operators override via user-layer `extensionSettings.subagent.maxSpawnDepth`, integers 1–5 only; the project settings layer is deliberately not consulted (same trust boundary as `copilotFallbackModel`, ADR-0073 posture — a hostile repo must not be able to deepen the fan-out tree).

**Threat model honesty.** The guard is defense-in-depth against runaway nested fan-out by instruction-following agents, not a security boundary against a hostile child: a child process runs arbitrary code and could unset the env var before invoking `pi` directly. That vector already exists for every env-carried signal (`PI_GUARD_PROFILE`, ADR-0091) and is accepted on the same grounds — the visible artifact of defeating the guard is itself the audit signal.

## Consequences

- **Positive:** the orchestrator-protocol sub-agent obligation is mechanically enforced for every wrapper, first-party or third-party, regardless of its `tools:` frontmatter; a child's attempted fan-out becomes an explicit refusal the parent sees in the child's output instead of an invisible token-spend tree.
- **Neutral:** legitimately deeper topologies (none exist among first-party wrappers today) need a one-line user-layer setting.
- **Accepted:** a hostile or misbehaving child that shells out to `pi` directly bypasses the guard (above); the refusal consumes one tool-call round-trip in the child before it re-plans.
