---
status: Accepted
date: 2026-08-27
---

# ADR-0150: static byte budgets for selected authored prompt surfaces

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** #1066, #1067, [ADR-0003](0003-expand-disable-model-invocation-to-all-wrapper-paired-skills.md), [ADR-0034](0034-cache-ratio-measurement.md), [ADR-0073](0073-token-meter-extension.md), [ADR-0124](0124-subagent-context-file-suppression.md), [ADR-0125](0125-prefill-meter-extension.md)

## Context and problem statement

Runtime meters report provider-tokenized usage, cache behavior, and cost after a
request. They cannot prevent a pull request from silently expanding recurring
repository-authored context. Existing static checks cover individual fields,
not the main parent-session and child-wrapper surfaces as budgets that ratchet
down after optimization.

A token-denominated CI gate would change meaning when auto-router changes model
or provider. A complete static reconstruction would also be misleading: pi's
base template, tool schemas, dynamic extension content, expertise blocks, and
project context are composed at runtime.

The withdrawn source-branch prototype at `74dce1b` demonstrated byte accounting
but described its scope as every authored prompt surface and gated the wrapper
fleet total as though it were one request. It was reverted by `9488272` and was
never adopted on `dev`. This ADR makes a narrower decision against current
repository behavior.

## Considered options

1. **Provider-tokenizer gate.** Rejected because one tokenizer cannot govern a
   model- and provider-routed system consistently, and live provider calls do
   not belong in repository validation.
2. **Complete static prompt reconstruction.** Rejected because dynamic tools,
   extensions, project context, and the upstream base template make the claim
   brittle. Prefill-meter already observes the composed runtime prompt.
3. **One fleet-wide wrapper ceiling.** Rejected as the primary gate. Each child
   receives one wrapper, so per-wrapper ceilings match the actual composition
   boundary. The fleet total remains informational maintenance data.
4. **Selected UTF-8 byte budgets plus runtime meters.** Chosen. Static CI guards
   stable authored surfaces; runtime meters arbitrate token and cost claims.

## Decision outcome

Adopt `scripts/prompt-budget.sh`, `scripts/test-prompt-budget.sh`, and
`scripts/prompt-budgets.json`.

The required static budgets are:

- total bytes of `agent/AGENTS.md`;
- name plus description bytes for skills visible to model discovery;
- one independent body-byte ceiling for every `agent/agents/*.md` wrapper.

The report also emits:

- AGENTS catalog/table/prose segmentation;
- wrapper-fleet total, explicitly labeled informational;
- the count of TypeScript source sites containing `promptSnippet` or
  `promptGuidelines`, explicitly labeled runtime-metered because values may be
  indirect or dynamically loaded.

Tool schemas, pi's base prompt, dynamic extension payloads, expertise blocks,
and project context remain runtime-only surfaces. Prefill-meter, token-meter,
and cache-meter remain authoritative for provider tokens, prefix reuse, and
cost.

UTF-8 bytes are the CI unit. Removing bytes is monotonic across tokenizers, but
no fixed byte-to-token conversion is used as a gate.

The checked-in manifest is a ratchet:

- raising a ceiling requires an explicit, justified manifest diff;
- after an intentional reduction, `--write-baseline` records the lower ceiling;
- zero visible-skill bytes remain a zero ceiling, so enabling model discovery is
  an explicit budget decision;
- stale or missing wrapper entries fail closed.

`scripts/validate.sh` runs the red-first regression suite and then the manifest
check. The tests prove aggregate, per-wrapper, and skill-visibility breaches
fail, missing manifest coverage exits as an environment/schema failure, and a
generated baseline passes its own check.

## Consequences

### Positive

- Recurring authored-context growth becomes a reviewable CI signal.
- Reductions persist instead of eroding silently.
- Per-wrapper gates reflect child composition more accurately than a fleet cap.
- The report names unmeasured surfaces rather than creating false precision.

### Negative

- Bytes are only a provider-independent proxy; runtime evidence is still needed
  for token and cost claims.
- Legitimate growth requires a deliberate manifest update.
- The baseline generator adds minimum headroom, so a reduction must be
  re-baselined to become durable.

### Follow-up

Phase 1 under #1068 uses this
ratchet before reducing AGENTS.md. Catalog/wrapper semantic changes remain
blocked by #1062, and rule
synopsis compression remains blocked by the generated-synopsis phase.
