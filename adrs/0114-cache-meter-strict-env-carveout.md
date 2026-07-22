---
status: Accepted
date: 2026-07-21
---

# ADR-0114: CACHE_METER_CONFIG strict-env carve-out

**Status:** Accepted
**Date:** 2026-07-21
**Related:** [ADR-0105](0105-token-meter-strict-env-carveout.md) (the token-meter twin this parallels — its Consequences explicitly deferred this fix to #760), [ADR-0034](0034-cache-ratio-measurement.md) (cache-meter; the suite-wide cache-ratio gate whose accounting is repaired here), [ADR-0073](0073-token-meter-extension.md) (whole-tree-accounting precedent), pi_config #760 (this defect), #606 (strict child-env sanitization).

## Context and Problem Statement

cache-meter (ADR-0034) is a read-only `message_end` recorder that appends per-turn token usage to a JSONL file when `CACHE_METER_CONFIG` names a measurement config; it is inert otherwise. The recorder is meant to feed the suite-wide prefix-churn / cache-ratio gate, which is only meaningful across a whole session tree — subagent turns included.

The strict-env work (#606) spawns subagent children with `buildSanitizedEnv()`, and every first-party wrapper declares `env-strict: true`, whose allowlist-only mode passes just `BASE_ALLOWLIST` plus the `PI_`/`LC_`/`XDG_`/`TOKEN_METER_` prefixes. `CACHE_METER_CONFIG` matched none of these, so a strict-mode child started with the recorder disarmed and recorded nothing. This is the exact twin of the token-meter whole-tree-accounting break that ADR-0105 repaired; ADR-0105's Consequences named it ("cache-meter's `CACHE_METER_CONFIG` has the same stripping defect and is deliberately not fixed here (#760)").

It went unobserved because cache-ratio measurement runs are typically standalone operator invocations (`scripts/run-cache-ratio.sh`), not sessions spawned through strict wrappers. Any measurement that *does* involve subagents silently loses child-turn coverage, understating prefix churn.

## Considered Options

1. **Add `CACHE_METER_CONFIG` to `BASE_ALLOWLIST` (exact key).** Symmetric with ADR-0105's `TOKEN_METER_` carve-out.
2. **Document cache-meter as standalone-only.** Add a note that subagent turns are not covered under strict wrappers; change nothing in the sanitizer.
3. **Per-wrapper `env-allow` entries in all 21 wrappers.** Rejected for the same reason ADR-0105 rejected it — a 22nd wrapper omitting the entry silently regresses, with no pin test enforcing presence.

## Decision Outcome

**Option 1.** `CACHE_METER_CONFIG` is added to `BASE_ALLOWLIST` in `subagent/sanitize-env.ts` with a justifying comment, and a regression test in `sanitize-env.test.ts` asserts it survives strict mode.

Justification:

- `CACHE_METER_CONFIG` is a **non-secret, operator-set measurement-config name** (a label/identifier that arms an inert read-only recorder) — the same observational category as the `TOKEN_METER_` carrier vars, not a per-wrapper credential.
- Whole-tree cache-ratio coverage is **unconditional cross-cutting infrastructure** applied identically to every wrapper, the same class as the existing `PI_`/proxy/`TOKEN_METER_` carve-outs — so it belongs on the base list, not on 21 per-wrapper `env-allow` entries a future wrapper would forget (Option 3's failure mode).
- An **exact key** is used rather than a `CACHE_METER_` prefix: cache-meter reads only this one var, and the tightest match keeps the security boundary minimal. If cache-meter grows additional non-secret carriers, widening to a prefix is a future, separately-justified change.
- Option 2 is rejected because the measurement is *designed* to be suite-wide; documenting the gap rather than closing it preserves a silent-undercount defect in the exact tool meant to measure the suite.

The secret-stripping guarantee is unaffected: `STRICT_DENY_PATTERNS` runs before the allowlist, so a hypothetical secret-shaped `CACHE_METER_*` name would still be denied.

## Consequences

- **Positive:** cache-ratio measurement that spans subagents now records child turns; the defect ADR-0105 flagged as #760 is closed; the channel has regression coverage parallel to the token-meter one.
- **Neutral:** one more extension-specific exact key lives in the shared sanitizer with a justifying comment — inert for consumers without cache-meter active (nothing sets `CACHE_METER_CONFIG`, so nothing passes).
- **Accepted:** `sanitize-env.ts` ships in the generic `pi-config` mirror while cache-meter is not standalone-mirrored; the one baked-in name is the accepted coupling ADR-0105 already weighed for its twin.
