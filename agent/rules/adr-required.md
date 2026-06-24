---
description: Require an ADR for significant convention or architecture changes
---

# ADR Required for Significant Decisions

When making a change that introduces, modifies, or removes a convention, pattern, or architectural decision:

- **Create an ADR** in `adrs/` following the MADR minimal style used by existing ADRs in that directory (`0001-...`, `0002-...`).
- The ADR must include: context and problem statement, considered options, and decision outcome with justification.
- **Supersession, not editing:** when revising a prior decision, mark the original as superseded and create a new ADR. Do not edit the body of the superseded ADR.
- **Numbering:** sequential, zero-padded four digits matching existing convention (`0001-...`, `0002-...`); never reused.
- **Reference the ADR from `README.md`** in the Architecture Decisions list (doc-sync pair, see `post-implementation-review.md`).

## When this rule applies

- Adding a new development convention or rule
- Changing the architecture, file layout, or extension/skill substrate of the repo
- Adopting or dropping a technology, tool, or format (e.g. picking the subagent substrate, vendoring an upstream extension)
- Any decision where alternatives were seriously considered and the rationale should be preserved for future-us

## When this rule does not apply

- Trivial changes: typo fixes, formatting, single-line config edits
- Implementation details that do not affect conventions or architecture
- Adding a new skill, agent wrapper, or prompt template that follows existing patterns — the patterns are already covered by ADR-0001 and subsequent ADRs
- Documentation-only edits that clarify existing decisions without changing them

## Examples in this repo

- `adrs/0001-subagent-orchestration-substrate.md` — picking the vendored subagent substrate over upstream-vanilla pi extensions
- Future: any decision to add a behavioural rule, change agent-selection routing, or vendor a new upstream extension
