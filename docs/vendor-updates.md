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
| pi-bash-parser | `agent/vendor/bash-parser/` | Release asset version and checksum metadata (first-party, attestation-verified). Bump procedure in the vendor dir's `README.md`. | [ADR-0099](../adrs/0099-reusable-release-workflows-and-parser-vendor.md), [ADR-0040](../adrs/0040-consume-psmfd-attested-pi-releases.md) |
| cocoindex-code | `agent/vendor/cocoindex-code/` | `ccc` engine + embedding-model pin record (`VERSION`, `CHECKSUMS`, `README.md`). Acquired **out-of-band** by pipx, not fetched by `setup.sh`; the runtime source of truth is `agent/extensions/indexing/pin.ts`. Bump procedure below. | [ADR-0033](../adrs/0033-codebase-indexing.md) |
| Subagent extension | `agent/extensions/subagent/` | Vendored source snapshot with local patch table | [ADR-0001](../adrs/0001-subagent-orchestration-substrate.md) |
| Extension SDK pin | `scripts/lib/extension-deps.sh` | `EXTENSION_DEPS_PI_AGENT_VERSION` — the `@earendil-works/pi-*` pin used by `typecheck-extensions.sh` / `lint-extensions.sh`. **Runtime-coupled**: policy is `EXTENSION_DEPS_PI_AGENT_VERSION` == `agent/vendor/pi/VERSION` (stripped to X.Y.Z). Automated by `pin-drift-check.yml` (#566). | [ADR-0021](../adrs/0021-extension-type-checking-and-linting.md), [ADR-0069](../adrs/0069-ext-ref-pin-drift-automation.md) |
| Changelog toast baseline | `agent/settings.example.json` | `lastChangelogVersion` — the version pi's changelog-toast compares against on session start. **Runtime-coupled** the same way. Automated by `pin-drift-check.yml` (#566). | [ADR-0069](../adrs/0069-ext-ref-pin-drift-automation.md) |

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

**Automated path (canonical since ADR-0092, #449):** `scripts/bump-pi-runtime.sh --tag "$NEW_TAG"` (or `--latest`) executes this entire procedure non-interactively — attestation-first fail-closed ordering, README pin-header rewrite, runtime-coupled pin fixes, and the subagent re-pair audit signal — and `.github/workflows/pi-runtime-bump.yml` runs it daily against `psmfd/pi`'s latest release, opening a bump PR on drift (human merge retained). Use `--dry-run` to exercise every verification gate with zero writes, `--check` for a report-only drift probe. The manual steps below remain the reference semantics (and the fallback if the script is unavailable); a plain upstream `vX.Y.Z` emergency-rollback pin is manual-only — the script refuses it by design.

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

#### Full pi-component bump checklist (ADR-0119)

A pi version bump is **not** just what `bump-pi-runtime.sh` touches. The bump's scope is every surface below; a bump PR (or its tracking issue) accounts for each row — bumped here, tracked as a follow-up issue, or explicitly deferred with a reason. The 2026-07-20 brace-expansion advisory (GHSA-3jxr-9vmj-r5cp) is the motivating incident: the alert surface was the mirror packaging layer no tooling covered, and Dependabot cannot move it (nested exact pins under the pi packages only shift when the pi packages themselves bump).

| # | Surface | Where | Moved by |
|---|---|---|---|
| 1 | psmfd/pi mirror source | `psmfd/pi` (sync from upstream) | Manual sync per [`psmfd-pi-mirror-sync.md`](psmfd-pi-mirror-sync.md), then release per [`psmfd-pi-release-runbook.md`](psmfd-pi-release-runbook.md); includes security-patch reconciliation (keep/retire/refresh, `.psmfd/patches/manifest.yml`) |
| 2 | Vendored runtime binary | `agent/vendor/pi/{VERSION,CHECKSUMS,README.md}` | `bump-pi-runtime.sh` (attestation-first) |
| 3 | npm quad pin — pi-coding-agent, pi-agent-core, pi-ai, pi-tui | `scripts/lib/extension-deps.sh` `EXTENSION_DEPS_PI_AGENT_VERSION` | `bump-pi-runtime.sh` (drift-fix target `extension-deps`) |
| 4 | Settings example coupled pin | `agent/settings.example.json` | `bump-pi-runtime.sh` (drift-fix target `settings-example`) |
| 5 | Subagent vendored snapshot pairing | `agent/extensions/subagent/` + `PATCH_MANIFEST.json` | `bump-pi-runtime.sh` emits the audit signal; re-pair itself is human-gated Procedure B (see § Subagent extension) |
| 6 | Mirror packaging deps — each public extension mirror's committed `package.json`/lockfile (`@earendil-works/*` dev-deps; pi-auto-router also has a **runtime** `pi-ai` dep) | The 12 `psmfd/pi-*` mirror repos (preserved by overlay sync, NOT managed from pi_config) | Manual per-repo bump + lockfile regen (`npm install --package-lock-only --ignore-scripts`); automation decision tracked in #856 |
| 7 | agent-expertise-api extension lockfile | `psmfd/agent-expertise-api` `.pi/extensions/expertise-api/package-lock.json` | Manual bump in that repo |

Rows 2–5 are the automated pi_config-local rows; `pi-runtime-bump.yml` bot PRs cover them. Reviewing a bot bump PR means checking rows 1 and 6–7 have an owner (done, issue, or deferred-with-reason).

The two **runtime-coupled surfaces** (`scripts/lib/extension-deps.sh` and `agent/settings.example.json`) will be picked up by `pin-drift-check.yml`'s next run — which fires on `sync-mirrors` completion (belt), or the Monday cron (suspenders), whichever comes first. The workflow opens a bump PR against `dev` that advances both pins to the new runtime pin (stripped to bare `X.Y.Z`). You can also fix locally in the same runtime-bump PR by running:

```sh
scripts/check-ext-ref-drift.sh --fix --target extension-deps
scripts/check-ext-ref-drift.sh --fix --target settings-example
```

Both `--fix` operations are surgical (single-line rewrite each, anchored on the specific `${VAR:-...}` / JSON-key shape).

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

Two distinct workflows share this section: **Procedure A** (add a new local patch to the vendored source) and **Procedure B** (re-pair the vendored snapshot to a new upstream pi). They touch overlapping files but with different retain/drop decisions, so they are kept separate.

Both procedures are gated by the diff-signature drift check (`scripts/validate-subagent-drift.sh`, added under pi_config #582) which fails `scripts/validate.sh` when `agent/extensions/subagent/{index,agents}.ts` diverges from the pinned pi snapshot in a way not recorded in `agent/extensions/subagent/PATCH_MANIFEST.json`. Either procedure must end with a manifest regeneration + patch-table update in the same commit.

#### Procedure A — add a new local patch (new downstream divergence)

Use when introducing a new patch that upstream does not carry (e.g. a new policy layer, a new event-handling branch).

Files normally changed:

- `agent/extensions/subagent/index.ts` (or `agents.ts`, or a new ours-only sibling under `agent/extensions/subagent/`)
- `agent/extensions/subagent/README.md` (**required** — append a new row to the `Local patches` table)
- `agent/extensions/subagent/PATCH_MANIFEST.json` (**required** — regenerate; see below)
- paired pi-agent-expert references when patch inventory or source-version facts change

Steps:

1. Make the source change; keep edits minimal, well-commented, and citation-linked (issue number + ADR reference in the code comment).
2. **Add a new row to the patch table** in `agent/extensions/subagent/README.md` (patch #, files, rationale, tracking).
3. **Regenerate the manifest:** `scripts/validate-subagent-drift.sh --regenerate`
4. Run `scripts/typecheck-extensions.sh`, `scripts/lint-extensions.sh`, and `scripts/validate.sh` — all must be clean.
5. Commit README, source, and manifest **together** in the same commit; conventional-commits scope `subagent`.
6. Run `/review` on the aggregate diff before opening the PR (draft-first if the auto-merge race is a concern).

#### Procedure B — re-pair to a new upstream pi snapshot

Use when the pi runtime pin (`agent/vendor/pi/VERSION`) has been bumped and the vendored subagent source should track it. Typically follows a runtime bump PR by a few days.

Files normally changed:

- `agent/extensions/subagent/index.ts`
- `agent/extensions/subagent/agents.ts`
- `agent/extensions/subagent/README.md` (**required** — update source pi version + audit the patch table)
- `agent/extensions/subagent/PATCH_MANIFEST.json` (**required** — regenerate against the new upstream)
- `agent/vendor/pi/README.md` if it carried a pin-gap warning that is now retired
- paired pi-agent-expert references when patch inventory or source-version facts change

Steps:

1. Set `UPSTREAM=~/.cache/pi_config/pi-$(cat agent/vendor/pi/VERSION)/pi/examples/extensions/subagent` (run `./setup.sh` first if the cache is empty).
2. Diff each tracked file against upstream: `diff -u "$UPSTREAM/index.ts" agent/extensions/subagent/index.ts` (and the same for `agents.ts`). Reconcile **every** hunk against a patch-table row — the mechanical check will refuse the manifest regeneration otherwise. If a hunk isn't documented, either (a) adopt the upstream side, (b) add a patch-table row for it, or (c) drop the local edit.
3. **Explicit retain/drop decision** per row of the current patch table — note in the commit body which patches were retained, expanded, or retired (and why).
4. Adopt trivial upstream deltas (helper imports, string reflows, etc.) unless they conflict with a load-bearing local patch.
5. Update `agent/extensions/subagent/README.md`: new source pi version in the header, patch-table rows edited, retired rows removed.
6. **Regenerate the manifest:** `scripts/validate-subagent-drift.sh --regenerate` (must be the last edit — any subsequent source touch requires another regeneration).
7. Run `scripts/typecheck-extensions.sh`, `scripts/lint-extensions.sh`, and `scripts/validate.sh`.
8. Commit README, source, and manifest together; conventional-commits scope `subagent`; commit body cites source pi version + which patches were retained/dropped.
9. Run `/review` on the aggregate diff (draft-first).

#### The snapshot manifest — `agent/extensions/subagent/PATCH_MANIFEST.json`

A v2 JSON manifest keyed by `trackedFiles` (`index.ts`, `agents.ts`). Each entry stores `upstreamSha256` and `localSha256` (sha256 of each file's CR-normalised content — platform-stable, unlike the v1 hash of raw `diff -u` text, which differed between Apple/FreeBSD and GNU diff and made macOS-regenerated manifests fail the Linux CI check, #680), plus an informational hunk count and net-line count. The pinned pi version is stored at the top level and cross-checked against `agent/vendor/pi/VERSION` on every run; a v1 manifest is rejected with a regenerate hint.

Commands:

```sh
# Check (invoked automatically by scripts/validate.sh)
scripts/validate-subagent-drift.sh

# Regenerate after intentional source or README changes
scripts/validate-subagent-drift.sh --regenerate
```

Missing upstream cache is an ERROR, not a skip — fresh clones must run `./setup.sh` (or `scripts/lib/fetch-pi-binary.sh`) to populate `~/.cache/pi_config/pi-$(cat agent/vendor/pi/VERSION)/` before `validate.sh` can complete. Per `agent/rules/extension-type-check-and-lint.md`, environment unavailability for a required check is a validation error.

**Anti-pattern:** regenerating the manifest without also updating the patch table is a documented failure mode (#582 § design fan-out). Reviewers should reject any PR whose sole diff to `agent/extensions/subagent/` is a manifest hash bump.

### cocoindex-code: `agent/vendor/cocoindex-code/`

Unlike the release-asset vendors above, `cocoindex-code` (`ccc`) and its local embedding model are **not fetched by `setup.sh`** — they are installed out-of-band (`pipx install --python python3.13 'cocoindex-code[full]'`). This vendor surface is therefore a **verifiable pin record**, not a download manifest: `VERSION`, `CHECKSUMS` (embedding-model file digests), and a `README.md`. The runtime source of truth is [`agent/extensions/indexing/pin.ts`](../agent/extensions/indexing/pin.ts), and the two must stay in lockstep.

To bump the engine or model:

1. Install the target `ccc` into a scratch pipx venv and confirm the CLI surface (`ccc search`/`index`/`status`, fixed text output) is unchanged; the parser (`parse.ts`) is version-pinned and tolerant, but a format change needs a parser review.
2. Update `agent/vendor/cocoindex-code/VERSION` and the constants in `pin.ts` together — `PINNED_CCC_VERSION` (runtime-checked at `session_start`), `MIN_TRANSFORMERS_VERSION` (runtime CVE floor, also `session_start`), and `MODEL_REVISION` / `MODEL_SAFETENSORS_SHA256` (pin record).
3. Refresh `agent/vendor/cocoindex-code/CHECKSUMS` for the embedding-model files and update the README citations.
4. Run `scripts/validate-cocoindex-code-vendor.sh` (wired into `scripts/validate.sh`) and the indexing suite (`scripts/test-indexing.sh`).

Runtime re-verification of the *downloaded* model against `MODEL_REVISION` / the weights SHA is tracked in #821 — today those two are pin-record + validator-cited only.

## Validation matrix

| Surface | Asset/source verification | Targeted validation | Additional checks |
|---|---|---|---|
| `agent/vendor/pi/` | Attested `SHA256SUMS` from `gh release download "$NEW_TAG" --repo psmfd/pi` + `gh attestation verify` | `scripts/validate-pi-vendor.sh` | `scripts/lib/fetch-pi-binary.sh --self-test` + archive attestation verify; consider subagent re-pair |
| `agent/vendor/nvm/` | `curl -fsS -o /dev/null "https://raw.githubusercontent.com/nvm-sh/nvm/$NEW_TAG/install.sh"` | `scripts/validate-nvm-vendor.sh` | `scripts/lib/install-helpers.sh --self-test` |
| `agent/vendor/gh/` | `gh release view "$NEW_TAG" --repo cli/cli --json assets` | `scripts/validate-gh-vendor.sh` | `scripts/lib/install-helpers.sh --self-test` |
| `agent/vendor/yq/` | `gh release view "$NEW_TAG" --repo mikefarah/yq --json assets` | `scripts/validate-yq-vendor.sh` | `scripts/lib/install-helpers.sh --self-test`; confirm mikefarah/yq variant |
| `agent/vendor/shellcheck/` | `gh release view "$NEW_TAG" --repo koalaman/shellcheck --json assets` | `scripts/validate-shellcheck-vendor.sh` | `scripts/lib/install-helpers.sh --self-test`; run full validation for new lint findings |
| `agent/vendor/gitleaks/` | `gh release view "$NEW_TAG" --repo gitleaks/gitleaks --json assets` | `scripts/validate-gitleaks-vendor.sh` | `scripts/lib/install-helpers.sh --self-test`; run `scripts/scan-secrets.sh --history --all-refs` |
| `agent/extensions/subagent/` | Diff target pi `examples/extensions/subagent/` against local source | `scripts/typecheck-extensions.sh`; `scripts/lint-extensions.sh`; `scripts/validate-subagent-drift.sh` (diff-signature manifest, #582) | Review local patch table; regenerate manifest via `--regenerate`; run `/review` for source/runtime changes |

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
| Subagent extension re-pair | `agent/extensions/subagent/README.md`; `agent/extensions/subagent/PATCH_MANIFEST.json` (regenerate); `agent/extensions/README.md`; `agent/AGENTS.md` repo layout; pi-agent-expert wrapper, skill, and references |
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
