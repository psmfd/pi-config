# pi runtime vendor pin

> **Pinned to pi `v0.80.1-psmfd.1`** (source: PSMFD-attested rebuilds on
> [`psmfd/pi`](https://github.com/psmfd/pi/releases), upstream base `0.80.1`).
>
> Per [ADR-0040](../../../adrs/0040-consume-psmfd-attested-pi-releases.md),
> PSMFD-form pins (`vX.Y.Z-psmfd.N`) fetch from `psmfd/pi` with the tag
> embedded in every asset name; a plain upstream pin (`vX.Y.Z`) remains a
> supported emergency-rollback path against `earendil-works/pi`. When
> bumping, follow the procedure below (attestation verification is part of
> the PSMFD bump path) and record the new pi version in the commit message.

## What's here

| File | Purpose |
|---|---|
| `VERSION` | Single line, the upstream release tag (e.g. `v0.78.1`). Drives the download URL and the expected cache subdirectory. |
| `CHECKSUMS` | `sha256  filename` pairs (one per platform asset) in the format `sha256sum -c` expects. Verified mandatorily by `fetch_pi_binary()`. |
| `README.md` | This file. |

## Platform coverage

`psmfd/pi` publishes six platform archives per release tag, named
`pi-<triple>-<tag>.<ext>` (e.g. `pi-linux-x64-v0.79.1-psmfd.1.tar.gz`), plus
a CycloneDX SBOM and `SHA256SUMS` (all attested):

| Triple | Asset pattern | Status in `fetch_pi_binary()` |
|---|---|---|
| `linux-x64` | `pi-linux-x64-<tag>.tar.gz` | Supported |
| `linux-arm64` | `pi-linux-arm64-<tag>.tar.gz` | Supported |
| `darwin-x64` | `pi-darwin-x64-<tag>.tar.gz` | Supported |
| `darwin-arm64` | `pi-darwin-arm64-<tag>.tar.gz` | Supported |
| `windows-x64` | `pi-windows-x64-<tag>.zip` | Checksums tracked; runtime fetch unsupported on Windows hosts (see "Windows-host limitation" below) |
| `windows-arm64` | `pi-windows-arm64-<tag>.zip` | Checksums tracked; runtime fetch unsupported on Windows hosts |

(Upstream `earendil-works/pi` assets use the same triples without the tag
suffix; the fetcher and validator handle both forms by pin shape.)

If a future tag stops publishing one of the above, `scripts/validate-pi-vendor.sh` fails loudly so the omission is caught at bump time.

## How this is consumed

`scripts/lib/fetch-pi-binary.sh` provides the sourceable `fetch_pi_binary()` function. It is wired into `setup.sh` as the default pi acquisition path; set `PI_USE_VENDORED=0` to opt out to npm installation. The function is also exercised by its own `--self-test` mode. It:

1. Reads `VERSION` and `CHECKSUMS` from this directory.
2. Detects the host triple via `uname -ms`.
3. Downloads the matching archive from `https://github.com/psmfd/pi/releases/download/<tag>/<asset>` (PSMFD-form pins) or `https://github.com/earendil-works/pi/releases/download/<tag>/<asset>` (plain upstream pins) if not already cached.
4. Verifies sha256 against `CHECKSUMS` (mandatory; no skip flag).
5. Extracts to `~/.cache/pi_config/pi-<tag>/`.
6. Emits the absolute path to the binary on stdout.

The cache directory is the single permitted destination for binary placement. `setup.sh` symlinks the produced vendored binary path into `~/.local/bin/pi` by default.

## Bump procedure

Mechanism canonical in [ADR-0009](../../../adrs/0009-pi-runtime-acquisition-strategy.md) § Bump procedure, release surface amended by [ADR-0040](../../../adrs/0040-consume-psmfd-attested-pi-releases.md). If this section and the ADRs diverge, the ADRs win and this section is the bug.

```sh
# 1. Pick the new PSMFD tag (example). PSMFD releases are cut per the
#    runbook in docs/psmfd-pi-release-runbook.md.
NEW_TAG=v0.79.1-psmfd.1

# 2. Verify all six platform archives + SHA256SUMS exist on the release.
gh release view "$NEW_TAG" --repo psmfd/pi --json assets \
  -q '.assets[].name' | sort

# 3. Download SHA256SUMS and VERIFY ITS ATTESTATION before trusting it,
#    then refresh CHECKSUMS from it (platform archives only, no SBOM).
tmp="$(mktemp -d)"
gh release download "$NEW_TAG" --repo psmfd/pi -p SHA256SUMS --dir "$tmp"
gh attestation verify "$tmp/SHA256SUMS" --repo psmfd/pi \
  --signer-workflow psmfd/pi/.github/workflows/psmfd-release.yml
grep -Ev 'pi-sbom' "$tmp/SHA256SUMS" > agent/vendor/pi/CHECKSUMS

# 4. Update VERSION.
echo "$NEW_TAG" > agent/vendor/pi/VERSION

# 5. Smoke test (downloads, sha256-verifies, runs the binary), then
#    attestation-verify the fetched archive itself.
scripts/lib/fetch-pi-binary.sh --self-test
gh attestation verify \
  "${XDG_CACHE_HOME:-$HOME/.cache}/pi_config/downloads/pi-"*"-$NEW_TAG.tar.gz" \
  --repo psmfd/pi \
  --signer-workflow psmfd/pi/.github/workflows/psmfd-release.yml

# 6. Consider whether agent/extensions/subagent/ should re-pair to the new
#    pi base. See agent/extensions/subagent/README.md and ADR-0009
#    § Relationship to prior decisions for the audit procedure.

# 7. Validate, then PR.
scripts/validate.sh
git commit -m "chore(vendor): bump pi runtime to $NEW_TAG"
```

Emergency rollback path: pin a plain upstream tag (`vX.Y.Z`) and refresh
CHECKSUMS from the upstream release-asset digests
(`gh release view "$NEW_TAG" --repo earendil-works/pi --json assets -q
'.assets[] | "\(.digest|sub("sha256:";""))  \(.name)"'`). Upstream assets
carry no attestations; step 3's attestation verification applies to the
PSMFD path only.

Step 2 is non-negotiable: if upstream stops publishing a triple we use, the fetcher will break for users on that triple. Catching it at bump time means fixing it as part of the bump PR rather than as a follow-up bug. Step 6 is a *consideration*, not a mandate — a base-version mismatch between this vendor pin and the subagent extension pin is not an error per se (the subagent extension's contract is the public extension API, not the internal `dist/` shape), but a mismatch wider than one or two minor versions warrants an audit.

## Air-gapped / offline installs

If the host cannot reach `github.com` at install time, drop the pre-fetched archive at:

```text
~/.cache/pi_config/downloads/<asset-filename>
```

`fetch_pi_binary()` checks this location before attempting a download. The sha256 verification step still runs — a manually placed archive that doesn't match `CHECKSUMS` is rejected with the same error as a bad download.

## License & redistribution posture

pi is MIT-licensed (verified `license: MIT` on `earendil-works/pi` via the GitHub API). We **fetch** upstream binaries at install time; we do not **redistribute** them. The committed files in this directory are metadata (a version pin and digest list) and contain no upstream code, so no third-party NOTICE aggregation obligation is incurred by `pi_config` itself.

If a future change to this acquisition path moves toward redistribution (mirror our own release assets, bundle into a tarball we ship, etc.), the NOTICE-aggregation obligation re-applies and ADR-0009 should be amended or superseded to record that decision.

## Windows-host limitation

The committed CHECKSUMS file covers the Windows `.zip` assets so `scripts/validate-pi-vendor.sh` can verify the full upstream asset set, but `fetch_pi_binary()` exits with a clear error on Windows hosts: `setup.sh` itself does not yet support Windows/WSL bootstrap (per [#99](https://github.com/TheSemicolon/pi_config/issues/99)'s existing scope carve-out), so wiring the Windows path through `fetch_pi_binary()` would be premature. When Windows/WSL support lands in `setup.sh`, this limitation lifts without a CHECKSUMS change.

## Relationship to other vendored surfaces

This directory is one of two vendored surfaces in the repo. The other is `agent/extensions/subagent/` ([ADR-0001](../../../adrs/0001-subagent-orchestration-substrate.md)), which vendors *extension source we patch*. The two are governed by different ADRs because they solve different problems (source-with-patches vs reproducible-binary-acquisition); see [ADR-0009](../../../adrs/0009-pi-runtime-acquisition-strategy.md) § Relationship to prior decisions for the comparison table and the "track each other where possible" guidance.

As of the v0.80.1-psmfd.1 bump, this runtime pin tracks pi `0.80.1`. The vendored subagent snapshot is still sourced from pi `0.78.1` (last re-audited 2026-06-07, [#296](https://github.com/TheSemicolon/pi_config/issues/296)); the resulting `0.78`→`0.80` gap is now two minor versions — the edge of the "one or two minor versions" tolerance in [ADR-0009](../../../adrs/0009-pi-runtime-acquisition-strategy.md) § Relationship to prior decisions — so a subagent re-pair is now advisable and is tracked as a follow-up. This bump performs no re-pair and does not re-audit the snapshot against `0.80.1`. Carried forward from the last re-audit (0.78.1 → 0.79.10): patch #3 (`tool_execution_*` UI refresh) was **still required** at `0.79.10` (which still shipped the dead `tool_result_end` branch while `agent-session` emits `tool_execution_{start,update,end}`) and is retained; the pending re-audit should confirm whether it still applies against `0.80.1`. Earlier patches #1/#2 were dropped at the 0.75.4 re-audit ([#136](https://github.com/TheSemicolon/pi_config/issues/136)) once upstream adopted them per [earendil-works/pi#4710](https://github.com/earendil-works/pi/issues/4710). Future bumps should continue to consider both pins together.
