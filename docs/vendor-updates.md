# Vendor updates

## Purpose

This guide is the canonical maintainer runbook for checking, bumping, validating, and documenting vendored items in this repository. Use it with the `/vendor-update` workflow prompt in [`agent/prompts/vendor-update.md`](../agent/prompts/vendor-update.md).

## Active vendored surfaces

| Vendored item | Path | Type | Governing decision |
|---|---|---|---|
| Pi runtime | `agent/vendor/pi/` | Runtime binary pin metadata: `VERSION`, `CHECKSUMS`, `README.md` | [ADR-0009](../adrs/0009-pi-runtime-acquisition-strategy.md), [ADR-0040](../adrs/0040-consume-psmfd-attested-pi-releases.md) |
| nvm installer | `agent/vendor/nvm/` | Installer version and checksum metadata | [ADR-0010](../adrs/0010-setup-install-trust-posture.md) |
| GitHub CLI | `agent/vendor/gh/` | Release asset version and checksum metadata | [ADR-0011](../adrs/0011-toolchain-install-strategy.md) |
| yq | `agent/vendor/yq/` | Release asset version and checksum metadata | [ADR-0011](../adrs/0011-toolchain-install-strategy.md) |
| ShellCheck | `agent/vendor/shellcheck/` | Release asset version and checksum metadata | [ADR-0011](../adrs/0011-toolchain-install-strategy.md) |
| Gitleaks | `agent/vendor/gitleaks/` | Release asset version and checksum metadata | [ADR-0037](../adrs/0037-secret-scanner-tooling-strategy.md) |
| Subagent extension | `agent/extensions/subagent/` | Vendored source snapshot with local patch table | [ADR-0001](../adrs/0001-subagent-orchestration-substrate.md) |

Do **not** treat archived `docs/archive/smolvm/` material as a live vendored surface.

## Shared rules

- Declare the target upstream version or tag before editing files.
- Verify upstream release assets or source installer content before changing local metadata.
- Do not update `VERSION` without updating `CHECKSUMS` for checksum-pinned vendors.
- Keep each vendor `README.md` synchronized with its `VERSION` and trust posture.
- Keep governing ADR links and rationale intact.
- Run item-specific validation before repository-wide validation.
- Run `scripts/validate.sh` before opening the PR.
- Run available smoke or self-test commands for the affected vendor.
- File or reuse follow-up issues before implementation if the bump reveals out-of-scope work.
- Create an ADR only if the bump changes vendor strategy, trust posture, install policy, or architecture.

## Trust posture notes

For GitHub release-asset vendors (`gh`, `yq`, `shellcheck`, and `gitleaks`), the procedures below harvest GitHub release-asset digests from the GitHub API. Validate that every generated `CHECKSUMS` line has a 64-hex-character sha256 field before committing it. If upstream provides independent signatures, attestations, or locally downloadable artifacts for a practical cross-check, prefer performing that check as part of the bump.

The `pi` runtime vendor goes further per [ADR-0040](../adrs/0040-consume-psmfd-attested-pi-releases.md): its digest source is the release's `SHA256SUMS` file, which must pass `gh attestation verify` (keyless OIDC, signer-workflow-constrained against `psmfd/pi`'s release workflow) before any digest from it is committed. The fetched archive is attestation-verified again at bump time after the self-test.

For nvm, upstream does not publish a signed checksum for `install.sh`; this repository records the sha256 of the installer fetched from `raw.githubusercontent.com` at bump time. Run the bump from a trusted network and review the `install.sh` diff between the previous and target tags before recording the new hash.

## Per-vendor procedures

### Pi runtime: `agent/vendor/pi/`

Use this procedure for the pi runtime binary pin.

Files normally changed:

- `agent/vendor/pi/VERSION`
- `agent/vendor/pi/CHECKSUMS`
- `agent/vendor/pi/README.md` when version examples, platform notes, or consumption details change

Procedure (PSMFD-attested releases per [ADR-0040](../adrs/0040-consume-psmfd-attested-pi-releases.md); PSMFD releases are cut via [`psmfd-pi-release-runbook.md`](psmfd-pi-release-runbook.md)):

