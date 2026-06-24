---
status: Accepted
date: 2026-06-12
---

# ADR-0039: psmfd/pi mirror sync cadence and provenance model

**Status:** Accepted
**Date:** 2026-06-12
**Tracking issue:** [#360](https://github.com/psmfd/pi_config/issues/360)
**Related:** [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) (build-and-attest trust boundary), [#361](https://github.com/psmfd/pi_config/issues/361) (pipeline design), [`docs/psmfd-pi-mirror-sync.md`](../docs/psmfd-pi-mirror-sync.md) (operational policy this ADR governs)

## Context and Problem Statement

`psmfd/pi` is a public detached zero-divergence mirror of upstream
`earendil-works/pi`. Its zero-divergence guard intentionally skips overlay-path
enforcement for same-repo PRs from `sync/upstream-*` branches by the trusted
sync actor, making the sync flow the mirror's largest inbound trust surface.
ADR-0038 names upstream source compromise as a residual risk "governed by
mirror sync, provenance, and review policy" — but no such policy existed. The
mirror needs a decided cadence model (when to sync), an execution model (who
runs it, with what credentials), a ref-import policy, and an evidence model
(what each sync records), all sized for a solo maintainer facing an upstream
that releases 2–5 times per week.

## Considered Options

### Cadence

1. **Scheduled syncs** (e.g. weekly). Rejected: produces noise PRs that train
   the maintainer to rubber-stamp a privileged operation; the mirror only
   needs new history when a release wants it.
2. **Purely on-demand.** Rejected as incomplete: planned upgrades are covered,
   but a CVE could sit unaddressed with no planned release imminent.
3. **Upstream-release-driven with a security fast path.** Chosen. Syncs occur
   only for a planned base upgrade or an advisory affecting the mirrored
   range (SLA: 72 h critical / 7 d high). Awareness is decoupled and may be
   scheduled (daily notify workflow opening a tracking issue).

### Execution

1. **In-repo Actions automation.** Rejected: `GITHUB_TOKEN` pushes are
   attributed to `github-actions[bot]` and fail the guard's trusted-actor
   check; a stored PAT is the long-lived repo secret the security baseline
   prohibits.
2. **Local maintainer-run sync under the maintainer's own `gh` identity.**
   Chosen. Natively satisfies all three bypass conditions and keeps reviewer
   and importer the same accountable identity.

### Ref import

1. **All upstream branches and tags.** Rejected: tracking noise, wider
   divergence surface, no provenance value.
2. **Upstream `main` + release tags only, namespace-isolated.** Chosen.
   Fetch-only `upstream` remote maps tags to `refs/upstream/tags/*`, never
   `refs/tags/*`, so unsigned upstream tags can never be confused with PSMFD
   release tags (`vX.Y.Z-psmfd.N`).

### Integration mechanics

1. **Rebase overlay commits onto upstream.** Rejected: rewrites PSMFD SHAs,
   breaking the verifiable chain from the seed and any existing references.
2. **`--no-ff` merge of the upstream tag into `main`, merge-commit PR.**
   Chosen. Preserves both histories; the merge commit is the audit record.
   Conflict resolution is mechanical: overlay-allowlist paths take `--ours`,
   everything else takes `--theirs`; new upstream workflow files are
   quarantined to `.github/workflows-upstream-reference/` in the same sync.

## Decision Outcome

Adopt the upstream-release-driven cadence with security fast path, local
maintainer-run execution, main+tags namespace-isolated ref import, and
`--no-ff` merge mechanics, together with the per-sync evidence block (import
range, tag inventory, surface summary with workflow/build/lockfile callouts,
overlay conflict log, divergence proof, gitleaks result, upstream-signature
observations recorded as observed-not-verified) and the targeted pre-merge
review checklist defined in [`docs/psmfd-pi-mirror-sync.md`](../docs/psmfd-pi-mirror-sync.md).
The bypass authorizes importing upstream history and nothing else; maintainer
review, the gitleaks gate, and all other CI remain mandatory on sync PRs.

### Consequences

- Good: every sync is deliberate, self-documenting, and auditable; the
  trusted-actor bypass stays narrow; no long-lived repo secrets exist.
- Good: sync and release are decoupled — history can land without a release
  decision.
- Bad: the mirror is deliberately stale between releases; a notify workflow
  (follow-up overlay PR in `psmfd/pi`) is needed so staleness is visible.
- Bad: targeted review accepts documented residual gaps (no full semantic
  review of imported ranges) — the ADR-0038 build boundary limits, not
  removes, upstream-compromise blast radius.
- Follow-up: a `psmfd/pi` repository ruleset restricting `sync/upstream-*`
  branch creation to the trusted actor and blocking force pushes is required
  before any collaborator is added.
