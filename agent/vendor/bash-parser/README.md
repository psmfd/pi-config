# bash-parser vendor pin

> **Pinned to `pi-bash-parser` `v0.1.0`** (source: GitHub Releases on
> [`psmfd/pi-bash-parser`](https://github.com/psmfd/pi-bash-parser/releases)).
>
> `pi-bash-parser` is a first-party, `mvdan/sh`-backed shell-command AST
> projector consumed by the `bash-destructive-guard` extension as an **additive**
> second opinion — it only ever ADDS a denial (deny-by-default is an opt-in
> `PI_BASH_GUARD_AST_STRICT=1` posture, not the default). See
> [ADR-0100](../../../adrs/0100-bash-destructive-guard-ast-second-pass.md).
> When bumping, follow the procedure below and record the new version in the
> commit message. Trust posture matches pi's own runtime vendor
> ([ADR-0040](../../../adrs/0040-consume-psmfd-attested-pi-releases.md)): the
> `gh attestation verify` step is performed at **bump time** (below) and the
> committed `CHECKSUMS` — derived from those attested bytes — is the
> install-time trust anchor (sha256, no attestation call at install). Release
> infra per [ADR-0099](../../../adrs/0099-reusable-release-workflows-and-parser-vendor.md).

## What's here

| File | Purpose |
|---|---|
| `VERSION` | Single line, the release tag (for example `v0.1.0`). Drives the download URL and cache directory. |
| `CHECKSUMS` | `sha256  filename` pairs for the four supported platform assets. Verified by `ih_ensure_bash_parser`. |
| `README.md` | This file. |

## Platform coverage

The `.tar.gz` assets matching the rest of the setup toolchain matrix:

| Host triple (`pd_os`-`pd_arch`) | Asset |
|---|---|
| `darwin-arm64` | `pi-bash-parser-darwin-arm64-vX.Y.Z.tar.gz` |
| `darwin-amd64` | `pi-bash-parser-darwin-amd64-vX.Y.Z.tar.gz` |
| `linux-arm64` | `pi-bash-parser-linux-arm64-vX.Y.Z.tar.gz` |
| `linux-amd64` | `pi-bash-parser-linux-amd64-vX.Y.Z.tar.gz` |

Each tarball contains the `pi-bash-parser` binary plus `LICENSE` and `README.md`.

## Bump procedure

1. Pick the new release tag `vX.Y.Z` from
   [`psmfd/pi-bash-parser/releases`](https://github.com/psmfd/pi-bash-parser/releases).
2. Attestation-verify the release assets before trusting their digests
   (ADR-0040 posture — the parser is attested under its own signer identity):

   ```sh
   tmp="$(mktemp -d)"; cd "$tmp"
   gh release download "vX.Y.Z" --repo psmfd/pi-bash-parser
   sha256sum -c SHA256SUMS
   for f in pi-bash-parser-*; do
     gh attestation verify "$f" --repo psmfd/pi-bash-parser \
       --signer-workflow psmfd/pi-bash-parser/.github/workflows/release.yml
   done
   ```

3. Copy the verified `SHA256SUMS` to `CHECKSUMS` and write the tag to `VERSION`.
4. Run `scripts/validate-bash-parser-vendor.sh` and `scripts/validate.sh`.
