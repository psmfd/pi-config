# ADR-0010: setup.sh install-trust posture and nvm-mandatory node management

**Status:** Accepted; **§ Pi acquisition partially superseded by [ADR-0012](0012-vendored-pi-default.md)** (default flipped from npm to vendored; npm preserved indefinitely as the `PI_USE_VENDORED=0` opt-out)
**Date:** 2026-05-19
**Related:** [ADR-0009](0009-pi-runtime-acquisition-strategy.md) (pi runtime acquisition — consumed by this ADR's `PI_USE_VENDORED` path); [ADR-0001](0001-subagent-orchestration-substrate.md) (vendored-substrate stance — this ADR extends the same posture to the install path)

## Context and Problem Statement

`setup.sh` today is a **check-and-die** script: it verifies node + npm are present, errors out if not, then runs `npm install -g @earendil-works/pi-coding-agent` and symlinks `~/.pi → $REPO_DIR`. Fresh-machine bootstrap requires the operator to hand-install Node first; the script gives no help with that.

Issue [#102](https://github.com/TheSemicolon/pi_config/issues/102) calls for `setup.sh` to actively install everything pi_config requires, in an idempotent way, so a fresh box only needs `git` + the script. The dependency surface (curated during planning) is:

- `nvm` + Node.js 24.x (mandatory; no distro-package fallback)
- `pi` (already handled; the [ADR-0009](0009-pi-runtime-acquisition-strategy.md) `PI_USE_VENDORED=1` opt-in path is now wired)
- `gh`, `jq`, `yq`
- `shellcheck`, `markdownlint-cli2`, `yamllint`

Three architectural choices in this surface warrant explicit decision-record treatment rather than being buried in commit messages:

1. **Posture shift from check-and-die to actively-install.** This moves `setup.sh` from "validator" to "installer" — a meaningfully different trust posture. Every install call is a write to the host's package surface.
2. **nvm is the mandatory node manager.** No distro packages (`apt install nodejs`), no `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -`, no Homebrew `node@24`. The matrix of "which node ended up where" across Linux distros is the largest single source of "works on my machine" failures in node tooling; nvm is the one path that produces a uniform, per-user, version-pinned runtime.
3. **Opt-out must be preserved.** Power users who manage their own toolchain (Homebrew, asdf, mise, system-curated) need an escape hatch that doesn't require them to fork the script. `PI_CONFIG_SKIP_DEPS=1` short-circuits the install phase back to today's check-and-die behavior.

The dependency-installer surface itself reuses the `scripts/lib/` substrate established by ADR-0009 (`scripts/lib/fetch-pi-binary.sh`): sourceable POSIX-bash libraries with `--self-test` modes and a standardized output convention, exercised both by `setup.sh` and by the structural validators wired into `scripts/validate.sh`.

## Considered Options

- **Option A — Status quo (check-and-die).** Leave `setup.sh` as a validator; document hand-install steps in `README.md`. Reproducibility cost: every fresh-box bootstrap is a manual procedure that drifts as upstream packagers reshuffle their repositories.
- **Option B — Active installer, distro-package node.** Use `apt install nodejs npm` / `dnf install nodejs npm` / `brew install node`. Defeats the entire reason for installing Node in the first place: distros ship outdated and inconsistently-versioned Node, and pi requires a specific runtime profile.
- **Option C — Active installer, curl-bash-NodeSource for node.** `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -`. Better version control than B, but adds a sudo-required transitive trust dependency on a vendor (NodeSource) we don't otherwise interact with, and produces a system-wide Node that conflicts with user-installed node managers.
- **Option D — Active installer, nvm-mandatory node** (chosen). nvm install pinned by tag, sha256-verified against an in-repo `agent/vendor/nvm/CHECKSUMS` (parallel to the ADR-0009 pi pin). Node 24.x via `nvm install 24`. Per-user, no sudo, idempotent. Coexists with any other node manager the user has — nvm's shell-hook mechanism means it only takes effect when explicitly activated.

## Decision Outcome

Chosen option: **D — active installer, nvm-mandatory node, with opt-out and dry-run**.

### Posture

- `setup.sh` becomes the canonical "fresh-box bootstrap" entry point. Default invocation (`./setup.sh`) **mutates the host's package surface** by installing missing dependencies. This is a deliberate shift from the historical check-and-die behavior.
- Every install command is **printed before execution** (via the `ih_run` helper). `--dry-run` prints without executing. The operator can always see what is about to change.
- `PI_CONFIG_SKIP_DEPS=1` reverts the install phase to today's check-and-warn behavior. Power users keep their existing toolchain workflow.

### Node management

- nvm is **mandatory**. No fallback to distro-packaged Node, NodeSource curl-to-bash, or Homebrew `node@N`.
- The nvm installer (`https://raw.githubusercontent.com/nvm-sh/nvm/v<tag>/install.sh`) is pinned by tag, fetched once, sha256-verified against `agent/vendor/nvm/CHECKSUMS`, then executed. The bump procedure for the nvm pin parallels the ADR-0009 procedure for the pi pin.
- Node 24.x is the required runtime (the pinned major). `nvm install 24 && nvm use 24` runs unconditionally; `nvm alias default 24` is gated on `PI_CONFIG_SET_DEFAULT_NODE=1` to avoid silently mutating a user who has another version pinned as their global default.

### Pi acquisition

> **Superseded in part by [ADR-0012](0012-vendored-pi-default.md).** The dual-path opt-in posture described in this section was flipped once the smoke harness ([#111](https://github.com/TheSemicolon/pi_config/issues/111)) + weekly cron accumulated green signal. The vendored path is now the default; the npm path is preserved indefinitely as the explicit `PI_USE_VENDORED=0` opt-out. The original text below is retained for historical context.

- Default branch preserves today's `npm install -g @earendil-works/pi-coding-agent`. This is the deprecation-target path tracked in [#107](https://github.com/TheSemicolon/pi_config/issues/107).
- `PI_USE_VENDORED=1` branch sources `scripts/lib/fetch-pi-binary.sh` (ADR-0009), invokes `fetch_pi_binary()`, and symlinks the returned binary path into `~/.local/bin/pi`. Both branches honor `--dry-run`.
- The flip — making `PI_USE_VENDORED=1` the default and deprecating the npm path — happens in #107 after ≥1 non-author validation on a fresh box.

### Toolchain dependencies

- `gh`, `jq`, `yq`, `shellcheck`, `markdownlint-cli2`, `yamllint` are installed in a follow-up PR ([#110](https://github.com/TheSemicolon/pi_config/issues/110)) that reuses the framework landed under this ADR. Carving them out keeps the install-trust-path PR small and focused.

## Tradeoffs

### Good

- **Fresh-machine bootstrap is one command.** `git clone && ./setup.sh` produces a working install with Node 24.x active. The historical "install Node first, then run me" prerequisite is gone.
- **Reproducible Node runtime across hosts.** Every install ends up with the same nvm-managed Node 24, regardless of host distro or pre-existing node-manager choices.
- **Opt-out preserved.** Power users set `PI_CONFIG_SKIP_DEPS=1` once in their shell rc and the script behaves as it does today.
- **Visible side effects.** `--dry-run` + the print-before-execute pattern via `ih_run` mean nothing surprising can happen.
- **Reuses the ADR-0009 substrate.** New code lives in `scripts/lib/` alongside `fetch-pi-binary.sh`; the structural validator pattern is the same.

### Bad

- **`setup.sh` now writes to the host's package surface by default.** Operators who run it casually may be surprised. Mitigated by `--dry-run` and the print-before-execute pattern but not eliminated.
- **The nvm pin becomes a maintenance surface.** A second `agent/vendor/<thing>/{VERSION,CHECKSUMS,README.md}` triple to keep current. Mitigated by reusing ADR-0009's bump procedure verbatim.
- **The nvm curl-to-bash install path is the single weakest link.** sha256 verification gates the script execution, but if the pinned installer ever turns out to have a defect, every operator who runs `setup.sh` ships that defect. Same threat model as the ADR-0009 pi binary pin; same mitigation (CODEOWNERS on the CHECKSUMS file, branch protection on bump PRs).

## Relationship to prior decisions

| ADR | Relationship |
|---|---|
| [ADR-0001](0001-subagent-orchestration-substrate.md) | Same vendored-substrate stance applied to the install path: where ADR-0001 vendors a pi *extension* we patch, this ADR pins a *runtime* and a *bootstrap installer* we fetch. Parallel decision; not superseded. |
| [ADR-0009](0009-pi-runtime-acquisition-strategy.md) | Provides the `fetch_pi_binary()` library this ADR wires behind `PI_USE_VENDORED=1`. ADR-0009 ships the mechanism; this ADR ships the consumer. ADR-0009 will be updated in this same PR to record that its consumption is now live. |

## Implementation

- `scripts/lib/platform-detect.sh` — sourceable POSIX-bash; detects host OS / distro / package manager. `--self-test` mode for the bump procedure.
- `scripts/lib/install-helpers.sh` — sourceable POSIX-bash; provides `ih_dry_run`, `ih_run`, `ih_have_cmd`, `ih_ensure_nvm`, `ih_ensure_node`. `--self-test` mode exercises the helpers in dry-run.
- `agent/vendor/nvm/{VERSION,CHECKSUMS,README.md}` — nvm installer pin, parallel layout to `agent/vendor/pi/`.
- `scripts/validate-nvm-vendor.sh` — network-free structural validator wired into `scripts/validate.sh`.
- `setup.sh` — `--dry-run` flag, `PI_CONFIG_SKIP_DEPS` and `PI_USE_VENDORED` env-var handling, §1 rewritten to call `ih_ensure_nvm` + `ih_ensure_node 24`, §2 gains the `PI_USE_VENDORED` branch.

## More Information

- Tracking issue: [#102](https://github.com/TheSemicolon/pi_config/issues/102).
- Follow-ups: [#110](https://github.com/TheSemicolon/pi_config/issues/110) (toolchain deps), [#111](https://github.com/TheSemicolon/pi_config/issues/111) (CI smoke), [#112](https://github.com/TheSemicolon/pi_config/issues/112) (output-conventions refactor).
- The pi deprecation path (flipping `PI_USE_VENDORED=1` to default) was completed in #107 / [ADR-0012](0012-vendored-pi-default.md). The npm path is preserved indefinitely as `PI_USE_VENDORED=0`.
