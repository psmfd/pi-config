---
status: Accepted
date: 2026-09-01
---

# ADR-0155: require TUI-only human approval for pending local expertise

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** [ADR-0154](0154-human-only-inline-local-expertise-approval.md)
- **Amends:** [ADR-0153](0153-explicit-remote-expertise-bootstrap.md)
- **Related:** [#4](https://github.com/psmfd/pi-config/issues/4), [ADR-0095](0095-deterministic-expertise-fanout-gate.md), [ADR-0146](0146-bash-tool-write-confinement.md), [ADR-0152](0152-local-sqlite-expertise-provider.md), [`notes/local-expertise-provider-plan.md`](../notes/local-expertise-provider-plan.md)

> **Amended by [ADR-0157](0157-provenance-checked-final-expertise-mutation-executors.md)**
> (2026-09-01): the model-callable write boundary this ADR requires is realized as
> provenance-checked final `write`/`edit`/`bash` executors with a digest-attested
> installed generation, strict Landlock enforcement, and fresh installed-pi disk
> probes.

## Context and problem statement

ADR-0154 correctly required a fresh inline confirmation for each exact pending
record, but its runtime predicate and tamper claim were too broad.

In pinned pi v0.84.2-psmfd.1, `ctx.hasUI` is `true` in both interactive TUI and
RPC modes. RPC translates `ctx.ui.confirm()` into an
`extension_ui_request`; any RPC client can send an `extension_ui_response` with
`confirmed: true`. Therefore `ctx.hasUI` plus `ctx.ui.confirm()` does not prove
direct terminal human presence. The documented discriminator is
`ctx.mode === "tui"`; RPC reports `"rpc"`, JSON reports `"json"`, and print
reports `"print"`.

ADR-0154 also listed a database flag as non-authoritative without stating the
limit of that claim. SQLite state and audit rows are mutable by another process
running as the same OS user. Under ADR-0152's same-user threat boundary, no
hash stored beside the record can make that state non-forgeable. The design can
require human approval for every supported provider transition and prevent
standard model-callable tools from writing the data root, but it cannot prove
human provenance after arbitrary same-user process or extension compromise.

## Decision outcome

A pending local expertise record may transition to `Approved` through an inline
review flow only when all of these conditions hold:

1. `ctx.mode === "tui"`;
2. `ctx.hasUI === true`;
3. the complete exact record and relevant metadata have been inspected;
4. a fresh `ctx.ui.confirm()` returns `true` without a timeout/default; and
5. a transaction-time re-read and canonical full-field re-hash match what the
   human reviewed.

`ctx.mode === "tui"` is the load-bearing human-presence predicate. RPC remains a
hard refusal even if `ctx.hasUI` is true and the RPC client returns
`confirmed: true`. JSON, print, headless, hooks, and unattended execution also
refuse approval.

### Dedicated review surface

Pending records remain excluded from ordinary keyword, vector, hybrid,
near-duplicate, `expertise_search`, and fanout retrieval. A deliberately scoped
TUI review command or panel may enumerate and inspect them. Surfacing or
selecting a record is not approval.

The review displays complete canonical content plus origin, provenance,
visibility, lifecycle, and review metadata. Approval may not hide a suffix
behind truncation. A record that cannot be displayed completely in one dialog
requires complete paged/separate inspection whose final confirmation is bound to
the full-record digest; otherwise approval refuses.

### Human authority and display-to-commit binding

Each record receives its own fresh, positive, no-timeout TUI confirmation. There
is no approve-all default. The confirmation is bound to a canonical full-field
hash of the exact record displayed.

After confirmation and under the write transaction/lock, the provider re-reads
the record, verifies it is still pending, and recomputes the hash. Mismatch,
missing record, state change, validation failure, lock failure, or interruption
leaves the record pending and requires fresh review. A confirmation is
single-use and cannot authorize another record or a later retry.

A successful transaction persists local reviewer identity, review time, the
approved full-field hash, and bounded audit metadata naming the TUI-human
mechanism. This audit describes the supported transition; it is not a reusable
capability or a cryptographic attestation against same-user tampering.

The following never authorize a supported transition:

- model output, tool calls, prompts, or retrieved expertise;
- remote queue membership or remote review metadata;
- bootstrap preview or confirmation;
- file input, imported tokens, environment variables, or project settings;
- a caller-supplied database flag;
- prior confirmation, replay, batch/default selection, timeout, or retry; and
- RPC UI responses, JSON, print, headless, hooks, or unattended execution.

Decline, cancel, UI loss, mode mismatch, error, or interrupted commit leaves the
record pending. Local approval does not approve the corresponding remote Draft.

### Model-callable write boundary

The supported pi_config configuration must mechanically deny its standard
model-callable `write`, `edit`, and shell paths write access to the expertise
data directory, database, WAL/SHM files, backups, manifests, staging files, and
approval audit state. Path checks resolve symlinks and equivalent indirection.
The local provider's create, import, bootstrap, and approval writes occur only
inside its application-owned implementation.

A2/A6 must identify a mechanically verifiable protection state and a real-entry
canary for the installed runtime. If that protection is unavailable or cannot be
verified, local create/import/bootstrap/approval fails closed; read-only local
search may continue only if opening the store does not mutate it. Regression and
mutation tests must prove the guard actually blocks each standard model-callable
write path.

### Honest same-user limitation

This decision does not claim resistance to arbitrary code already executing as
the operator, including a malicious same-user process, a malicious in-process
extension, debugger access, or direct operator database editing. Such code can
forge SQLite rows and hashes because it shares the provider's OS authority.
Those actions are outside ADR-0152 D8's supported threat boundary and are not
valid approvals, but the local store cannot reliably distinguish them afterward.
A stronger provenance claim would require a separately authorized process,
separate OS identity, or external presence-backed signing authority and a new
ADR.

## Considered options

### Gate on `ctx.hasUI` and `ctx.ui.confirm`

Rejected. RPC has UI dialogs and can synthesize a positive confirmation through
the JSON protocol.

### Gate on `ctx.mode === "tui"` plus exact confirmation

Chosen. It uses pi's documented mode discriminator and preserves inline human
review in the actual terminal UI.

### Authenticate approval using a hash stored in SQLite

Rejected as a same-user security boundary. An attacker that can alter the
record can alter the stored hash and audit row. Hashes remain useful for
transactional display-to-commit binding and diagnostics, not tamper-proof
provenance.

### Claim protection from all same-user processes

Rejected as unimplementable in the current in-process architecture. The claim is
narrowed rather than relying on a forgeable proof.

## Consequences

### Positive

- RPC clients cannot impersonate the human approval dialog.
- Every supported activation has direct TUI presence and exact-record
  display-to-commit binding.
- Standard model-callable mutation paths are denied access to the expertise data
  root and fail closed when that protection cannot be verified.
- The residual same-user limitation is explicit rather than hidden behind a
  forgeable database hash.

### Negative

- IDE or custom RPC clients cannot approve pending expertise, even if a human is
  operating them.
- Each record requires a separate TUI action.
- Local write features now depend on verifiable model-tool path protection.
- Arbitrary same-user code remains capable of undetectable database forgery.
