---
status: Accepted
date: 2026-09-01
---

# ADR-0153: seed local expertise through an explicit remote bootstrap

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amends:** [ADR-0152](0152-local-sqlite-expertise-provider.md)
- **Related:** [#4](https://github.com/psmfd/pi-config/issues/4), [#5](https://github.com/psmfd/pi-config/issues/5), [ADR-0095](0095-deterministic-expertise-fanout-gate.md), [ADR-0103](0103-upstream-expertise-static-oidc-consumption.md), [`notes/local-expertise-provider-plan.md`](../notes/local-expertise-provider-plan.md)

> **Amended by [ADR-0155](0155-tui-only-local-expertise-approval.md)** (2026-09-01):
> pending records imported by this bootstrap can be approved only through the
> TUI-only human approval ADR-0155 defines. ADR-0154's earlier amendment of this
> ADR is superseded by ADR-0155.

## Context and problem statement

ADR-0152 defines versioned import/export but does not require initial population
from `agent-expertise-api`. A new local database should be able to start with the
existing corpus rather than waiting for expertise to be recreated locally. The
required corpus includes both entries already approved by the remote service and
entries waiting in its approval queue.

This creates a narrow exception to ADR-0152's ordinary local-mode network
boundary. It must not turn initialization into implicit fallback or ongoing
synchronization. It also must not turn a queued remote entry into active local
expertise merely because it was copied.

The current pi client exposes semantic search and create, not a proven
full-corpus administrative export. The implementation therefore cannot assume
that search results enumerate every approved record or that the current bearer
can read the pending queue. Completeness, pagination, review-state access, and
snapshot behavior are feasibility gates.

## Decision outcome

Add an explicit, operator-invoked, one-way bootstrap from the configured
`agent-expertise-api` provider into the user-level SQLite store.

The bootstrap imports:

- every remote entry in `Approved` review state; and
- every remote entry currently waiting for review, preserving its exact
  non-approved review state.

It is an initialization/import operation, not combined search, bidirectional
synchronization, dual write, or an ordinary local-provider code path. Database
open, `expertise_search`, `expertise_create`, and research fanout remain
network-free in local mode. The bootstrap is the only A1-A8 runtime operation
permitted to contact the expertise API while the local provider is selected,
and it runs only after a direct operator action that names the remote source.

### Source contract gate

Before implementation, the real API and authentication profiles must prove a
bounded contract that can:

1. enumerate the complete Approved corpus;
2. enumerate the complete pending approval queue;
3. page both sets without omission or unbounded responses;
4. preserve stable entry identity and review metadata; and
5. provide snapshot, cursor, high-water-mark, or equivalent reconciliation
   semantics sufficient to detect records changing during bootstrap.

Semantic search is not an enumeration mechanism. The implementation may not
scrape or copy the server database. If the current API lacks a required read or
export capability, #4 records the gap and separate upstream work is filed before
bootstrap implementation continues. No pi-side workaround may claim a complete
seed without that contract.

### State and provenance fidelity

For every imported record, preserve remote instance and entry identity,
canonical/integrity hash, content, provenance, timestamps, lifecycle state,
visibility, review state, reviewer metadata, and rejection metadata where the
source contract supplies it. Store the remote identity in the reserved mapping
fields rather than replacing it with a local-only identity.

Remote Approved entries remain Approved locally. Pending entries remain
pending and are excluded from normal local search, semantic retrieval, fanout,
and other active-expertise paths until a separate local approval transition is
completed. Bootstrap never interprets inclusion in the remote queue as approval
and never creates an approval-ledger capability.

Remote vectors are optional, untrusted derived data. The local provider
recomputes vectors with its pinned local embedding pipeline and records that
pipeline's identity.

### Transaction and retry behavior

The operation is previewable before mutation and reports bounded counts by
review state, source instance, conflicts, and rejects without displaying entry
content, credentials, tokens, or private filesystem paths. Mutation requires an
explicit operator confirmation over that preview.

Import is transactional and idempotent by remote-instance identity, remote
entry identity, and canonical content hash. A safe implementation may stage
bounded pages and atomically activate the completed validated seed. An
interruption cannot expose a partially active corpus. Rerunning after failure
must resume or restart safely without duplicates, state promotion, or loss of a
previously valid local record.

A changed remote record is not resolved with unconditional last-write-wins.
Conflicting content, provenance, visibility, review state, approval metadata,
or deletion state is reported and quarantined or refused according to a fixed
policy. The bootstrap does not delete local-only entries.

### Relationship to future synchronization

A completed bootstrap may record source identity and a completion checkpoint for
audit and retry. That checkpoint does not authorize later polling or incremental
pulls. Repeated refresh, combined result merging, remote pushes, tombstone
propagation, and bidirectional conflict resolution remain deferred to #5.

## Considered options

### Start with an empty local database

Rejected as the only path. It strands the existing approved corpus and approval
queue in the remote provider and delays local usefulness.

### Import only Approved entries

Rejected. It would omit work already captured in the approval queue and make the
local store an incomplete handoff. Pending entries can be preserved safely as
inactive records.

### Import Approved and pending entries as active expertise

Rejected. Copying a record is not an approval decision. Activating queued
content would bypass both the remote review state and the local approval
boundary.

### Copy the remote service database directly

Rejected. It couples the local format to server internals, bypasses API
authorization and compatibility contracts, and is unsafe across server schema,
WAL, and deployment boundaries.

### Use only manual NDJSON export/import

Retained as a portability and recovery path but rejected as the sole bootstrap.
The configured API should support an explicit operator workflow once a complete
bounded export contract is proven.

### Continuously mirror the remote provider

Rejected for this increment. It would be synchronization, introduce background
network behavior and authority conflicts, and collapse ADR-0152's explicit
provider boundary. That design remains in #5.

## Consequences

### Positive

- A new local store can begin with the complete useful remote corpus and pending
  review work.
- Review state and provenance survive migration without promoting unapproved
  content.
- Stable remote mappings prepare records for future explicit synchronization.
- The ordinary local provider remains deterministic and network-free.

### Negative

- Full bootstrap depends on an API/export and authorization contract that the
  current pi client has not yet proven.
- Snapshot-safe pagination, staging, resumability, and conflict reporting add
  implementation and test scope.
- Pending records occupy local storage while remaining intentionally invisible
  to normal retrieval.

### Deferred

- periodic or incremental refresh;
- bidirectional synchronization and remote push;
- combined local/remote search and deduplication; and
- automatic conflict or tombstone resolution.
