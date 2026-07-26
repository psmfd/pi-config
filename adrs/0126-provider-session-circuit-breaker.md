---
status: Accepted
date: 2026-07-26
---

# ADR-0126: provider-scope session circuit breaker for runtime provider failures

**Status:** Accepted
**Date:** 2026-07-26
**Related:** [ADR-0035](0035-copilot-live-model-discovery.md), [ADR-0080](0080-copilot-fallback-rung.md), [ADR-0083](0083-orchestrator-subagent-model-policy-split.md), [ADR-0104](0104-deterministic-model-availability-snapshots.md), [ADR-0122](0122-subagent-runtime-provider-failover.md), #902, #903, #904.

## Context and Problem Statement

ADR-0122 gave auto-router and subagent policy one shared, process-local set of
session-unavailable models. Its granularity is a single exact `provider/id`,
which is the wrong unit when a provider's *account quota* — not one model row —
is exhausted.

The observed failure (#902): `code-review-expert` was policy-selected onto a
`github-copilot` row and returned HTTP 429 quota-exceeded. The ADR-0122 bounded
retry marked only that exact row unavailable, reselected against the same
matrix, and picked a *sibling* `github-copilot` row, which failed the same way.
Every later child in the session repeated the same discovery from scratch,
burning a spawn each time. Three properties made the state unrecoverable within
the session:

1. Subagent model selection happens at spawn, before task delivery, so a
   follow-up prompt asking for a different provider cannot influence it.
2. `/auto primary providers set …` is parent-only by deliberate design
   (ADR-0083) and never reaches child policy.
3. No operator control existed to take a provider out of service for a session
   short of editing credentials or pinning every wrapper.

The unit of failure evidence and the unit of exclusion were mismatched. Nothing
in the system could express "this provider is out for the session."

## Considered Options

1. **Keep model-only denial and widen the ADR-0122 retry budget.** Rejected:
   more retries against a dead provider is more quota burn and more latency for
   the same terminal outcome; the budget is not the problem, the granularity is.
2. **Extend the ADR-0083 parent provider allowlist to children.** Rejected: it
   inverts a deliberate split. That allowlist is persisted *capability policy*
   for the orchestrator; a quota outage is transient *runtime evidence* with a
   different lifetime, different provenance, and a different blast radius.
3. **Refresh provider discovery / rebuild the availability snapshot on
   failure.** Rejected for the same reason ADR-0122 rejected it: runtime deny
   evidence must not mutate ADR-0104's immutable generation or hash.
4. **Text-mine provider error bodies for account-wide quota phrasing.**
   Rejected as the primary mechanism: the phrasing is a per-provider, unversioned
   string contract, and a false positive removes an entire provider. It also
   conflicts with ADR-0122's rule that raw provider text stays out of telemetry.
5. **Add a provider scope to the shared deny state, with operator controls and
   count-based auto-escalation.** Chosen.

## Decision Outcome

`shared/session-unavailable.ts` becomes a two-scope deny state
(`createSessionDeny()` for isolated instances; `sessionDeny` as the canonical
process-local one). Both scopes answer a single question for the ranking layer —
`has("provider/id")` — so `resolveCapabilityPick`, `resolveTierPick`, and
`buildRoutingPrompt` consume one view and cannot drift:

* **`model` scope** — one exact `provider/id` (the ADR-0122 behavior, unchanged).
* **`provider` scope** — every model from a provider, including rows never
  probed. This is the circuit breaker.

Every entry is a `DenyRecord {key, scope, source, reason, at}`. `source` is one
of `operator`, `runtime-failover`, `classifier-probe`, `auto-escalation`.
`reason` is bounded text, never a raw provider error body. Records are
**first-writer-wins**: re-marking preserves the original source and timestamp,
so concurrent children observing one outage cannot rewrite provenance.

### Auto-escalation

The breaker trips automatically when **two distinct models of one provider**
have been denied with conclusive rate-limit evidence in the session. Two is the
floor: one model 429ing is routine, a second means the quota rather than the row
is exhausted. The threshold is configurable via user-layer
`extensionSettings.autoRouter.providerBreakerThreshold`, and the state itself
refuses any value below two — a threshold of one would make every model-scope
429 provider-wide and erase the distinction this ADR exists to draw.

Only rate-limit-shaped evidence counts. A generic classifier probe failure
(`detail: "error"`) still denies the exact model but contributes nothing toward
escalation, because it says nothing about the account's quota.

### Operator controls

```text
/auto providers status [--json]
/auto providers disable <provider>
/auto providers enable <provider>
/auto providers enable --all
```

`disable` is `source: "operator"`. A provider absent from the registry is
warned about and still applied — a silent no-op on a typo is the worse failure,
and disabling a provider with no credentialed candidates is harmless. A
`provider/id` argument is refused outright so a model key can never be mistaken
for a provider-wide directive. The command is deliberately independent of
`/auto on|off`: the deny state governs unpinned subagent policy too, so it must
be operable with parent routing switched off.

`/auto providers status` prints the ADR-0083 `primary providers` allowlist
alongside the breaker, and `/auto primary providers` points back at it. The two
surfaces are one word apart and answer different questions — persisted
parent-only policy versus transient session evidence affecting parent *and*
child selection — so each names the other rather than relying on the operator to
remember the distinction.

### Lifecycle

| Event | Model denies | Auto-escalated breakers | Operator disables |
| --- | --- | --- | --- |
| `session_start` | cleared | cleared | cleared |
| `/auto matrix refresh --retry-unavailable` | cleared | cleared | **preserved** |
| `/auto providers enable <p>` | that provider's cleared | cleared | cleared |
| `/auto providers enable --all` | cleared | cleared | cleared |

A freshness command must not silently undo a deliberate operator directive, so
`--retry-unavailable` preserves `operator` records; `enable` is the way out.
Re-enabling also drops the provider's accumulated escalation evidence, so a
recovered provider starts clean instead of re-tripping on one further failure.
Nothing is persisted to disk (#904 tracks opt-in cross-session persistence for
operator disables only).

### Scope boundaries

* ADR-0104's immutable snapshot generation and hash are untouched — the breaker
  is a filter applied after the snapshot, exactly as ADR-0122's model set was.
* ADR-0083's parent-only `orchestratorAllowedProviders` is unchanged in scope
  and semantics.
* Explicit wrapper `model:` pins failing closed on a provider-scope deny, and
  the ADR-0080 Copilot fallback rung respecting the breaker, are deferred to
  #903 so this change stays reviewable. Until #903 lands, a pin to a broken
  provider behaves exactly as it does today: authoritative, and returning its
  own failure. ADR-0122's rule that explicit pins remain authoritative continues
  to hold for **model-scope** denies permanently — only provider scope will fail
  closed.

### Determinism under parallel fan-out

The breaker cannot prevent the *first* concurrent burst: in parallel mode every
child selects its model before any sibling's 429 returns, so N children can
still pick the same provider. The guaranteed contract is narrower and stated
here so it is not over-read:

1. Trips are idempotent and first-writer-wins.
2. Each child evaluates deny state at its own selection instant; children
   already in flight complete their independently bounded first attempt
   (identical to ADR-0122's wording).
3. No spawn initiated after a trip — including every ADR-0122 retry — probes the
   denied provider.

Point 3 is the fix for #902: in the observed incident, the *retry* burned the
second Copilot model.

## Consequences

* A quota-exhausted provider is excluded once, for the session, instead of being
  rediscovered by every child.
* Operators can take a provider out of service for a session without touching
  credentials, wrappers, or pins.
* Model-specific failures stay model-specific; the escalation rule is the only
  path from one scope to the other, and it needs corroborating evidence.
* `/auto matrix status` and `/auto matrix review` gain additive
  `deniedProviders` / `sessionDeniedProviders` fields; the existing
  `unavailable` list keeps its model-only meaning, so existing consumers are
  unaffected. The review evidence hash covers provider denies.
* A provider whose quota recovers mid-session stays excluded until
  `--retry-unavailable`, `/auto providers enable`, or the next session — the
  same availability-for-predictability trade ADR-0122 accepted.
* `buildRoutingPrompt` no longer short-circuits on an empty deny state: `size`
  now counts records rather than denied models, and a breaker excludes
  candidates it never enumerates.
* The deny state is instantiable, so tests no longer mutate process-global state
  to exercise routing.

## Verification

* Shared tests cover scope precedence, escalation at and above threshold,
  rate-limited-only counting, re-mark idempotence, first-writer-wins provenance,
  the threshold floor, all three clear modes, and singleton isolation.
* Auto-router tests cover the full command grammar (disable/enable/enable
  --all/status/`--json`/refused arguments/unknown provider), operator survival
  across `--retry-unavailable`, provider-scope filtering in `buildRoutingPrompt`
  and `resolveByTaskType`, and the additive status/review payload fields.
* Subagent tests prove an unpinned child pool excludes a broken provider's
  never-probed sibling rows, that tiered picks obey it, and that a
  local-forbidden wrapper is blocked rather than defaulted.
* Required gates: shared, auto-router, and subagent suites; extension type-check
  and lint; subagent drift validation; full repository validation.
