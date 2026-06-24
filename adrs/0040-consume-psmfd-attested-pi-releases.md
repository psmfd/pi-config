---
status: Accepted
date: 2026-06-12
---

# ADR-0040: consume PSMFD-attested pi releases as the vendored runtime

**Status:** Accepted
**Date:** 2026-06-12
**Tracking issue:** [#374](https://github.com/psmfd/pi_config/issues/374)
**Related:** [ADR-0009](0009-pi-runtime-acquisition-strategy.md) (pin-and-fetch mechanism — amended, not superseded), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) (build-and-attest boundary), [ADR-0039](0039-mirror-sync-cadence-and-provenance.md) (mirror sync), [`docs/psmfd-pi-release-runbook.md`](../docs/psmfd-pi-release-runbook.md)

## Context and Problem Statement

ADR-0009 pinned the pi runtime to upstream `earendil-works/pi` GitHub release
binaries, sha256-verified against an in-repo `CHECKSUMS` file, and rejected
"build pi binaries ourselves and publish to our own release surface" (its
Option D) as not worth the infrastructure at the time. That infrastructure now
exists: the `psmfd/pi` detached mirror rebuilds pi from mirrored source in a
reviewed, least-privilege workflow and publishes keyless-OIDC-attested
artifacts (`vX.Y.Z-psmfd.N`, first release verified end-to-end). Upstream
binaries carry no attestations at all. Continuing to consume upstream bytes
would mean trusting unattested artifacts while maintaining an attested build
of the same source.

## Considered Options

1. **Stay on upstream release binaries (ADR-0009 unamended).** Rejected:
   unattested bytes; no provenance chain; the digest source is the GitHub API
   rather than an attested artifact.
2. **Switch the pin to PSMFD-attested `psmfd/pi` releases, keeping the
   ADR-0009 pin-and-fetch mechanism.** Chosen.
3. **Switch and remove the upstream path entirely.** Rejected: a PSMFD
   pipeline outage (OIDC/Sigstore dependency, runner failure) would leave no
   acquisition path; upstream pins remain the documented emergency rollback.

## Decision Outcome

**Chosen: option 2.** The pin-and-fetch mechanism of ADR-0009 is unchanged;
the release surface and trust chain are amended:

- `agent/vendor/pi/VERSION` pins a PSMFD tag (`vX.Y.Z-psmfd.N`).
  `fetch_pi_binary()` derives source from the pin form: PSMFD-form pins fetch
  `pi-<triple>-<tag>.tar.gz` from `psmfd/pi`; plain `vX.Y.Z` pins keep the
  upstream URL and bare asset names as the emergency-rollback path.
- The bump procedure's digest source is the release's **attested
  `SHA256SUMS`**: it must pass `gh attestation verify --repo psmfd/pi
  --signer-workflow psmfd/pi/.github/workflows/psmfd-release.yml` before any
  digest is committed, and the fetched archive is attestation-verified again
  after the self-test. Install-time verification remains sha256-only
  (ADR-0009 posture): `gh` is not an install-time dependency, and the
  committed `CHECKSUMS` file — itself derived from an attested artifact —
  is the install-time trust anchor.
- `scripts/validate-pi-vendor.sh` derives the expected six-asset inventory
  from the pin form, so a PSMFD pin with upstream-shaped asset names (or
  vice versa) fails structural validation.

### Consequences

- Good: the runtime consumed by `setup.sh` is now traceable to a
  PSMFD-controlled build of mirrored source (ADR-0038's chain closes
  end-to-end: source review → sync policy → attested build → pinned consume).
- Good: rollback to upstream needs only a VERSION/CHECKSUMS edit.
- Bad: pi runtime bumps now depend on a PSMFD release existing for the
  desired base version — cutting one (per the release runbook) becomes a
  prerequisite of the bump rather than waiting on upstream alone.
- Neutral: Sigstore/OIDC availability affects bump-time verification only,
  never install time.
