# yq (mikefarah) vendor pin

> **Pinned to mikefarah/yq `v4.53.2`** (source: GitHub Releases on [`mikefarah/yq`](https://github.com/mikefarah/yq/releases)).
>
> When bumping, follow the procedure below and record the new yq version in the commit message. Trust posture and yq-variant rationale: [ADR-0011](../../../adrs/0011-toolchain-install-strategy.md).

## ⚠️ Why this specific yq

There are three tools named `yq` in the wild. The full comparison and reasoning are in ADR-0011 § "Why mikefarah/yq specifically." Summary:

- **mikefarah/yq** (this vendor pin) — Go binary, native YAML DSL, in-place edits, `brew install yq` default.
- **kislyuk/yq** — Python wrapper around jq, no in-place edits, **`apt install yq` on Debian/Ubuntu installs this one** (cross-platform footgun).
- **python-yq** (PyPI rename of kislyuk) — same as kislyuk.

This vendor pin closes the apt-default-is-the-wrong-yq hazard structurally: `ih_ensure_yq` never consults distro packages, so a contributor on Ubuntu and a contributor on macOS run the *same* tool.

## What's here

| File | Purpose |
|---|---|
| `VERSION` | Single line, the upstream release tag (e.g. `v4.53.2`). Drives the download URL and the expected cache subdirectory. |
| `CHECKSUMS` | `sha256  filename` pairs (one per platform asset) in the format `sha256sum -c` expects. Verified mandatorily by `ih_ensure_yq` (per ADR-0011). |
| `README.md` | This file. |

## Platform coverage

`mikefarah/yq` publishes binaries (and `.tar.gz` archives wrapping them) for many platforms; we pin the `.tar.gz` variants matching ADR-0009's pi-vendor matrix:

| Triple | Asset |
|---|---|
| `linux-x64` | `yq_linux_amd64.tar.gz` |
| `linux-arm64` | `yq_linux_arm64.tar.gz` |
| `darwin-x64` | `yq_darwin_amd64.tar.gz` |
| `darwin-arm64` | `yq_darwin_arm64.tar.gz` |

The `.tar.gz` variants are used (rather than the raw binaries) for consistency with the pi-vendor extraction pattern in `fetch_pi_binary()`. Inside each archive the binary is named `yq_<os>_<arch>`; `ih_ensure_yq` renames the extracted binary to `yq` when symlinking into `~/.local/bin/`.

Windows is intentionally out of scope (consistent with `agent/vendor/gh/`).

## How this is consumed

`scripts/lib/install-helpers.sh` provides `ih_ensure_yq`. Per ADR-0011, it is invoked from `setup.sh` §1b. On invocation it:

1. Reads `VERSION` and `CHECKSUMS` from this directory.
2. Detects the host triple via `pd_os`/`pd_arch`.
3. Skips if `command -v yq` succeeds, `yq --version` reports the pinned tag, *and* the running yq is mikefarah-flavored (verified by string match on the version output, which kislyuk yq does not produce).
4. Downloads the matching archive from `https://github.com/mikefarah/yq/releases/download/<tag>/<asset>` if not cached.
5. Verifies sha256 against `CHECKSUMS` (mandatory; no skip flag).
6. Extracts to `~/.cache/pi_config/yq-<tag>/` and symlinks `~/.local/bin/yq` to the binary.

## Bump procedure

1. Pick the new tag from <https://github.com/mikefarah/yq/releases>. mikefarah/yq follows semver; v4.x is the current major. Skip v5 bumps without explicit ADR discussion.
2. Fetch fresh digests:

   ```bash
   gh release view --repo mikefarah/yq vX.Y.Z --json assets \
     -q '.assets[] | select(.name | test("^yq_(linux|darwin)_(amd64|arm64)\\.tar\\.gz$")) | "\(.digest | sub("^sha256:"; ""))  \(.name)"'
   ```

3. Replace `VERSION` (preserve trailing newline) and `CHECKSUMS` (four lines).
4. Run `scripts/validate-yq-vendor.sh` and `scripts/validate.sh` — both must pass.
5. (Optional) Delete `~/.cache/pi_config/yq-<old-tag>/` and re-run `ih_ensure_yq` to end-to-end verify before opening the PR.
6. Open a PR. CODEOWNERS routes review to the named maintainer.

## Threat model

Same as `agent/vendor/gh/` and `agent/vendor/pi/`. The pinned sha256 is the trust boundary; CODEOWNERS named-reviewer enforcement on `/agent/vendor/yq/{VERSION,CHECKSUMS}` is the mitigation against the malicious co-mutation vector.
