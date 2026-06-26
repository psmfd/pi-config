# Cross-substrate distribution-provenance policy

> Operational reference for every sealed-artifact substrate `pi_config` ships. Codifies what each substrate's release pipeline must produce, what recipients verify, and where the trust boundary sits. Decisions backed by [ADR-0013](../adrs/0013-distribution-substrate-strategy.md) and [ADR-0014](../adrs/0014-oci-substrate-amendment-to-0013.md); this doc operationalizes them.

## Scope

This policy applies to every substrate that ships **a sealed artifact** — one a recipient runs without first reading its source. For `psmfd/pi` specifically, [ADR-0038](../adrs/0038-psmfd-pi-build-and-attest-trust-boundary.md) adds the release trust-boundary rule that PSMFD pi artifacts are rebuilt from mirrored source and that upstream-built artifacts are not re-attested as PSMFD provenance.

- **κ** — OCI image on GHCR (`docker run ghcr.io/<owner>/pi_config:vX.Y.Z`)
- **η** — `wsl --import` rootfs tarball
- **β-shaped α release tarballs** — if/when α ships a versioned `.tar.gz` of the template alongside the GitHub-Template instantiation flow

> **Substrate ζ (`.smolmachine` smolvm pack) was rescinded per [ADR-0020](../adrs/0020-rescind-substrate-zeta-smolvm-pack.md).** Historical ζ verification/audit prose has been removed from this doc; the rescission rationale and the post-rescission substrate matrix (α + η + κ) live in ADR-0020.

It does **not** apply to clone-and-build α (recipient clones the repo, runs `setup.sh`, and inspects everything before it executes). For that path, provenance is git history, signed tags (where used), and the author-side trust posture in [ADR-0009](../adrs/0009-pi-runtime-acquisition-strategy.md) / [ADR-0011](../adrs/0011-toolchain-install-strategy.md) / [ADR-0012](../adrs/0012-vendored-pi-default.md).

## Trust boundary

A sealed-artifact substrate is **author-baked code that executes on first launch**. The recipient cannot audit it the way they can audit a clone — they can read `Dockerfile`s and release workflows after the fact, but at run time they are trusting the build pipeline that produced the artifact, not the source they read.

Concretely, for any sealed substrate:

- The **build pipeline** (a GitHub Actions workflow under `.github/workflows/`) is the trust root. Whoever can run that workflow can produce a verifiable artifact.
- The **signing identity** is the workflow's OIDC identity (Fulcio + GitHub-OIDC for cosign-keyless) or the manual signer's key (none used; this project does not adopt long-lived signing keys per the upstream-vendor posture in ADR-0009/0011/0012).
- The **recipient verification step** binds artifact → signing identity → workflow path. It does **not** prove the workflow's source code was good — only that the workflow at this path produced this artifact. Recipients who want to audit further read the workflow source and the `Dockerfile` / build script in this repo.
- **Pinning by digest** (OCI `image@sha256:...`) or by signed checksum (`SHA256SUMS` over the blob) is the only way to get reproducible "I ran exactly this artifact" semantics. Pinning by tag (`:latest`, `:vX.Y.Z`) without digest leaves the artifact mutable on the registry side.

This boundary is the same one Docker, Homebrew bottles, GitHub release tarballs, and Linux distro packages all sit behind. Surfacing it explicitly here so recipients understand what verification does and does not buy them.

## Floor and target by substrate type

Per [ADR-0014](../adrs/0014-oci-substrate-amendment-to-0013.md) § Cross-substrate amendments:

| Substrate type | Floor (every release) | Target (every release where cheap) |
|---|---|---|
| **OCI substrates** (κ) | **cosign-keyless signature on the manifest digest** + multi-arch OCI index | SLSA v1 provenance attestation (`provenance: true` in `docker/build-push-action`) + SBOM (`sbom: true`) |
| **Non-OCI substrates** (η rootfs, ζ pack, β α-tarball) | `SHA256SUMS` file published alongside the artifact in the GitHub release | cosign-keyless signature on the blob (`cosign sign-blob`) + `.cosign.bundle` attached to the release |

