---
status: Accepted
date: 2026-06-22
---

# ADR-0045: automate the psmfd/pi mirror sync runbook with overlay tooling

**Status:** Accepted
**Date:** 2026-06-22
**Related:** [ADR-0039](0039-mirror-sync-cadence-and-provenance.md) (the sync cadence/procedure this tooling automates), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) (build-and-attest trust boundary the sync feeds), [ADR-0041](0041-conditional-security-patch-divergence.md) (manifest-tracked security-patch divergence, retired on sync), [ADR-0043](0043-upstream-reporting-gate.md) (upstream reporting gate), [`docs/psmfd-pi-mirror-sync.md`](../docs/psmfd-pi-mirror-sync.md) (the runbook the script implements)

## Context and Problem Statement

ADR-0039 fixed the `psmfd/pi` mirror sync procedure — namespace-isolated
`refs/upstream/tags/*` fetch, `--no-ff` merge of an upstream release tag,
deterministic conflict resolution (`--ours` for overlay-allowlist paths,
`--theirs` otherwise), upstream-workflow quarantine, and a seven-part per-sync
evidence block — but nothing executed it. Every sync through `v0.79.5-psmfd.N`
was run by hand. The sync is the mirror's single largest inbound trust surface:
the zero-divergence guard intentionally skips overlay-path enforcement for
trusted `sync/upstream-*` PRs, so a manual slip there is high-consequence.

Several runbook steps are mechanical yet error-prone when done by hand:

- The fetch must NOT use `--tags` (it pollutes `refs/tags/*` with upstream tags,
  defeating the namespace isolation); the correct invocation is easy to miss.
- Conflict resolution must mirror the guard's `allowed()` predicate exactly —
  the EXACT overlay names, the four path regexes, and the live security-patch
  exemption lines — or a divergence rides in under `--ours`.
- Security-patch retirement (ADR-0041) requires a lockstep edit across three
  surfaces (manifest, `overlay-allowlist.txt`, the guard's `SECURITY_PATCH_PATHS`)
  and a per-patch judgement about whether upstream now ships the fix.
- The evidence block has seven required items that are tedious to assemble.

A reusable helper would make the mechanical parts deterministic and repeatable
and shrink the security-fast-path SLA — but it must not automate the judgement
that the trusted-sync bypass exists to keep human-gated.

## Considered Options

1. **Stay fully manual.** Rejected: a privileged, infrequent, multi-step
   operation run from memory is exactly where a high-consequence mistake (wrong
   ref, missed quarantine, mismatched matcher) occurs.
2. **Full automation, including patch-retirement edits and PR auto-merge.**
   Rejected: it removes the human gate on the mirror's largest trust surface,
   contradicting ADR-0039's deliberately human-led execution model and ADR-0041's
   maintainer-gated retirement. A script deciding to drop a security patch — or
   resolving a conflict against the matcher — is precisely the failure this
   bypass's review requirement guards against.
3. **Automate the mechanical and validation phases; gate every
   divergence-sensitive judgement.** Chosen. A `.psmfd/sync-upstream.sh` overlay
   script runs preflight, fetch, `--no-ff` merge, mechanical conflict resolution
   (reading the live allowlist so retirement flips a path to `--theirs`),
   workflow quarantine, the validation gate, and evidence generation. It only
   *reports* a patch-reconciliation signal; the maintainer decides retirement,
   edits the three lockstep surfaces, and merges the PR.

## Decision Outcome

Adopt option 3. Add `.psmfd/sync-upstream.sh` to the `psmfd/pi` mirror as overlay
tooling (`.psmfd/**`, already an allowed overlay path) that automates the
ADR-0039 runbook's mechanical and validation steps and emits the evidence block,
while keeping patch retirement, allowlist edits, conflict-resolution overrides,
the gitleaks gate, and PR review human-gated. The script's `is_overlay_path()`
predicate is a deliberate mirror of the guard's `allowed()`; the two must be
kept in lockstep — this adds the script as a third surface to the existing
matcher-parity discipline. The script is subcommand-structured (`preflight`,
`fetch`, `merge`, `resolve`, `reconcile`, `validate`, `evidence`,
`prune-pollution`) so the human decision point lands between `merge` and
`resolve`, where retirement edits to the allowlist take effect.

### Consequences

- Good: the mechanical sync is deterministic and repeatable; the easy-to-miss
  `--no-tags` fetch and the matcher are encoded once; the security-fast-path SLA
  shrinks. The `reconcile` command narrows where to look for retirement by
  diffing each patch's `upstream_base..<target>` (both upstream refs), never the
  patched working tree.
- Good: no new trust is granted — the script changes nothing about the bypass,
  maintainer review, or the gitleaks gate; it is run locally by the same
  accountable identity that reviews the import.
- Bad: the script is overlay tooling and must never be committed onto a
  `sync/upstream-*` branch (those carry upstream history, mechanical resolutions,
  and manifest-tracked retirements only). It ships via an ordinary overlay PR.
- Bad: `is_overlay_path()` becomes a third surface that must track the guard;
  a drift between them is a latent divergence risk. Mitigation: both derive from
  the same documented allowlist, and the matcher is small and unit-checkable.
- Bad: `reconcile` is a heuristic (did upstream touch the patched paths?), not
  proof of coverage. It flags candidates; per-patch security verification before
  retirement remains mandatory.

## More Information

The script implements [`docs/psmfd-pi-mirror-sync.md`](../docs/psmfd-pi-mirror-sync.md);
that runbook's new "Tooling" subsection points back here. Patch-retirement
mechanics and the reporting gate are unchanged and remain governed by ADR-0041
and ADR-0043.
