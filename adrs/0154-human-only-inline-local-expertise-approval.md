---
status: Superseded
date: 2026-09-01
---

# ADR-0154: require human-only inline approval for pending local expertise

- **Status:** Superseded by [ADR-0155](0155-tui-only-local-expertise-approval.md) on 2026-09-01, the same day it was accepted.
- **Date:** 2026-09-01
- **Amends:** [ADR-0153](0153-explicit-remote-expertise-bootstrap.md)
- **Related:** [#4](https://github.com/psmfd/pi-config/issues/4), [ADR-0095](0095-deterministic-expertise-fanout-gate.md), [ADR-0152](0152-local-sqlite-expertise-provider.md), [`notes/local-expertise-provider-plan.md`](../notes/local-expertise-provider-plan.md)

Superseded by ADR-0155: this ADR treated `ctx.hasUI` as human presence and
overstated what SQLite audit state proves against same-user tampering. The
historical body below is preserved unchanged.

## Context and problem statement

ADR-0153 keeps expertise imported from the remote approval queue inactive until
a separate local approval transition. It does not define how that transition is
authorized.

The local provider may offer an inline review experience, consistent with
ADR-0095's direct `ctx.ui.confirm` pattern. The convenience of approving while
reviewing must not let a model, imported review state, bootstrap confirmation,
file mutation, or headless process manufacture approval. A pending record can
contain untrusted content, and the record reviewed by the human can change
before the database transaction commits.

## Decision outcome

A pending local expertise record may transition to `Approved` through an inline
interactive review flow. Every such transition requires a fresh direct human
confirmation for that exact record. Human presence is mandatory; inline refers
to where the dialog appears, not to automatic or model-mediated approval.

### Dedicated review surface

Pending records remain excluded from ordinary keyword, vector, hybrid,
near-duplicate, `expertise_search`, and fanout retrieval. A deliberately scoped
interactive review surface may enumerate or select them for inspection. Merely
surfacing a record does not approve it.

Before confirmation, the surface displays the complete canonical content and
the provenance, origin, visibility, lifecycle, and review metadata relevant to
the decision. Approval may not hide a suffix behind truncation. If the full
record cannot fit safely in one dialog, the flow must provide complete paged or
separate inspection and bind the final confirmation to the full-record digest;
otherwise it refuses inline approval.

### Human authority

The only approval authority is a positive result from `ctx.ui.confirm`, or an
equivalent direct-TUI primitive with the same human-presence and non-model-callable
properties, while `ctx.hasUI` is true. The dialog names the transition and binds
the human's decision to a canonical full-field hash of the exact record shown.

None of the following is approval:

- model output, a tool call, prompt text, or retrieved expertise content;
- the remote record's presence in an approval queue;
- the bootstrap preview or bootstrap confirmation;
- a file, database flag, imported approval token, environment variable, or
  project setting;
- timeout, default selection, prior approval, batch default, or replay; or
- headless, print/JSON, RPC, hook, or unattended execution.

A human may approve records sequentially inline, but each record requires its
own exact confirmation. There is no approve-all default.

### Display-to-commit binding

The flow computes the canonical full-field hash for display. After positive
human confirmation and under the write transaction/lock, it re-reads the record,
revalidates that it is still pending, and recomputes the same hash. A mismatch,
missing record, state change, validation failure, or lock error refuses the
transition and requires a fresh review. The confirmation is single-use and
cannot authorize a second record or a later retry.

A successful transaction persists `Approved` plus local reviewer identity,
review time, the approved record hash, and bounded audit metadata identifying
the inline-human mechanism. The audit record is evidence of the completed state
transition, not a reusable authorization capability.

Decline, cancel, UI absence, timeout, error, or interrupted commit leaves the
record pending. No automatic retry, rephrasing, or model action may convert that
outcome into approval.

### Local and remote state remain separate

Inline local approval activates only the local record. It does not approve or
update the corresponding remote Draft/pending record. Remote review and future
state reconciliation remain under the explicit synchronization work in #5.

## Considered options

### Keep pending records permanently unapprovable locally

Rejected. It preserves safety but strands imported review work and prevents the
local store from becoming independently useful.

### Permit inline human approval with exact binding

Chosen. It provides a low-friction local review path while retaining the
human-only, full-field, fail-closed posture already used by ADR-0095.

### Treat remote queue membership or bootstrap confirmation as approval

Rejected. Queue membership means the record has not been approved, and bootstrap
confirmation authorizes a copy operation rather than the content's use as
expertise.

### Allow model, file, headless, or batch approval

Rejected. These paths are spoofable, replayable, unattended, or unable to prove
that a human reviewed the exact committed content.

## Consequences

### Positive

- Pending imported expertise can be reviewed and activated without leaving the
  interactive workflow.
- Every local approval has direct human presence, exact-content binding, and
  durable review attribution.
- TOCTOU, replay, model-spoofing, and headless approval paths fail closed.

### Negative

- Each record needs a separate human action.
- Large records need a complete inspection flow rather than a truncated confirm
  dialog.
- Local and remote review states may diverge until future explicit
  synchronization reconciles them.