```sh
NEW_TAG=vX.Y.Z-psmfd.N

gh release view "$NEW_TAG" --repo psmfd/pi --json assets \
  -q '.assets[].name' | sort

# Attestation-verify SHA256SUMS BEFORE trusting it as the digest source.
tmp="$(mktemp -d)"
gh release download "$NEW_TAG" --repo psmfd/pi -p SHA256SUMS --dir "$tmp"
gh attestation verify "$tmp/SHA256SUMS" --repo psmfd/pi \
  --signer-workflow psmfd/pi/.github/workflows/psmfd-release.yml
grep -Ev 'pi-sbom' "$tmp/SHA256SUMS" > agent/vendor/pi/CHECKSUMS
awk 'length($1) != 64 { exit 1 } END { if (NR == 0) exit 1 }' agent/vendor/pi/CHECKSUMS

printf '%s\n' "$NEW_TAG" > agent/vendor/pi/VERSION

scripts/validate-pi-vendor.sh
scripts/lib/fetch-pi-binary.sh --self-test
gh attestation verify \
  "${XDG_CACHE_HOME:-$HOME/.cache}/pi_config/downloads/pi-"*"-$NEW_TAG.tar.gz" \
  --repo psmfd/pi \
  --signer-workflow psmfd/pi/.github/workflows/psmfd-release.yml
```

Emergency rollback to an upstream pin (`vX.Y.Z`, no attestations — sha256
digests harvested from the GitHub API instead):

```sh
gh release view "$NEW_TAG" --repo earendil-works/pi --json assets \
  -q '.assets[] | "\(.digest|sub("sha256:";""))  \(.name)"' \
  > agent/vendor/pi/CHECKSUMS
```

Also consider whether `agent/extensions/subagent/` should re-pair to the new pi source snapshot. A runtime-pin bump does not automatically require a subagent-extension bump, but a widening version gap should be audited.

### nvm: `agent/vendor/nvm/`

Use this procedure for the nvm installer pin.

Files normally changed:

- `agent/vendor/nvm/VERSION`
- `agent/vendor/nvm/CHECKSUMS`
- `agent/vendor/nvm/README.md` when version examples or installer behavior change

Procedure:

```sh
NEW_TAG=vX.Y.Z

curl -fsS -o /dev/null \
  "https://raw.githubusercontent.com/nvm-sh/nvm/$NEW_TAG/install.sh"

tmpfile=$(mktemp)
trap 'rm -f "$tmpfile"' EXIT
curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NEW_TAG/install.sh" -o "$tmpfile"
printf '%s  install.sh\n' "$(sha256sum "$tmpfile" | awk '{print $1}')" \
  > agent/vendor/nvm/CHECKSUMS
awk 'length($1) != 64 { exit 1 } END { if (NR == 0) exit 1 }' agent/vendor/nvm/CHECKSUMS

printf '%s\n' "$NEW_TAG" > agent/vendor/nvm/VERSION

scripts/validate-nvm-vendor.sh
scripts/lib/install-helpers.sh --self-test
```

### GitHub CLI: `agent/vendor/gh/`

Use this procedure for the GitHub CLI release-asset pin.

Files normally changed:

- `agent/vendor/gh/VERSION`
- `agent/vendor/gh/CHECKSUMS`
- `agent/vendor/gh/README.md` when platform coverage, version examples, or install behavior change

Procedure:

```sh
NEW_TAG=vX.Y.Z

gh release view "$NEW_TAG" --repo cli/cli --json assets \
  -q '.assets[].name' | sort

gh release view "$NEW_TAG" --repo cli/cli --json assets \
  -q '.assets[] | select(.name | test("(linux|macOS).*(amd64|arm64)\\.(tar\\.gz|zip)$")) | "\(.digest | sub("^sha256:"; ""))  \(.name)"' \
  > agent/vendor/gh/CHECKSUMS
awk 'length($1) != 64 { exit 1 } END { if (NR == 0) exit 1 }' agent/vendor/gh/CHECKSUMS

printf '%s\n' "$NEW_TAG" > agent/vendor/gh/VERSION

scripts/validate-gh-vendor.sh
scripts/lib/install-helpers.sh --self-test
```

Read release notes before bumping; `gh` is stable but can retire flags or change output fields.

### yq: `agent/vendor/yq/`

Use this procedure for the mikefarah/yq release-asset pin.

This repo vendors **mikefarah/yq**, not the Debian/Ubuntu `kislyuk/yq` package. Do not replace this pin with a distro package path.

Files normally changed:

- `agent/vendor/yq/VERSION`
- `agent/vendor/yq/CHECKSUMS`
- `agent/vendor/yq/README.md` when platform coverage, version examples, or yq-variant rationale change

