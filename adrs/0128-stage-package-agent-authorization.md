---
status: Accepted
date: 2026-07-28
---

# ADR-0128: stage package-agent authorization into inert review drafts and active grants

**Status:** Accepted
**Date:** 2026-07-28
**Supersedes (in part):** [ADR-0127](0127-package-agent-consent-and-work-item-credential-boundary.md) — only where it assigns grant creation to the approval broker (#916). The work-item credential boundary, package layout, content-bound grant digest contents, collision/isolation/dispatch revalidation model, and the credentialless companion-agent flow all carry forward unchanged; the grant-creation responsibility moves to #917
**Related:** #913 (parent), #916 (review broker — restaged by this decision), #917 (active grants, provenance, dispatch — restaged by this decision), [ADR-0121](0121-mounted-oidc-token-consumption.md) (bounded file-consumption controls the broker's discovery reads follow)

## Context and Problem Statement

ADR-0127 assigned #916 the creation of digest-bound durable grants: the
approval broker would review a package-agent proposal in the TUI and persist a
grant that issue #917's dispatch machinery later revalidates and consumes.
Replicated security review of the #916 implementation plan returned
`NEEDS_CHANGES` on two blockers that are structural, not incidental:

1. **Same-user state forgery and rollback.** Pi extensions execute with the
   operator's full OS permissions, and the model can invoke file and shell
   tools in the same security context. Any grant file #916 writes can be
   forged, replayed, or rolled back by a same-user write. ADR-0127's own trust
   boundary concedes there is no OS-level isolation; a #916 "grant" would
   therefore claim authority its storage cannot protect.
2. **Incomplete provenance at approval time.** ADR-0127's grant digest must
   cover the effective tool implementations, runner identity and content,
   argv policy, and the ordered extension/module closure — but resolving those
   is #917's enforcement work. A #916 approval would bind a digest over
   material it never verified, making the grant either unverifiable or
   misleading.

Additional replicated findings — untrusted command provenance through
`registerCommand`, display-to-commit TOCTOU, package-discovery execution risk,
underspecified canonical encoding and state transactions, unsafe terminal
rendering, and audit leakage — are implementation-level and addressable, but
the two blockers above cannot be fixed while #916 both reviews proposals and
mints authority.

## Considered Options

1. **Keep ADR-0127's staging and harden #916's grant store.** Rejected. No
   same-user file store can make grants forgery- or rollback-resistant against
   model-callable file and shell operations; hardening produces a stronger
   claim, not a stronger boundary.
2. **Defer all of #916 until #917's enforcement exists, then land both at
   once.** Rejected. It couples the review UX to the hardest enforcement
   design, maximizes the unreviewable change surface, and still leaves the
   grant-authenticity problem unsolved — merely relocated.
3. **Claim OS isolation (separate process/identity, authenticated IPC) to
   protect #916's grants.** Rejected. Out of scope for #913 per ADR-0127's
   non-goals, and it would contradict pi's documented same-user extension
   execution model.
4. **Stage authorization: #916 persists only inert, non-authorizing review
   drafts; #917 creates active grants under a distinct schema after complete
   provenance reconstruction and a fresh direct-TUI approval.** Chosen — see
   below.

## Decision Outcome

Adopt option 4. Authorization is staged into two records with disjoint
capabilities and digest domains.

### Review drafts (#916)

The #916 broker discovers installed pinned-Git package agent descriptors as
inert proposals and persists at most an **inert review draft**:

```json
{
  "kind": "package-agent-review-draft",
  "activatable": false,
  "requiresFreshApproval": true,
  "authorizationDigest": null
}
```

A review draft:

- cannot register or activate an agent;
- cannot be consumed, promoted, migrated, or upgraded by #917;
- explicitly enumerates its unresolved provenance fields (effective tool
  implementations, runner identity and content, argv policy, event-handler
  set, extension and transitive module closure) — their presence is what keeps
  the record non-authorizing;
- is harmless if forged, replayed, expired, or rolled back, because it carries
  no authority; and
- uses a schema and domain-separated digest distinct from any active grant.

This dissolves the two blockers rather than defending against them: a record
with no authority needs no forgery resistance, and a record that names its
unresolved provenance makes no claim over unverified material.

The broker takes operator input only through direct interactive TUI ingress
(exact raw-input interception; no model-callable tool, no `registerCommand`
handler), performs data-only descriptor reads (no imports, execution, network,
or registration), renders an immutable canonical snapshot with hostile-content
encoding, and commits through a compare-and-swap transaction that revalidates
every displayed byte. State lives in an operator-owned, fail-closed store with
allowlist-only audit. These controls make the *review evidence* trustworthy as
evidence; they are not claimed to make it authorization.

### Active grants (#917)

Issue #917 owns every authorizing artifact. It must:

- reject every `package-agent-review-draft` unconditionally as authorization
  evidence;
- create active grants only under its own distinct schema and digest domain;
- independently reconstruct the complete provenance ADR-0127 §5 enumerates,
  trusting nothing from a draft;
- require a fresh direct-TUI approval over the complete effective definition;
- solve active-state authenticity and rollback resistance against same-user
  file and shell operations as an explicit design problem; and
- pass its own security review of that design before any activation
  capability ships.

ADR-0127's content-bound digest contents, catalog-epoch/grant-revision model,
collision and isolation rules, and dispatch-time revalidation transaction all
remain the specification #917 implements — this decision changes *which issue
creates the grant*, not what a grant must contain or how dispatch verifies it.

### What ADR-0127 retains

Package-execution trust remains separate from agent consent (installing a
package is never approval of its agent). The work-item credential boundary,
typed extension, package layout, mirror distribution, and credentialless
companion-agent flow are untouched by this decision.

## Consequences

- #916 becomes independently shippable and independently reviewable: every one
  of its states, including a fully forged one, authorizes nothing. Its
  security review (3/3 replicated `PASS`, no findings, on the staged design)
  is scoped to that non-authorizing property — any change letting a draft
  authorize, activate, migrate, promote, or reduce #917's approval evidence
  invalidates the verdict and requires re-review.
- #917 inherits the hard problem explicitly: active-grant authenticity against
  same-user mutation has no approved design yet and must clear its own
  security review before implementation.
- Operators review proposals once for evidence (#916) and approve once for
  authority (#917). The duplicate confirmation is deliberate: the first
  confirms what was reviewed; the second creates authority over completely
  reconstructed provenance.
- Issues #916 and #917 acceptance criteria are rewritten to match this staging
  (done alongside this ADR); #918/#919 are unaffected.
