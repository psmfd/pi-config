---
status: Accepted
date: 2026-08-13
---

# ADR-0135: core-tool override policy — first precedent via hashline-edit

**Status:** Accepted — approved with the #976 implementation plan on 2026-08-13.

Companion: [ADR-0134](0134-hashline-edit-vendored-source.md) (the vendoring this design consumes). Tracking issue: #976.

## Context and Problem Statement

pi's extension loader lets a `registerTool` call reuse a built-in tool's name: the tool registry is built builtins-first, extensions second, so a same-named extension tool structurally replaces the builtin (verified against the pinned runtime's `agent-session.js` `_refreshToolRegistry`). No extension in this repo had ever done this, and no ADR governed it. hashline-edit is the first consumer: it must replace `read` and `edit` (hash tags are minted at read time) rather than add new tool names, so the model keeps a single edit surface — the pattern oh-my-pi itself uses (edit "modes", never model-visible tool choices).

An override raises three questions this ADR answers as policy for all future cases:

1. What must an override preserve for the guard layer?
2. What behavior may an override change relative to the builtin?
3. What are the registration-hygiene requirements?

## Considered Options

- **A. Same-name override with mandatory guard parity and explicit containment** (chosen).
- **B. New tool names** (`hashline_edit`) — avoids replacing builtins but doubles the model-visible surface, requires teaching the model which to use, and silently bypasses every tool-name-matched guard until each is updated.
- **C. `tool_call` input-rewrite layer** — translate new input shapes into builtin shapes pre-execution; least invasive but cannot change result rendering or read-side output, which hashline requires.

## Decision Outcome

**Chosen: Option A**, with these binding requirements for any core-tool override:

1. **Guard parity is part of the same change.** A write-shaped override must be scanned by `secrets-guard` with coverage equivalent to the builtin it replaces. Tool-name matching is not enough — the guard's content extraction is shape-specific, so the override's input schema is integrated into `checkWriteLikeCall` (and its tests) in the same PR. For hashline-edit: `edits[].lines[]` and `newText` are scanned as new content; anchors/`oldText` are not (they mirror on-disk content); the pre-normalization JSON-string `edits` dialect is scanned raw so hook ordering can never open a gap.
2. **Containment is explicit, never assumed.** A custom implementation inherits nothing from core. The override states its own mutation boundary: hashline-edit refuses symlink-resolved targets outside the realpath'd session cwd and any `.git/**` write, each with an enumerated operator override env (`PI_HASHLINE_ALLOW_OUTSIDE_CWD`, `PI_HASHLINE_ALLOW_GIT_WRITES`). This is deliberately stricter than core `edit`; the general `.git/**` posture for all write paths is tracked separately (#977).
3. **An off-switch is mandatory.** Every override ships a session-scoped disable env (`PI_HASHLINE_EDIT=0`) that restores the builtins untouched, so the operator can bisect regressions to the override without uninstalling it.
4. **Fail-closed failure paths.** Overrides keep the upstream hashline discipline: stale/unknown anchors are rejected with structured re-read guidance, never fuzzily relocated; recovery (three-way merge at `fuzzFactor` 0) fails closed on any ambiguity; no-op/duplicate loops escalate to hard errors.
5. **Subagent surface is unchanged by default.** Wrapper `tools:` allowlists are positive lists; none currently grant edit-class tools, so an override becomes reachable only where the builtin already was (the unrestricted orchestrator session) — which is why requirement 1 is non-negotiable.

## Consequences

- **Good** — one model-visible edit surface; guards keep firing on the names they already match; the failure-path contract that produces hashline's real-world benefit (retry-loop elimination) is preserved.
- **Good** — the policy is reusable: the next override (e.g. an ast-grep-backed preview edit) inherits requirements 1–5 instead of re-litigating them.
- **Bad** — same-name override is invisible in a tool listing; the session must rely on the extension's presence/off-switch state to know which implementation is live (`PI_HASHLINE_DEBUG=1` notifies at session start).
- **Bad** — guard shape-coupling now spans two extensions: a schema change in hashline-edit's edit input requires a lockstep change in secrets-guard (recorded in both READMEs; the guard's tests cover the current shape).
- **Neutral** — restricting containment beyond core (requirement 2) trades a capability core `edit` has (arbitrary-path writes) for a smaller blast radius, with explicit operator overrides where the capability is genuinely needed.
