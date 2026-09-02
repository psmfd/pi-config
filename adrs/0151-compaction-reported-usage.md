---
status: Accepted
date: 2026-09-02
---

# ADR-0151: prefer committed compaction usage over reconstructed cost

- **Status:** Accepted
- **Date:** 2026-09-02
- **Related:** #838, #839, #840, #844, [ADR-0019](0019-compaction-optimizer-extension.md), [ADR-0117](0117-compaction-metrics-ledger.md) (superseded)

## Context and problem statement

ADR-0117 was correct for pinned pi v0.80.10: pi discarded compaction
summarizer usage, so the metrics ledger reconstructed an upper-bound cost from
`tokensBefore`, active-model rates, and the committed summary's estimated size.
It reserved the `reported` basis for a future extension-owned summarizer.

Pinned pi `v0.84.2-psmfd.1` has a different contract. Its built-in summarizer
persists `Usage` on `CompactionResult` and `CompactionEntry`, and
`session_compact` exposes the saved entry as `event.compactionEntry`. The usage
contains provider-reported input, output, cache-read, and cache-write token
counts. Pi computes `usage.cost.total` from those counts and its registered
model rates. Issue #840's requested upstream capability has therefore landed,
but compaction-optimizer still ignores it.

The overdue #844 baseline contained 14 committed compactions. For the five
fall-through rows, the old reconstruction reported $7.963240 while the same
session entries persisted $3.224775 of usage-based cost. The reconstruction
was 2.47 times the usage-based total. This sample had no cache-read or
cache-write tokens; most of the gap came from `tokensBefore` exceeding actual
summarizer input and from estimated summary tokens exceeding reported output.

## Considered options

1. **Keep `derived` as the primary built-in basis.** Rejected because it
   discards better evidence already present on the committed entry and
   materially overstated the observed baseline.
2. **Require reported usage and omit cost when it is unavailable.** Rejected
   because older session entries, stale runtimes, extension-provided
   compactions, or incomplete provider usage can legitimately lack a finite
   total. Removing the existing estimate would reduce compatibility and
   observability.
3. **Prefer reported usage and retain derived reconstruction as fallback.**
   Chosen. It consumes the strongest available evidence without making the
   observational ledger depend on one provider or runtime shape.

## Decision outcome

ADR-0151 supersedes ADR-0117 in full while carrying forward these decisions
unchanged: the extension-owned append-only ledger path, one row per committed
compaction, the single `session_compact` emit site, field vocabulary and policy
tag, `events.enabled`, and the observational invariant that metrics never
influence dispatch or block compaction. It replaces the cost-basis precedence
and the runtime premise used to justify it.

For every committed non-deterministic compaction, compaction-optimizer reads
`event.compactionEntry.usage` at the existing single emit site:

- when every required token and cost component is a finite, non-negative,
  safely serializable number, and `usage.cost.total` remains finite after
  micro-dollar rounding, write `costBasis: "reported"`, copy the token/cache
  components into the ledger, and use pi's usage-based total as `costUSD`;
- when committed usage is absent or malformed, preserve ADR-0117's
  reconstruction as `costBasis: "derived"`;
- for deterministic compactions, always write `costBasis: "zero"`, even if an
  unexpected usage object is present.

`reported` means provider-reported token usage priced by pi's registered model
rates. It does not claim reconciliation against a provider invoice. Existing
historical `derived` rows remain unchanged; reports may contain all three bases
in one append-only ledger.

ADR-0117 remains the preserved historical record. This ADR is the complete
governing decision for the carried-forward ledger plus reported-first cost
accounting. Issue #840 can close after this repository adopts the surfaced
field. Issue #839 remains useful for model routing, privacy, memory pressure,
prompt control, latency, cost, and summary quality, but not for making built-in
usage visible.

## Consequences

### Positive

- Built-in compaction rows use the committed provider usage already available
  in pinned pi.
- Cache token components and actual summarizer input/output replace
  `tokensBefore` and chars-per-token proxies when available.
- The prior estimate remains available for compatible degradation.
- The dispatch and append-failure behavior remain observational and unchanged.

### Negative

- Historical and new rows can use different bases, so analyses must group or
  filter by `costBasis`.
- Dollar totals still depend on pi's model-rate registry rather than billing
  statements.
- The extension now depends on the documented `CompactionEntry.usage` contract,
  which must be rechecked on future pi snapshot updates.
