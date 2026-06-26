# ADR-0011 — Developer toolchain install strategy (hybrid vendor + distro, mikefarah/yq)

- **Status:** Accepted
- **Date:** 2026-05-20
- **Related:** [ADR-0009](0009-pi-runtime-acquisition-strategy.md) (pi runtime vendor pattern), [ADR-0010](0010-setup-install-trust-posture.md) (setup.sh active-install posture), #102, #107 (pi npm-path deprecation), #110

## Context

ADR-0010 established that `setup.sh` actively installs the dependencies pi_config requires. The first PR landing under that ADR (#113) covered the framework, nvm, Node.js 24.x, and the `PI_USE_VENDORED=1` opt-in for pi itself. The developer-toolchain deps — `gh`, `jq`, `yq`, `shellcheck`, `markdownlint-cli2`, `yamllint` — were carved out to follow-up issue #110 to keep the install-trust-path PR focused on the architecturally significant choices.

The toolchain surface is broader than nvm + pi: six tools with five distinct distribution channels, two of which (`gh`'s apt repo, `yq`'s name collision on Debian/Ubuntu) carry footguns of their own. ADR-0010 allowed OS package managers as accepted trust roots, but left "which channel for which tool" open to a follow-up ADR.

This ADR records that follow-up decision, the trust posture for each install channel, and — separately — the choice of upstream for `yq` (where three competing tools share the same name, and the wrong default is silently installed by `apt`).

## Considered options

**A. Vendor-pin every tool (sha256-verified github releases for all six).**
The strictest posture, parallel to `agent/vendor/pi/` and `agent/vendor/nvm/`. Eliminates trust in distro maintainers entirely. Cost: six new vendor directories, six platform-digest matrices, six bump procedures, ongoing maintenance burden. `jq` and `yamllint` in particular are well-maintained distro packages where vendor-pinning buys little.

**B. Distro packages for every tool (apt / dnf / brew everywhere).**
Simplest. Reuses existing OS trust roots. But: (1) the `gh` apt repo is not in the default sources list — adding it requires importing a GPG key, which is a trust transfer of its own; (2) `apt install yq` on Debian/Ubuntu installs the *wrong yq* (see § "Why mikefarah/yq specifically" below); (3) `markdownlint-cli2` is npm-distributed and has no useful distro package; (4) requires `sudo` on Linux for every install, which conflicts with the `PI_ALLOW_SUDO_*` opt-in gate established by #113.

**C. Hybrid: vendor-pin where the distro path is broken or absent; distro for the boring ones; npm for npm-native.** Vendor-pin `gh` (gpg-key trust transfer avoided, single static binary), `yq` (avoids the kislyuk/mikefarah collision structurally), `shellcheck` (single static binary, frequent vendor pinning in CI environments anyway). Distro for `jq` (universally packaged, every distro ships a compatible version, no name collision) and `yamllint` (Python tool, distro packages are fine, pipx fallback available). npm for `markdownlint-cli2` (npm-native, no other reasonable channel, and nvm-managed npm needs no sudo). Gate any sudo-requiring branch behind explicit opt-in (`PI_ALLOW_SUDO_APT=1`, `PI_ALLOW_SUDO_DNF=1`) for parity with the `PI_ALLOW_SUDO_NPM=1` gate from #113. brew rejects sudo by design — no gate needed there.

**D. Document required deps; do not install.** The pre-#102 posture. Already rejected by ADR-0010. Listed here only for completeness.

## Decision outcome

**Chosen: Option C — hybrid.**

| Tool | Channel | Trust root | Sudo required? |
|---|---|---|---|
| `gh` | Vendor pin (github.com/cli/cli releases) | `agent/vendor/gh/CHECKSUMS` (sha256) | No |
| `yq` (mikefarah) | Vendor pin (github.com/mikefarah/yq releases) | `agent/vendor/yq/CHECKSUMS` (sha256) | No |
| `shellcheck` | Vendor pin (github.com/koalaman/shellcheck releases) | `agent/vendor/shellcheck/CHECKSUMS` (sha256) | No |
| `jq` | Distro (`apt` / `dnf` / `brew install jq`) | OS package maintainer | Yes on Linux (gated `PI_ALLOW_SUDO_APT=1` / `PI_ALLOW_SUDO_DNF=1`) |
| `yamllint` | Distro (`apt` / `dnf` / `brew install yamllint`); `pipx install yamllint` fallback | OS package maintainer / PyPI | Yes on Linux (gated); pipx path is per-user |
| `markdownlint-cli2` | `npm install -g markdownlint-cli2` via nvm-managed npm | npm registry | No (nvm-managed npm prefix is user-owned) |

Each install is wired through `scripts/lib/install-helpers.sh` as a discrete `ih_ensure_<tool>` function, idempotent (`SKIP` if `command -v <tool>` succeeds), `--dry-run`-aware via `ih_run`, and `script-output-conventions.md`-compliant.

### Opt-out granularity

Three knobs, in precedence order (any one of which short-circuits the corresponding install phase):

| Variable | Effect |
|---|---|
| `PI_CONFIG_SKIP_DEPS=1` | Umbrella — skip every install phase. Preserves the #113 contract. |
| `PI_CONFIG_SKIP_NVM=1` | Skip only the nvm + Node.js phase. |
| `PI_CONFIG_SKIP_TOOLCHAIN=1` | Skip only the toolchain phase introduced by this ADR. |

Per-tool opt-outs (`PI_CONFIG_SKIP_GH=1`, etc.) are *not* introduced — the per-tool envvar surface explodes quickly and there is no concrete use case yet. If one materializes, add it then; this ADR explicitly does not foreclose that.

## Tradeoffs

### Good

- Vendored tools work identically on every supported platform. No "works on my Mac, breaks in CI" yq-variant surprises.
- Vendor pins are sha256-verified against in-repo CHECKSUMS files; bumps require named-reviewer approval via CODEOWNERS (parallel to `agent/vendor/pi/` and `agent/vendor/nvm/`).
- `gh` is acquired without trusting (or persisting) a third-party apt-source GPG key on every developer's machine.
- `jq` and `yamllint` reuse the well-maintained distro packaging — we don't take on bump burden for tools where the distro path is fine.
- `markdownlint-cli2` via nvm-managed npm needs no sudo, no system-wide install, and tracks the user's chosen Node version automatically.

### Bad

- Three new vendor directories (`gh`, `yq`, `shellcheck`) each with their own bump procedure. Three more PR-touch surfaces requiring CODEOWNERS review.
- The bump burden grows linearly with each vendored tool. ADR-0010's "single nvm pin" simplicity is gone here by necessity.
- Hybrid policies are harder to explain than uniform ones. A new contributor has to learn the per-tool channel from the table above rather than infer "everything is vendored" or "everything is distro."
- `jq` and `yamllint` install paths still require sudo on Linux. The `PI_ALLOW_SUDO_APT` / `PI_ALLOW_SUDO_DNF` gates mean fresh-box dry-runs will print "would require PI_ALLOW_SUDO_APT=1" warnings rather than just running — a small UX cost for the principled posture.

## Why mikefarah/yq specifically

Three tools all named `yq` exist in the wild. The "default" one depends on which package manager you ask:

| | **mikefarah/yq** | **kislyuk/yq** | **python-yq (PyPI)** |
|---|---|---|---|
| **Language** | Go (single static binary) | Python wrapper around `jq` | Same as kislyuk (renamed) |
| **Syntax** | Native YAML path DSL, similar to jq but not identical (`.foo.bar`, `.items[]`) | Pure jq syntax — converts YAML→JSON, pipes through `jq`, optionally converts back | Same as kislyuk |
| **Distribution** | GitHub releases, brew, snap, scoop | pip / pipx, `apt install yq` on Debian/Ubuntu installs **this one** | pip |
| **Requires** | nothing | `jq` + python | `jq` + python |
| **In-place edit (`-i`)** | Yes | No (read-only by design) | No |
| **YAML output** | Native | Via `--yaml-output` flag | Same |
| **Performance** | Fast (static binary, no interpreter startup) | Slower (python startup + jq subprocess) | Same as kislyuk |
| **Comment preservation** | Preserves comments, anchors, quoting style (mostly) | Loses comments (YAML→JSON→YAML roundtrip) | Same |

Rationale for mikefarah:

1. **Cross-platform consistency.** `apt install yq` on Ubuntu/Debian installs kislyuk; `brew install yq` on macOS installs mikefarah. Without an explicit pin, contributors on the two platforms run *different tools with the same name* and trip over divergent syntax in code review. Vendor-pinning mikefarah closes this hazard structurally.
2. **Idiomatic for our use cases.** The skill content under `agent/skills/{helm,vcluster,ansible}/` already implicitly assumes mikefarah syntax — example commands like `yq '.spec.template.spec.containers[0].image'` and `yq -i '.metadata.labels.foo = "bar"' file.yaml` are mikefarah-flavored.
3. **In-place mutation.** Several plausible setup-script and validator use cases want `yq -i` (in-place patching of YAML config). kislyuk does not support this — it is read-only by design.
4. **Single static binary, no runtime deps.** Fits the vendor-pin model cleanly. kislyuk would force us to also manage Python and `jq` versions and worry about Python venv hygiene.
5. **Industry default for ops tooling (2024+).** Most Helm/k8s/CI documentation assumes mikefarah; kislyuk is increasingly a legacy oddity confined to a few Debian-specific environments.

The only argument for kislyuk is "if you already know jq perfectly, the syntax is free." Everyone on this project who would touch YAML manipulation either already knows mikefarah's syntax or will the moment they read a Helm doc. Accepted cost.

## Relationship to prior decisions

| ADR | Relationship |
|---|---|
| [ADR-0009](0009-pi-runtime-acquisition-strategy.md) | Same vendor pattern (`VERSION` + `CHECKSUMS` + `README.md` per tool, sha256-mandatory verify, structural validator wired into `scripts/validate.sh`, CODEOWNERS gating). This ADR adds three more vendor directories following that pattern verbatim. |
| [ADR-0010](0010-setup-install-trust-posture.md) | Direct continuation. ADR-0010 § Decision left toolchain channel selection as a follow-up; this ADR closes it. The `PI_ALLOW_SUDO_*` gating pattern (sudo opt-in, off by default) is reused from #113's `PI_ALLOW_SUDO_NPM=1`. |
| [ADR-0001](0001-subagent-orchestration-substrate.md) | Indirectly: the toolchain installed here is what the subagent specialists shell out to (gh-cli-expert uses `gh`, linter uses `shellcheck` + `markdownlint-cli2` + `yamllint`, several specialists use `jq`/`yq`). Without this install path, fresh-box `pi` sessions cannot route to those specialists usefully. |

## Implementation

Landed in #110 (this branch). Surfaces touched:

- `adrs/0011-toolchain-install-strategy.md` (this file).
- `agent/vendor/gh/{VERSION,CHECKSUMS,README.md}` — pinned to `v2.92.0`, four platform digests (linux-x64/-arm64, darwin-x64/-arm64).
- `agent/vendor/yq/{VERSION,CHECKSUMS,README.md}` — pinned to `v4.53.2` (mikefarah), four platform digests.
- `agent/vendor/shellcheck/{VERSION,CHECKSUMS,README.md}` — pinned to `v0.11.0`, four platform digests.
- `scripts/validate-{gh,yq,shellcheck}-vendor.sh` — network-free structural validators, wired into `scripts/validate.sh` §6.
- `scripts/lib/install-helpers.sh` — extended with `ih_ensure_{gh,yq,shellcheck,jq,yamllint,markdownlint_cli2}` functions and a `_ih_vendor_fetch_extract` shared internal helper for the three sha256-pinned tools.
- `setup.sh` — new §1b toolchain phase between the existing §1 (node) and §2 (pi), gated on `PI_CONFIG_SKIP_TOOLCHAIN` (and the umbrella `PI_CONFIG_SKIP_DEPS`). Existing §1 (node) gated independently on `PI_CONFIG_SKIP_NVM`. Header comment + `--help` enumerate the four new env vars (`PI_CONFIG_SKIP_NVM`, `PI_CONFIG_SKIP_TOOLCHAIN`, `PI_ALLOW_SUDO_APT`, `PI_ALLOW_SUDO_DNF`).
- `CODEOWNERS` — `/agent/vendor/{gh,yq,shellcheck}/{VERSION,CHECKSUMS}` added.
- `README.md` "Setup on a new machine" — table of flags / env vars extended; new dependencies section calls out vendor-vs-distro split.
- `agent/AGENTS.md` — repo-layout tree extended with three new vendor dirs and three new validators.

## More information

- mikefarah/yq: <https://github.com/mikefarah/yq>
- kislyuk/yq (the *other* yq): <https://github.com/kislyuk/yq>
- gh release process and asset naming: <https://github.com/cli/cli/releases>
- shellcheck release process: <https://github.com/koalaman/shellcheck/releases>
- markdownlint-cli2 npm page: <https://www.npmjs.com/package/markdownlint-cli2>
