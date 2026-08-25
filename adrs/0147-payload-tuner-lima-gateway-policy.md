---
status: Accepted
date: 2026-08-25
---

# ADR-0147: payload-tuner Lima gateway policy and defensive vetoes

**Status:** Accepted
**Date:** 2026-08-25
**Related:** [ADR-0106](0106-payload-tuner-extension.md), [ADR-0110](0110-payload-tuner-defensive-vetoes.md) (superseded), psmfd/pi-config#2 (Lima endpoint guard), psmfd/pi-config#3 (operator policy), pi_config #1052 (gpt-oss `reasoning_effort`)

## Context and Problem Statement

ADR-0110 permits `chatTemplateKwargs` only for `openai-completions` models
whose base URL host is loopback or an RFC 1918 address. That structural gate
protects cloud endpoints from unsupported wire fields, but it suppresses the
local oMLX service when pi runs inside a Lima guest: Lima exposes the host at
the well-known DNS name `host.lima.internal`, not at a guest-loopback or RFC
1918 literal.

Broadly accepting DNS names, `*.internal`, or a user-supplied hostname list
would weaken the cloud guard. Keeping the old rule makes the repository's
actual Lima-hosted gpt-oss workhorse untunable. The production policy also
needs to replace the obsolete GLM-specific `enable_thinking` example with the
gpt-oss/oMLX-supported `chat_template_kwargs.reasoning_effort` channel.

## Considered Options

1. **Keep the loopback/RFC 1918-only gate.** Rejected because it suppresses
   kwargs for the supported Lima topology.
2. **Accept every `.internal` hostname or resolve DNS dynamically.** Rejected:
   suffix trust admits attacker-controlled lookalikes, while runtime DNS
   resolution adds network-dependent and rebinding-prone policy behavior.
3. **Add a configurable hostname allowlist.** Rejected for now: it expands the
   settings and trust contract merely to support one standardized gateway.
4. **Accept only Lima's exact well-known gateway name while retaining all
   ADR-0110 gates and vetoes.** Chosen as the narrowest useful exception.

## Decision Outcome

ADR-0110 is superseded. Its defensive model remains in force with one explicit
addition:

- `chatTemplateKwargs` applies only when `model.api === "openai-completions"`
  and the parsed base URL host is loopback, RFC 1918, or exactly
  `host.lima.internal`.
- Host matching is exact. `host.lima.internal.example.com`, subdomains such as
  `evilhost.lima.internal`, and arbitrary `*.internal` names remain rejected.
- Unknown API families, missing/unparseable URLs, public endpoints, and cloud
  endpoints continue to fail toward suppression. Suppression counters and
  fail-open request handling are unchanged.
- The active-thinking veto remains unchanged: `temperature`, `topP`, and
  `maxTokensCap` are suppressed when the payload carries an active
  Anthropic-shaped thinking block.
- Clamp behavior remains unchanged: it only lowers emitted `max_tokens`,
  `max_completion_tokens`, or `max_output_tokens`; it never adds or raises a
  field, and the Responses field retains its floor of 16.

The tracked operator template contains an exact Lima/oMLX/gpt-oss rule but
keeps `payloadTuner.enabled: false`. Operators opt in only in USER-layer
`~/.pi/agent/settings.json`. The initial production tweak is limited to
`chatTemplateKwargs: { "reasoning_effort": "medium" }`: `medium` is the
quality default established by #1052, while `low` requires separate evaluation.
No sampling or token-cap override is adopted without current model-specific
evidence.

This exact-name exception is intentionally not a general hostname-allowlist
precedent. Supporting another guest runtime or remote serving topology requires
its own security review and decision record.

## Consequences

- Lima guests can tune the host oMLX workhorse without weakening API-family
  gating or admitting hostname suffix lookalikes.
- Fresh installs see a realistic but inert policy example; no operator is opted
  in by the tracked template.
- Existing loopback/RFC 1918 positives, Copilot/public negatives, thinking
  vetoes, observability, and fail-open behavior remain regression-tested.
- The extension README and root ADR index are updated in lockstep.
