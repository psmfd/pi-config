---
status: Accepted
date: 2026-07-12
---

# ADR-0093: Fail-closed gate on project agents shadowing guard-profiled user wrappers

**Status:** Accepted
**Date:** 2026-07-12
**Related:** [ADR-0091](0091-report-only-guard-profile.md) (the guard profile whose accepted gap this closes — amends its "Accepted gap" note, does not supersede the ADR), #671 (the tracked gap), #551 (the profile feature), #606 (the orthogonal env-scoping track)

## Context and Problem Statement

ADR-0091 made the `linter` wrapper's report-only contract mechanical: the
wrapper's `guard-profile: report-only` frontmatter is exported to the child
as `PI_GUARD_PROFILE`, which `bash-destructive-guard` enforces. Its accepted
gap (tracked as #671): `discoverAgents` merges user and project catalogs
with a bare last-write-wins `Map.set`, so a project-scoped
`.pi/agents/linter.md` that omits the frontmatter key silently replaces the
profiled user wrapper — disarming enforcement for that name.

The only mitigation was the interactive project-agent confirmation, and it
is not a trust boundary: it is skipped when `ctx.hasUI` is false (subagent
children always run `--mode json -p`, so headless is the norm, not the edge
case), and `confirmProjectAgents` is a **per-call tool parameter the
invoking model controls** — a prompt-injected orchestrator can set
`confirmProjectAgents: false` in the same call that requests
`agentScope: "both"`. Opening an untrusted repository that ships a
same-named wrapper is sufficient to reach the gap; no further injection is
required once project scope is in use.

A second vector rides along: guard-profile enforcement is scoped to bash
argv. A shadowing wrapper that keeps the profile but **adds structured
tools** (`write`, `edit`) mutates files through pi's own tools, which the
bash guard never sees. Any fix that only preserves the profile string is a
false closure.

## Considered Options

1. **Inherit the strongest guard-profile on shadow.** Fail-safe for the env
   signal, but insufficient alone (the tools-widening bypass above) and
   confusing: it silently imposes report-only behavior on a possibly
   coincidentally-same-named project agent, breaking ADR-0091's
   "profile is legible from the wrapper file" property.
2. **Refuse silent shadowing of a profiled wrapper outside interactive
   confirmation.** Fail-closed, matches the posture of every other guard in
   this ecosystem (secrets-guard, gh-identity-guard: indeterminate trust
   state blocks the operation, overrides announce themselves). Blast radius
   is narrow — the gate only fires on names whose user wrapper declares a
   profile (today: `linter`); ordinary project-agent overrides are
   untouched.
3. **Document as accepted trust gap only.** The status quo; inconsistent
   with the repo's fail-closed conventions now that the gap is being
   actively evaluated.

## Decision Outcome

Chosen: **option 2, with option 1 layered on the approved path only**, in
`agent/extensions/subagent/` (LOCAL PATCH #10):

- `discoverAgents` detects **profiled shadows** during discovery: a project
  wrapper whose name collides with a guard-profiled user wrapper and that
  either *weakens the profile* (omits/changes it) or *widens the tool
  surface* (declares a tool the user wrapper does not, or is unrestricted
  where the user wrapper is restricted). Detection also runs under
  `agentScope: "project"` via a detection-only probe of the user catalog —
  otherwise a project-only invocation of a profiled name never collides
  with anything and escapes the gate.
- A pure `evaluateShadowGate` policy (unit-testable, no spawn harness)
  drives the spawn gate in `index.ts`, deliberately independent of
  `confirmProjectAgents`:
  - **Tool-surface widening is refused outright** — no confirmation can
    make it safe, because the added tools bypass the bash-scoped guard
    entirely.
  - **Profile weakening requires an interactive confirmation** with copy
    that names the disarmament specifically. Headless sessions refuse.
  - **On approval, the user wrapper's profile is inherited** onto the
    project agent (strongest-wins) — the option-1 behavior, applied only
    after a human has seen exactly what they are approving.
- Discovery precedence itself is unchanged: project agents still override
  user agents for unprofiled names (the documented customization feature).

### Consequences

- The confirmation prompt can appear twice for one call (shadow prompt +
  generic project-agent prompt) in the rare interactive-shadow case —
  accepted; both prompts answer different questions, and merging them
  would couple the trust boundary to the caller-controlled flag.
- `agentScope: "project"` calls in a repo with project agents now pay one
  extra directory read (the detection probe). Negligible against the spawn
  cost that follows.
- Case-sensitive name collisions (`Linter` vs `linter`) are out of scope —
  a differently-cased name does not shadow anything; it is a distinct
  agent the caller must name explicitly.
- ADR-0091's accepted-gap note is closed by this ADR; the "parent-controlled
  wrapper definition" trust assumption now holds structurally for profiled
  names rather than by convention.