Procedure:

```sh
NEW_TAG=vX.Y.Z

gh release view "$NEW_TAG" --repo mikefarah/yq --json assets \
  -q '.assets[].name' | sort

gh release view "$NEW_TAG" --repo mikefarah/yq --json assets \
  -q '.assets[] | select(.name | test("^yq_(linux|darwin)_(amd64|arm64)\\.tar\\.gz$")) | "\(.digest | sub("^sha256:"; ""))  \(.name)"' \
  > agent/vendor/yq/CHECKSUMS
awk 'length($1) != 64 { exit 1 } END { if (NR == 0) exit 1 }' agent/vendor/yq/CHECKSUMS

printf '%s\n' "$NEW_TAG" > agent/vendor/yq/VERSION

scripts/validate-yq-vendor.sh
scripts/lib/install-helpers.sh --self-test
```

Skip major-version bumps unless the plan includes an explicit ADR check for yq behavior and trust-posture impact.

### ShellCheck: `agent/vendor/shellcheck/`

Use this procedure for the ShellCheck release-asset pin.

Files normally changed:

- `agent/vendor/shellcheck/VERSION`
- `agent/vendor/shellcheck/CHECKSUMS`
- `agent/vendor/shellcheck/README.md` when platform coverage, version examples, or rule-change notes change

Procedure:

```sh
NEW_TAG=vX.Y.Z

gh release view "$NEW_TAG" --repo koalaman/shellcheck --json assets \
  -q '.assets[].name' | sort

gh release view "$NEW_TAG" --repo koalaman/shellcheck --json assets \
  -q '.assets[] | select(.name | test("^shellcheck-.*\\.(linux|darwin)\\.(x86_64|aarch64)\\.tar\\.gz$")) | "\(.digest | sub("^sha256:"; ""))  \(.name)"' \
  > agent/vendor/shellcheck/CHECKSUMS
awk 'length($1) != 64 { exit 1 } END { if (NR == 0) exit 1 }' agent/vendor/shellcheck/CHECKSUMS

printf '%s\n' "$NEW_TAG" > agent/vendor/shellcheck/VERSION

scripts/validate-shellcheck-vendor.sh
scripts/lib/install-helpers.sh --self-test
scripts/validate.sh
```

If ShellCheck introduces new findings in this repo, fix them in the same PR as the bump.

### Gitleaks: `agent/vendor/gitleaks/`

Use this procedure for the Gitleaks secret-scanner release-asset pin.

Files normally changed:

- `agent/vendor/gitleaks/VERSION`
- `agent/vendor/gitleaks/CHECKSUMS`
- `agent/vendor/gitleaks/README.md` when platform coverage, version examples, or scan semantics change

Procedure:

```sh
NEW_TAG=vX.Y.Z
export NEW_VER="${NEW_TAG#v}"

gh release view "$NEW_TAG" --repo gitleaks/gitleaks --json assets \
  -q '.assets[].name' | sort

gh release view "$NEW_TAG" --repo gitleaks/gitleaks --json assets \
  -q '.assets[] | select(.name | test("^gitleaks_" + env.NEW_VER + "_(linux|darwin)_(x64|arm64)\\.tar\\.gz$")) | "\(.digest | sub("^sha256:"; ""))  \(.name)"' \
  > agent/vendor/gitleaks/CHECKSUMS
awk 'length($1) != 64 { exit 1 } END { if (NR == 0) exit 1 }' agent/vendor/gitleaks/CHECKSUMS

printf '%s\n' "$NEW_TAG" > agent/vendor/gitleaks/VERSION

scripts/validate-gitleaks-vendor.sh
scripts/lib/install-helpers.sh --self-test
scripts/scan-secrets.sh --history --all-refs
scripts/validate.sh
```

`scan-secrets.sh --history --all-refs` requires a non-shallow clone. If a
Gitleaks bump introduces new findings, classify them in the bump PR. Real
secrets require rotation and remediation before merge; false positives require a
reviewed allowlist or baseline decision.

### Subagent extension: `agent/extensions/subagent/`

Use this procedure for vendored subagent source re-pairing or re-audit work.

Files normally changed:

- `agent/extensions/subagent/index.ts`
- `agent/extensions/subagent/agents.ts`
- `agent/extensions/subagent/README.md`
- paired pi-agent-expert references when patch inventory or source-version facts change