The OCI floor is raised relative to non-OCI because cosign-keyless on OCI is a single workflow line (the [`sigstore/cosign-installer`](https://github.com/sigstore/cosign-installer) action + one `cosign sign --yes` call against the digest emitted by `docker/build-push-action`). The non-OCI floor stays at SHA256SUMS because cosign on a blob requires recipients to fetch a separate `.cosign.bundle`, which is heavier UX without commensurate gain at the floor tier.

`SHA256SUMS` is **always** required at minimum, even when cosign-keyless is also published — it's the cheapest verification a recipient can do (`sha256sum -c SHA256SUMS`) and works without installing cosign.

## Recipient verification UX

### κ — OCI image (cosign-keyless)

```bash
# Install cosign once: https://docs.sigstore.dev/cosign/system_config/installation/
cosign verify \
  ghcr.io/<owner>/pi_config:vX.Y.Z \
  --certificate-identity-regexp 'https://github.com/psmfd/pi-config/\.github/workflows/.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# Resolve to the manifest digest and pin (recommended for production / CI):
docker buildx imagetools inspect ghcr.io/<owner>/pi_config:vX.Y.Z --format '{{json .Manifest}}' \
  | jq -r '.digest'
# → sha256:abc123…
docker run --rm ghcr.io/<owner>/pi_config@sha256:abc123…
```

The certificate-identity-regexp pattern `https://github.com/psmfd/pi-config/.github/workflows/.+` binds the signature to **any workflow in this repo**. Tighter forms are available if you want to bind to a specific workflow file (e.g. `.../.github/workflows/oci-publish\.yml@refs/tags/.+`); the loose form is the documented floor.

### η — `wsl --import` rootfs (SHA256SUMS floor; cosign-blob target)

```powershell
# Floor — SHA256SUMS verification (PowerShell on Windows)
Invoke-WebRequest "https://github.com/<owner>/pi_config/releases/download/vX.Y.Z/pi_config-wsl2-rootfs.tar.gz" -OutFile rootfs.tar.gz
Invoke-WebRequest "https://github.com/<owner>/pi_config/releases/download/vX.Y.Z/SHA256SUMS"               -OutFile SHA256SUMS
$expected = (Select-String -Pattern 'rootfs\.tar\.gz$' -Path SHA256SUMS).Line.Split(' ')[0]
$actual   = (Get-FileHash rootfs.tar.gz -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "checksum mismatch" }
```

```bash
# Target — cosign-blob verification (any platform with cosign installed)
cosign verify-blob \
  --bundle pi_config-wsl2-rootfs.tar.gz.cosign.bundle \
  --certificate-identity-regexp 'https://github.com/psmfd/pi-config/\.github/workflows/.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  pi_config-wsl2-rootfs.tar.gz
```

## Content-audit guidance

Verifying a signature proves provenance, not safety. Recipients who want to inspect what an artifact actually contains before running it have substrate-specific tools.

### κ — OCI image

```bash
# Manifest list → per-platform digests
docker buildx imagetools inspect ghcr.io/<owner>/pi_config:vX.Y.Z

# Layer-by-layer file listing (no run; uses image layers only)
docker create --name audit ghcr.io/<owner>/pi_config:vX.Y.Z
docker export audit | tar tv | less
docker rm audit

# SBOM (target-tier artifact, attached as OCI artifact alongside the image)
docker buildx imagetools inspect ghcr.io/<owner>/pi_config:vX.Y.Z --format '{{json .SBOM}}'

# SLSA provenance (target-tier)
docker buildx imagetools inspect ghcr.io/<owner>/pi_config:vX.Y.Z --format '{{json .Provenance}}'
```

### η — rootfs tarball

```bash
# Listing without extraction
tar tzvf pi_config-wsl2-rootfs.tar.gz | less

# Extract to a sandbox dir for inspection (does not import into WSL2)
mkdir audit && tar xzf pi_config-wsl2-rootfs.tar.gz -C audit
ls audit/etc/wsl-distribution.conf audit/etc/wsl.conf
```

## Per-substrate application

Each substrate's release pipeline is responsible for producing the floor (and, where cheap, target) artifacts. The substrate's release workflow lives under `.github/workflows/` and is the trust root described in § Trust boundary above.

| Substrate | Tracking issue | Release workflow (planned) | Floor artifact | Target artifact |
|---|---|---|---|---|
| **κ** | #139 | `.github/workflows/oci-publish.yml` | OCI manifest digest + cosign-keyless signature | + SLSA provenance + SBOM |
| **η** | #130 | `.github/workflows/wsl2-rootfs-publish.yml` | `SHA256SUMS` | + cosign-blob `.cosign.bundle` |
| **β α-tarball** | #129 (if pursued) | (TBD; α primary path is the GitHub Template, not a release tarball) | `SHA256SUMS` | + cosign-blob |

Each substrate's PR must:

1. Produce the floor artifact in its release workflow.
2. Reference this policy doc from the user-facing install instructions (README section, `Install.ps1` for η, wrapper script for κ/ζ).
3. Document the recipient verification command for the substrate's artifact format.

The "target" tier is opt-in per substrate. OCI substrates get target essentially for free via `docker/build-push-action` flags; non-OCI substrates require an additional `cosign sign-blob` step plus uploading the `.cosign.bundle` to the GitHub release.

## Author-side obligations

A release that does not produce floor-tier artifacts must not be published. Concretely:

- **Release workflows must fail loudly** if the floor artifact (`SHA256SUMS` or cosign signature) cannot be produced. No "best-effort" silent skipping.
- **Tags must be immutable**. GitHub release assets and tags should not be edited after publication; if a release is broken, yank it and publish a successor with a new version. SHA256SUMS over a republished asset is meaningless.
- **The signing identity is the workflow OIDC token**, never a long-lived key. Cosign-keyless via Fulcio + Rekor (transparency log) is the project standard. This matches the no-long-lived-keys posture established by ADR-0009/0011/0012 for inbound vendor binaries; outbound artifacts mirror it.
- **Recipients must be told what to verify and how**. Each substrate's README section / install script must surface the verification command from § Recipient verification UX. A signed artifact whose recipients don't verify provides no security benefit.

## Verifying this policy is in force

A reader who wants to confirm a given release actually meets the floor:

```bash
# κ
cosign verify ghcr.io/<owner>/pi_config:vX.Y.Z --certificate-identity-regexp '…' --certificate-oidc-issuer '…'
# (returns 0 → floor met)

# η, ζ, β α-tarball
gh release view vX.Y.Z --json assets --jq '.assets[].name' | grep -E '^SHA256SUMS$'
# (matches → floor met)
```

If either check fails, the release does not meet this policy and should be reported as a defect against the relevant substrate tracking issue.

## Related

- [ADR-0013](../adrs/0013-distribution-substrate-strategy.md) — substrate strategy (named this policy as a precondition)
- [ADR-0014](../adrs/0014-oci-substrate-amendment-to-0013.md) — OCI substrate addition (decided the cosign-keyless-floor-for-OCI / SHA256SUMS-floor-for-non-OCI split this doc operationalizes)
- [ADR-0009](../adrs/0009-pi-runtime-acquisition-strategy.md) / [ADR-0011](../adrs/0011-toolchain-install-strategy.md) / [ADR-0012](../adrs/0012-vendored-pi-default.md) — inbound vendor-asset trust posture mirrored by this outbound-artifact policy
- [ADR-0040](../adrs/0040-consume-psmfd-attested-pi-releases.md) — the pi runtime inbound path now consumes PSMFD-attested `psmfd/pi` releases, closing the loop: the inbound vendor pin verifies the same keyless attestations this policy mandates for outbound artifacts
- [ADR-0038](../adrs/0038-psmfd-pi-build-and-attest-trust-boundary.md) — `psmfd/pi` release artifacts rebuild from mirrored source and are not re-attestations of upstream-built artifacts
- #128 — tracking issue closed by this doc
- Sigstore cosign documentation — <https://docs.sigstore.dev/cosign/>
- SLSA provenance — <https://slsa.dev/spec/v1.0/provenance>
- Docker `build-push-action` attestations — <https://docs.docker.com/build/metadata/attestations/>
