# gitleaks vendor pin

> **Pinned to gitleaks `v8.30.1`** (source: GitHub Releases on
> [`gitleaks/gitleaks`](https://github.com/gitleaks/gitleaks/releases)).
>
> When bumping, follow the procedure below and record the new gitleaks version
> in the commit message. Trust posture: [ADR-0037](../../../adrs/0037-secret-scanner-tooling-strategy.md).

## What's here

| File | Purpose |
|---|---|
| `VERSION` | Single line, the upstream release tag (for example `v8.30.1`). Drives the download URL and cache directory. |
| `CHECKSUMS` | `sha256  filename` pairs for the four supported platform assets. Verified by `ih_ensure_gitleaks`. |
| `README.md` | This file. |

## Platform coverage

`gitleaks/gitleaks` publishes binaries for several platforms; this repository
pins the `.tar.gz` variants matching the rest of the setup toolchain matrix:

| Triple | Asset |
|---|---|
| `linux-x64` | `gitleaks_<ver>_linux_x64.tar.gz` |
| `linux-arm64` | `gitleaks_<ver>_linux_arm64.tar.gz` |
| `darwin-x64` | `gitleaks_<ver>_darwin_x64.tar.gz` |
| `darwin-arm64` | `gitleaks_<ver>_darwin_arm64.tar.gz` |

Windows, Linux x32, and Linux armv6/armv7 assets are intentionally out of
scope for this repo's setup path.

## How this is consumed

`scripts/lib/install-helpers.sh` provides `ih_ensure_gitleaks`. It is invoked
from `setup.sh` §1b and:

1. Reads `VERSION` and `CHECKSUMS` from this directory.
2. Detects the host triple via `pd_os`/`pd_arch`.
3. Skips when `gitleaks version` reports the pinned version.
4. Downloads the matching archive from
   `https://github.com/gitleaks/gitleaks/releases/download/<tag>/<asset>`.
5. Verifies sha256 against `CHECKSUMS`.
6. Extracts to `~/.cache/pi_config/gitleaks-<tag>/` and symlinks
   `~/.local/bin/gitleaks` to the extracted binary.

`scripts/scan-secrets.sh` is the repo wrapper for tracked-file working-tree
and history scans. It uses redacted output and maps gitleaks exit codes into
this repo's script convention. `--working-tree` requires `python3` to copy
tracked files into an isolated scan tree; `--history` requires a non-shallow git
clone.

## Bump procedure

1. Pick the new tag from <https://github.com/gitleaks/gitleaks/releases>.
2. Fetch fresh digests:

   ```bash
   NEW_TAG=vX.Y.Z
   export NEW_VER="${NEW_TAG#v}"

   gh release view "$NEW_TAG" --repo gitleaks/gitleaks --json assets \
     -q '.assets[].name' | sort

   gh release view "$NEW_TAG" --repo gitleaks/gitleaks --json assets \
     -q '.assets[] | select(.name | test("^gitleaks_" + env.NEW_VER + "_(linux|darwin)_(x64|arm64)\\.tar\\.gz$")) | "\(.digest | sub("^sha256:"; ""))  \(.name)"' \
     > agent/vendor/gitleaks/CHECKSUMS
   ```

3. Replace `VERSION` with `NEW_TAG` and keep the trailing newline.
4. Run:

   ```bash
   scripts/validate-gitleaks-vendor.sh
   scripts/lib/install-helpers.sh --self-test
   scripts/validate.sh
   ```

5. Run an operator scan when the bump changes detector behavior:

   ```bash
   scripts/scan-secrets.sh --history --all-refs
   ```

## Threat model

Gitleaks is the canonical setup-installed scanner for repo/file/history audits
per ADR-0037. The pinned sha256 values are the install trust boundary, and
CODEOWNERS review on `VERSION`/`CHECKSUMS` mitigates malicious co-mutation of
the version and digest pins.

Gitleaks does not replace `hooks/secrets-guard.sh` or the `secrets-guard` pi
extension. Those remain the fast prevention layer; gitleaks is the broader
audit layer.
