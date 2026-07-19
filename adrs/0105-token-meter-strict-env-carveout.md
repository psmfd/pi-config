---
status: Accepted
date: 2026-07-17
---

# ADR-0105: TOKEN_METER_ strict-env carve-out and live footer counter

**Status:** Accepted
**Date:** 2026-07-17
**Related:** [ADR-0073](0073-token-meter-extension.md) (token-meter; decision 4 is the whole-tree-accounting design repaired here), [ADR-0077](0077-routing-policy-tag-and-streaming-usage.md) (`TOKEN_METER_POLICY_TAG` rides the same inheritance channel), pi_config #596/#606 (strict child-env sanitization; retro-ADR tracked as #761), #760 (cache-meter twin defect), #762 (recursion-depth guard surfaced during review).

## Context and Problem Statement

ADR-0073 decision 4 gives token-meter whole-tree accounting: the root session
exports `TOKEN_METER_SESSION`, `TOKEN_METER_ENABLED` (and, per ADR-0077,
`TOKEN_METER_POLICY_TAG`) into `process.env`, and subagent child `pi`
processes inherit them and append usage to the ROOT session's log. The
strict-env work (#606) later changed the subagent extension to spawn children
with `buildChildEnv()` — and every first-party wrapper declares
`env-strict: true`, whose allowlist-only mode passes just `BASE_ALLOWLIST`
plus the `PI_`/`LC_`/`XDG_` prefixes. `TOKEN_METER_*` matched none of these,
so children started with metering disabled and recorded nothing: `/token-meter
status` and the `token_usage` tool silently showed only the orchestrator
model. ADR-0077's own rationale ("rides the exact inheritance channel …
already used") assumed a channel #606 had closed. Nothing tested the
propagation, so the degradation was invisible.

Separately, the footer status was a static `📊 token-meter: on`, telling the
user metering was running but not what it had counted.

## Decisions

1. **Add `TOKEN_METER_` to `BASE_ALLOW_PREFIXES` in
   `subagent/sanitize-env.ts` (Option A).** The three carrier vars are
   non-secret observational values (session id, boolean, short operator
   label), and whole-tree accounting is unconditional cross-cutting
   infrastructure applied identically to every wrapper — the same category as
   the existing `PI_`/proxy carve-outs, not a per-wrapper credential need.
   The base-list comment now names this exception category explicitly.

2. **Reject renaming the vars to `PI_TOKEN_METER_*` (Option B).**
   Structurally attractive — `sanitize-env.ts` ships in the generic
   `pi-config` mirror while token-meter ships standalone
   (`pi-token-meter`), and Option A does bake one extension-specific name
   into the generic artifact. But `TOKEN_METER_POLICY_TAG` is a documented
   operator interface (README, ADR-0077, ADR-0079's A/B methodology) with a
   second independent consumer (`auto-router/recorder.ts` reads the literal
   name), so a rename requires mandatory legacy-name fallback in two places
   plus doc churn, and any missed external script silently breaks A/B
   tagging — the same silent-degradation class this fix closes. The Option A
   coupling is inert for consumers without token-meter: allowing a prefix
   nothing sets passes nothing.

3. **Reject per-wrapper `env-allow-prefix` entries (Option C).** Declaring
   the carve-out in all 21 wrapper files reproduces the forgot-the-carve-out
   failure mode one layer down: a 22nd wrapper omitting it would silently
   regress, and no pin test enforces per-wrapper presence.

4. **Regression-test the channel.** `sanitize-env.test.ts` and
   `strict-env-wiring.test.ts` now assert the three vars survive strict mode
   and that secret-suffixed names inside the namespace (e.g.
   `TOKEN_METER_API_TOKEN`) are still denied — `STRICT_DENY_PATTERNS` runs
   before the allowlist, so the prefix cannot become a smuggling channel.
   `safeSessionKey` continues to basename-sanitize the inherited session id
   before it becomes a path component.

5. **Live footer counter.** When enabled and a UI exists, token-meter renders
   whole-tree totals in the footer status (`📊 412k tok · $1.23 · 2 models`,
   via `formatStatus`) instead of the static "on" text, recomputed from the
   session log on `message_end` (all roles — a toolResult end is when
   freshly-appended subagent usage becomes visible). The recompute — not just
   the display call — is skipped when `ctx.hasUI` is false, so headless
   children never pay the read, and a 2 s throttle bounds the per-event
   re-read (append-only log; aggregate-on-read per ADR-0073 decision 3). The
   `message_end` handler remains observational: it always returns
   `undefined`.

## Consequences

- **Positive:** whole-tree accounting works again under strict-env wrappers;
  `/token-meter status` and `token_usage` show every model the session used;
  the footer shows live totals; the propagation channel finally has
  regression coverage.
- **Neutral:** one extension-specific prefix now lives in the shared
  sanitizer with a justifying comment (inert without token-meter installed).
- **Accepted:** the footer refresh re-reads the session log (throttled) in
  the interactive root only; cache-meter's `CACHE_METER_CONFIG` has the same
  stripping defect and is deliberately not fixed here (#760).
