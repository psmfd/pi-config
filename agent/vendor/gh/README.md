# gh (GitHub CLI) vendor pin

> **Pinned to gh `v2.93.0`** (source: GitHub Releases on [`cli/cli`](https://github.com/cli/cli/releases)).
>
> When bumping, follow the procedure below and record the new gh version in the commit message. Trust posture: [ADR-0011](../../../adrs/0011-toolchain-install-strategy.md).

## What's here

| File | Purpose |
|---|---|
| `VERSION` | Single line, the upstream release tag (e.g. `v2.92.0`). Drives the download URL and the expected cache subdirectory. |
| `CHECKSUMS` | `sha256  filename` pairs (one per platform asset) in the format `sha256sum -c` expects. Verified mandatorily by `ih_ensure_gh` (per ADR-0011). |
| `README.md` | This file. |

## Platform coverage

`cli/cli` publishes assets across many platforms; we pin the four matching ADR-0009's pi-vendor matrix:

| Triple | Asset | Status |
|---|---|---|
| `linux-x64` | `gh_<ver>_linux_amd64.tar.gz` | Supported |
| `linux-arm64` | `gh_<ver>_linux_arm64.tar.gz` | Supported |
| `darwin-x64` | `gh_<ver>_macOS_amd64.zip` | Supported |
| `darwin-arm64` | `gh_<ver>_macOS_arm64.zip` | Supported |

Windows and other Linux arches (armv6, riscv64, etc.) are intentionally out of scope — `setup.sh` only targets Linux + macOS hosts. `scripts/validate-gh-vendor.sh` fails loudly if any of the four assets above is missing from CHECKSUMS.

## How this is consumed

`scripts/lib/install-helpers.sh` provides `ih_ensure_gh`. Per ADR-0011, it is invoked from `setup.sh` §1b in the toolchain phase (gated on `PI_CONFIG_SKIP_TOOLCHAIN`). On invocation it:

1. Reads `VERSION` and `CHECKSUMS` from this directory.
2. Detects the host triple via `pd_os`/`pd_arch` from `scripts/lib/platform-detect.sh`.
3. Skips if `command -v gh` succeeds and `gh --version` reports the pinned tag (idempotent).
4. Downloads the matching archive from `https://github.com/cli/cli/releases/download/<tag>/<asset>` if not cached.
5. Verifies sha256 against `CHECKSUMS` (mandatory; no skip flag).
6. Extracts to `~/.cache/pi_config/gh-<tag>/` and symlinks `~/.local/bin/gh` to the binary.

## Bump procedure

1. Pick the new tag from <https://github.com/cli/cli/releases>. Read the release notes for breaking changes — `gh` has stable CLI ergonomics but does occasionally retire flags.
2. Fetch fresh digests:

   ```bash
   gh release view --repo cli/cli vX.Y.Z --json assets \
     -q '.assets[] | select(.name | test("(linux|macOS).*(amd64|arm64)\\.(tar\\.gz|zip)$")) | "\(.digest | sub("^sha256:"; ""))  \(.name)"'
   ```

3. Replace `VERSION` with the new tag (preserve trailing newline).
4. Replace `CHECKSUMS` with the four new lines (`sha256  filename`).
5. Run `scripts/validate-gh-vendor.sh` and `scripts/validate.sh` — both must pass.
6. (Optional) On a host with `ih_ensure_gh` already cached at the old tag, delete `~/.cache/pi_config/gh-<old-tag>/` to force a fresh download and end-to-end verification before opening the PR.
7. Open a PR. CODEOWNERS routes review to the named maintainer (the trust gate per ADR-0009 § Trust pinning, extended to this vendor in ADR-0011).

## Threat model

The pinned sha256 in `CHECKSUMS` is the trust boundary. A malicious or compromised PR that bumps `VERSION` + `CHECKSUMS` together to a forged archive + matching digest is the residual vector; CODEOWNERS named-reviewer enforcement on `/agent/vendor/gh/{VERSION,CHECKSUMS}` is the mitigation. Same posture as `agent/vendor/pi/` and `agent/vendor/nvm/`.
