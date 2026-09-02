---
description: Govern selected authored prompt surfaces with static byte ratchets while runtime meters retain authority over tokens, caching, and cost
---

# Prompt Budget

Repository-authored default context is a recurring cost. Govern stable authored
surfaces in UTF-8 bytes before merge, and use runtime meters for claims about
provider tokens, cache behavior, or price. Decision record:
[ADR-0150](../../adrs/0150-static-authored-prompt-budget.md).

## Placement ladder

Use the first location that serves the need:

1. An on-demand rule, skill, prompt, or reference body for procedures, examples,
   knowledge, and edge cases.
2. One concise AGENTS synopsis or routing-discriminative catalog row when the
   parent must know that content exists.
3. Always-in-context AGENTS prose only for behavior needed throughout every
   parent session.

Wrapper bodies carry role, tool, trust, and escalation boundaries. Domain
knowledge belongs in the paired skill loaded by the child.

## Gated surfaces

`scripts/prompt-budget.sh --check` enforces the checked-in
`scripts/prompt-budgets.json` ceilings for:

- total `agent/AGENTS.md` bytes;
- name plus description bytes for skills visible to model discovery;
- each wrapper body under `agent/agents/*.md` independently.

The wrapper-fleet total is informational. A child receives one wrapper, so a
fleet sum is not one request's cost.

The report counts extension `promptSnippet` and `promptGuidelines` source sites
but does not assign payload bytes where values are indirect or dynamic. Tool
schemas, pi's base prompt, dynamic extension content, expertise blocks, and
project context remain runtime-measured by prefill-meter, token-meter, and
cache-meter.

Do not describe this gate as complete prompt accounting.

## Budget workflow

- Run `scripts/prompt-budget.sh` while planning to inspect current sizes.
- Run `scripts/prompt-budget.sh --check` before review.
- Prefer shrinking a surface when it breaches.
- If growth is necessary, update the manifest in the same pull request and
  justify the increase in the PR Risk section.
- After a reduction lands, run `scripts/prompt-budget.sh --write-baseline` and
  commit the lower ceilings.
- A hidden-to-visible skill change is an explicit budget decision. The current
  zero visible-skill baseline intentionally fails such a change.

A missing or stale wrapper budget fails closed. Do not remove a manifest entry
merely to make validation pass.

## Boundaries

Static byte savings never justify per-turn prompt mutation. Prefix stability is
a separate invariant governed by ADR-0034. Runtime token or cost regressions
also override a favorable static-byte result.

Never remove an obligation, exception, claim strength, trust boundary, routing
discriminator, path, or stable identifier only to meet a byte target. Raise the
budget rather than weaken behavior.

## Validation

`scripts/validate.sh` runs `scripts/test-prompt-budget.sh` and then
`scripts/prompt-budget.sh --check`. Red-first fixtures prove that aggregate,
per-wrapper, and skill-visibility breaches fail and that missing wrapper
coverage fails closed.
