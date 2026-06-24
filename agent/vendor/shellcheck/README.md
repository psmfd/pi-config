# shellcheck vendor pin

> **Pinned to shellcheck `v0.11.0`** (source: GitHub Releases on [`koalaman/shellcheck`](https://github.com/koalaman/shellcheck/releases)).
>
> When bumping, follow the procedure below and record the new shellcheck version in the commit message. Trust posture: [ADR-0011](../../../adrs/0011-toolchain-install-strategy.md).

## What's here

| File | Purpose |
|---|---|
| `VERSION` | Single line, the upstream release tag (e.g. `v0.11.0`). Drives the download URL and the expected cache subdirectory. |
| `CHECKSUMS` | `sha256  filename` pairs (one per platform asset) in the format `sha256sum -c` expects. Verified mandatorily by `ih_ensure_shellcheck` (per ADR-0011). |
| `README.md` | This file. |

## Platform coverage

`koalaman/shellcheck` publishes binaries for many platforms; we pin the `.tar.gz` variants for the four triples matching ADR-0009's pi-vendor matrix:

| Triple | Asset |
|---|---|
| `linux-x64` | `shellcheck-<ver>.linux.x86_64.tar.gz` |
| `linux-arm64` | `shellcheck-<ver>.linux.aarch64.tar.gz` |
| `darwin-x64` | `shellcheck-<ver>.darwin.x86_64.tar.gz` |
| `darwin-arm64` | `shellcheck-<ver>.darwin.aarch64.tar.gz` |

`.tar.xz` variants are also published upstream — we use `.tar.gz` for parity with the other vendor pins (avoids depending on `xz` being installed). armv6, riscv64, and Windows are intentionally out of scope.

shellcheck releases on a slow cadence (months between versions). A pin that lags upstream by a release or two is normal and healthy.

## How this is consumed

`scripts/lib/install-helpers.sh` provides `ih_ensure_shellcheck`. Per ADR-0011, it is invoked from `setup.sh` §1b. On invocation it:

1. Reads `VERSION` and `CHECKSUMS` from this directory.
2. Detects the host triple via `pd_os`/`pd_arch`.
3. Skips if `command -v shellcheck` succeeds and `shellcheck --version` reports the pinned tag (or any version ≥ pinned tag).
4. Downloads the matching archive from `https://github.com/koalaman/shellcheck/releases/download/<tag>/<asset>` if not cached.
5. Verifies sha256 against `CHECKSUMS` (mandatory; no skip flag).
6. Extracts to `~/.cache/pi_config/shellcheck-<tag>/` and symlinks `~/.local/bin/shellcheck` to the extracted binary (which lives at `shellcheck-<tag>/shellcheck` inside the archive).

## Bump procedure

1. Pick the new tag from <https://github.com/koalaman/shellcheck/releases>. Read release notes; shellcheck rule numbers occasionally change.
2. Fetch fresh digests:

   ```bash
   gh release view --repo koalaman/shellcheck vX.Y.Z --json assets \
     -q '.assets[] | select(.name | test("^shellcheck-vX\\.Y\\.Z\\.(linux|darwin)\\.(x86_64|aarch64)\\.tar\\.gz$")) | "\(.digest | sub("^sha256:"; ""))  \(.name)"'
   ```

   (substitute the actual version into the `test()` regex).

3. Replace `VERSION` (preserve trailing newline) and `CHECKSUMS` (four lines).
4. Run `scripts/validate-shellcheck-vendor.sh` and `scripts/validate.sh` — both must pass.
5. Re-run `scripts/validate.sh` end-to-end to confirm no shellcheck rule changes affect our own scripts. If they do, fix the new lints in the same PR.
6. Open a PR. CODEOWNERS routes review to the named maintainer.

## Threat model

Same as `agent/vendor/gh/`, `agent/vendor/yq/`, and `agent/vendor/pi/`. The pinned sha256 is the trust boundary; CODEOWNERS named-reviewer enforcement on `/agent/vendor/shellcheck/{VERSION,CHECKSUMS}` is the mitigation against the malicious co-mutation vector.
