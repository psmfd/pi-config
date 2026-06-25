---
status: Accepted
date: 2026-06-25
---

# ADR-0053: pin third-party GitHub Actions to full-length commit SHAs

**Status:** Accepted
**Date:** 2026-06-25
**Related:** [ADR-0052](0052-mirror-code-scanning-followup.md) (the code-scanning posture this hardens; `actions/missing-workflow-permissions` is an adjacent Actions-hardening finding), [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the sync workflow whose `checkout` step is pinned), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) (the supply-chain trust posture this is consistent with)

## Context and Problem Statement

Every workflow `uses:` a third-party action referenced by a **mutable tag**:
`actions/checkout@v4`, in `validate.yml`, `sync-mirrors.yml` (×2), and
`setup-smoke.yml` (×2). A Git tag — including a `vN` major tag — can be moved by
the action's owner (or an attacker who compromises that repo) to point at
different code. The reference is resolved at run time, so a moved `@v4` silently
changes what executes in our CI, including the `sync` job that holds
`MIRROR_SYNC_TOKEN` (content+workflow write to the public mirrors, ADR-0050) and
the `validate`/`setup-smoke` jobs that run on `dev`/`main`. This is the standard
GitHub Actions supply-chain vector (and what OpenSSF Scorecards / CodeQL
`actions/*` queries flag as "unpinned action").

The vendored binaries (pi, nvm, gh, yq, shellcheck, gitleaks, cocoindex) are
already integrity-pinned: each carries a `CHECKSUMS` file `sha256`-verified at
install time, which is content-pinning stronger than a Git ref. The gap is
specifically the GitHub Actions references.

## Considered Options

1. **Keep tag pins (`@v4`).** Rejected: a moved tag is a silent code swap with CI
   write-credentials in scope.
2. **Pin to a minor tag (`@v4.3.1`).** Rejected: still a tag — mutable in
   principle, only narrower. Not an integrity guarantee.
3. **Pin to the full-length commit SHA, with a version comment.** Chosen.
   Immutable; the trailing `# vX.Y.Z` keeps it human-readable and gives Dependabot
   a version to bump against.

## Decision Outcome

**Chosen: option 3.** Every third-party GitHub Action is referenced by its
full-length (40-hex) commit SHA, with a trailing comment naming the version:

```yaml
- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
```

Convention going forward:

- **Third-party actions** (any `uses:` not under this org) MUST be pinned to a
  full-length commit SHA with a `# vX.Y.Z` comment. Short SHAs and tag refs are
  not acceptable.
- **First-party actions** (none today) may use a tag, since we control the source.
- Updating a pinned action means resolving the new release tag to its commit SHA
  (`gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq .object.sha`) and
  updating both the SHA and the comment together.
- This convention covers GitHub Actions refs only. Vendored binaries remain
  content-pinned via their `CHECKSUMS` (the stronger mechanism); `install.sh`
  `REF`/`EXT_REF` are deliberately release-*channel* selectors, not dependency
  pins, and are out of scope.

### Consequences

- Good: a compromised or retagged upstream action cannot alter our CI without a
  visible SHA change in a reviewed PR.
- Good: clears the unpinned-action class of CodeQL/Scorecards findings and is
  consistent with the ADR-0038 rebuild-and-attest supply-chain posture.
- Bad / accepted: updates require resolving a tag to a SHA rather than relying on
  a floating `@v4`. A Dependabot `github-actions` ecosystem entry can automate the
  bump PRs (tracked separately if adopted); the `# vX.Y.Z` comment is what it
  reads.
- Neutral: only `actions/checkout` is in use today; the convention binds any
  action added later.