Procedure:

```sh
scripts/typecheck-extensions.sh
scripts/lint-extensions.sh
scripts/validate.sh
```

Before committing:

- Diff against upstream `examples/extensions/subagent/` for the exact target pi version, using the release tarball or tag that matches the declared source version rather than an arbitrary `main` checkout.
- Review the local patch table in `agent/extensions/subagent/README.md`.
- Make an explicit retain/drop decision for each local patch.
- Update patch line ranges and provenance text.
- Cite the source pi version in the commit message.
- Run `/review` because extension source or runtime behavior changed.

## Validation matrix

| Surface | Asset/source verification | Targeted validation | Additional checks |
|---|---|---|---|
| `agent/vendor/pi/` | Attested `SHA256SUMS` from `gh release download "$NEW_TAG" --repo psmfd/pi` + `gh attestation verify` | `scripts/validate-pi-vendor.sh` | `scripts/lib/fetch-pi-binary.sh --self-test` + archive attestation verify; consider subagent re-pair |
| `agent/vendor/nvm/` | `curl -fsS -o /dev/null "https://raw.githubusercontent.com/nvm-sh/nvm/$NEW_TAG/install.sh"` | `scripts/validate-nvm-vendor.sh` | `scripts/lib/install-helpers.sh --self-test` |
| `agent/vendor/gh/` | `gh release view "$NEW_TAG" --repo cli/cli --json assets` | `scripts/validate-gh-vendor.sh` | `scripts/lib/install-helpers.sh --self-test` |
| `agent/vendor/yq/` | `gh release view "$NEW_TAG" --repo mikefarah/yq --json assets` | `scripts/validate-yq-vendor.sh` | `scripts/lib/install-helpers.sh --self-test`; confirm mikefarah/yq variant |
| `agent/vendor/shellcheck/` | `gh release view "$NEW_TAG" --repo koalaman/shellcheck --json assets` | `scripts/validate-shellcheck-vendor.sh` | `scripts/lib/install-helpers.sh --self-test`; run full validation for new lint findings |
| `agent/vendor/gitleaks/` | `gh release view "$NEW_TAG" --repo gitleaks/gitleaks --json assets` | `scripts/validate-gitleaks-vendor.sh` | `scripts/lib/install-helpers.sh --self-test`; run `scripts/scan-secrets.sh --history --all-refs` |
| `agent/extensions/subagent/` | Diff target pi `examples/extensions/subagent/` against local source | `scripts/typecheck-extensions.sh`; `scripts/lint-extensions.sh` | Review local patch table; run `/review` for source/runtime changes |

Always finish with:

```sh
scripts/validate.sh
```

## Documentation and ADR checks

Before editing, classify documentation impact per [`agent/rules/documentation-in-plan.md`](../agent/rules/documentation-in-plan.md):

| Change type | Documentation surfaces to check |
|---|---|
| Vendor version bump | The affected vendor `README.md`; governing ADR links; PR checklist evidence |
| Pi runtime bump | `agent/vendor/pi/README.md`; possible `agent/extensions/subagent/README.md`; pi-agent-expert references if subagent provenance changes |
| Subagent extension re-pair | `agent/extensions/subagent/README.md`; `agent/extensions/README.md`; `agent/AGENTS.md` repo layout; pi-agent-expert wrapper, skill, and references |
| New slash workflow or prompt changes | `agent/AGENTS.md` workflow catalog; `README.md` workflow table |
| Strategy, trust-posture, install-policy, or architecture change | New ADR or successor ADR; `README.md` Architecture Decisions list |

If the bump reveals out-of-scope work, file or reuse the follow-up issue before implementation and reference it in the PR body.

## PR checklist

- [ ] Target upstream version/tag declared.
- [ ] Current repo state inspected before edits.
- [ ] Upstream assets or installer source verified.
- [ ] `VERSION` and `CHECKSUMS` updated together where applicable.
- [ ] Affected vendor `README.md` checked and updated if needed.
- [ ] Governing ADR impact checked.
- [ ] Out-of-scope follow-ups filed or explicitly rejected.
- [ ] Item-specific validation passed.
- [ ] Self-test or smoke command for the affected vendor passed where available.
- [ ] `scripts/validate.sh` passed.
- [ ] `/review` run when source code, extension code, runtime behavior, or install behavior changed.
- [ ] PR body includes Summary, Test Plan, Risk, and Follow-ups when applicable.
