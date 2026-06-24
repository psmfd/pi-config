# ADR-0038: psmfd/pi build-and-attest trust boundary

## Status

Accepted.

## Context

`psmfd/pi` is a public detached mirror of the upstream pi source repository. The
mirror preserves upstream history, quarantines upstream workflows, enforces a
zero-divergence guard for non-sync PRs, and has GitHub CodeQL/default setup
active. Those controls protect the mirrored source and reduce accidental drift.
They do not, by themselves, establish who built a release artifact.

Release artifacts introduce a separate trust boundary. A signature or
attestation is meaningful only for the build process that produced the bytes
being released. If PSMFD downloads upstream release artifacts and re-attests
them, the attestation proves only that PSMFD handled those bytes. It does not
prove that PSMFD controlled the build that produced them.

PSMFD release trust therefore depends on controlling the built artifact, not
merely controlling a later attestation over bytes produced elsewhere.

Tracking issue: [#361](https://github.com/psmfd/pi_config/issues/361).

## Decision drivers

- Provide a clear PSMFD provenance claim for public pi release artifacts.
- Avoid misleading downstream consumers into treating upstream-built bytes as
  PSMFD-built bytes.
- Keep signing key material out of long-lived repository secrets.
- Align future release automation with the public mirror controls already in
  place: workflow quarantine, zero-divergence guard, secret scanning, and
  CodeQL.
- Preserve the existing no-downstream-source-drift posture for the detached
  mirror.

## Considered options

### Option 1: Do not publish PSMFD release artifacts

This avoids artifact trust questions but does not provide a PSMFD-controlled
binary distribution. It is rejected for the intended release path.

### Option 2: Re-attest upstream release artifacts

This would download artifacts built by upstream and attach PSMFD signatures or
attestations to those bytes. It is rejected because it can be mistaken for
PSMFD-controlled build provenance. At most, it proves that PSMFD observed or
republished upstream-built bytes.

### Option 3: Rebuild from source in PSMFD workflows and attest the result

This builds release artifacts from the mirrored `psmfd/pi` source tree inside
PSMFD-controlled GitHub Actions workflows, then attaches checksums and GitHub
artifact attestations to the final artifact bytes. This is chosen.

### Option 4: Carry downstream source changes before building

This would let PSMFD patch source before producing release artifacts. It is
rejected as the default posture because the detached mirror remains
zero-divergence. Any future source divergence would require a separate ADR.

## Decision outcome

Chosen option: **Option 3 — rebuild from source in PSMFD workflows and attest
the PSMFD-built artifacts**.

PSMFD release workflows MUST build pi release artifacts from the source tree
checked out from `psmfd/pi`. They MUST attach checksums and GitHub artifact
attestations to the final newly built release artifacts. PSMFD release
workflows MUST NOT download upstream release artifacts and re-sign or re-attest
them as PSMFD provenance.

The trust boundary is the PSMFD-controlled release workflow plus the source
revision it checks out. Upstream release artifacts may be comparison inputs, but
they are not PSMFD-built outputs and must not be presented as such. If a future
workflow compares PSMFD-built artifacts with upstream artifacts and observes a
material difference, publication must fail closed unless a maintainer explicitly
accepts and documents the difference before release.

## Required release-workflow properties

Future release-workflow implementation must satisfy these requirements:

- Run in the public `psmfd/pi` repository so GitHub artifact attestations are
  naturally verified against `--repo psmfd/pi`.
- Build from a protected source ref, normally a protected release tag.
- Load release workflow code from a protected branch or otherwise protected ref;
  a release tag must not be able to introduce its own unreviewed workflow body.
- Produce final release archives/packages before attestation.
- Generate `SHA256SUMS` or equivalent digest material over the exact bytes that
  will be published.
- Use GitHub artifact attestations with keyless OIDC/Sigstore signing.
- Avoid long-lived signing keys in repository or environment secrets.
- Grant `id-token: write` and `attestations: write` only to jobs that create
  attestations.
- Keep `GITHUB_TOKEN` permissions least-privilege; split build/attest/publish
  jobs when needed to avoid over-broad write permissions.
- Avoid `pull_request_target` and any release path that builds untrusted pull
  request code with privileged tokens or secrets.
- Pin release-critical third-party actions by commit SHA.
- Fail closed if build, checksum generation, attestation, or post-publish
  verification fails.
- Document consumer/operator verification using `gh attestation verify` with
  repository, source ref, and signer workflow constraints.

SBOM attestations are strongly preferred for mature releases, but the exact
SBOM generator, format, and initial-release scope are deferred to the pipeline
implementation issue.

## Consequences

### Positive

- PSMFD release provenance reflects a PSMFD-controlled build from mirrored
  source, not downstream notarization of upstream-built bytes.
- Consumers can distinguish "built by PSMFD from mirrored source" from
  "mirrored from upstream release assets".
- Release verification can bind artifact digest to the PSMFD workflow identity,
  source revision, and release tag.
- The decision aligns release trust with the public mirror's existing controls:
  quarantined workflows, zero-divergence guard, secret scanning, and CodeQL.
- The release process has a clear refusal rule: upstream artifacts may be
  compared against, but not re-attested as PSMFD-built artifacts.

### Negative / costs

- PSMFD must maintain release build workflows instead of delegating artifact
  production to upstream.
- Build reproducibility and platform coverage become PSMFD responsibilities.
- Release failures may occur even when upstream published successfully because
  PSMFD owns its build environment.
- The build still depends on external ecosystem inputs such as GitHub-hosted
  runners and package registries unless later work further pins or vendors
  those inputs.
- Future workflow changes require security review because a compromised release
  workflow can produce valid-looking attestations.

### Residual risks

- Upstream source compromise is not solved by rebuilding. It remains an inbound
  source-trust risk governed by mirror sync, provenance, and review policy.
- GitHub OIDC, GitHub artifact attestations, Sigstore/Fulcio, and Rekor become
  availability and trust dependencies for release provenance.
- Attestations do not prove bit-for-bit reproducibility; they prove who built
  the attested bytes, from what source ref, under which workflow identity.
- Consumers who verify without constraining the signer workflow get a weaker
  guarantee.

## Non-goals

- This ADR does not authorize downstream source divergence from upstream pi.
- This ADR does not implement the release workflow.
- This ADR does not choose final artifact names, platforms, or SBOM format.
- This ADR does not require bit-for-bit equivalence with upstream artifacts.
- This ADR does not declare upstream artifacts universally untrusted; it only
  places them outside the PSMFD-built release-attestation trust boundary.

## More information

- Tracking issue: [psmfd/pi_config#361](https://github.com/psmfd/pi_config/issues/361)
- Public mirror: <https://github.com/psmfd/pi>
- Distribution provenance policy:
  [`docs/distribution-provenance.md`](../docs/distribution-provenance.md)
- Runtime acquisition posture:
  [ADR-0009](0009-pi-runtime-acquisition-strategy.md)
- Toolchain trust posture:
  [ADR-0011](0011-toolchain-install-strategy.md)
- Secret-scanner tooling:
  [ADR-0037](0037-secret-scanner-tooling-strategy.md)
