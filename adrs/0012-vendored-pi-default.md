# ADR-0012: pi default install path flipped to vendored binary; npm preserved as opt-out

**Status:** Accepted
**Date:** 2026-05-20
**Supersedes (in part):** [ADR-0010](0010-setup-install-trust-posture.md) § "Pi acquisition" — the dual-path opt-in posture (npm default, vendored opt-in) is replaced by the inverse (vendored default, npm opt-out).
**Builds on:** [ADR-0009](0009-pi-runtime-acquisition-strategy.md) (the `fetch_pi_binary()` mechanism this ADR makes the default consumer of).
**Tracking issue:** [#107](https://github.com/TheSemicolon/pi_config/issues/107).

## Context and Problem Statement

ADR-0010 landed `setup.sh`'s install-trust posture with the pi-acquisition surface split across two branches:

- **Default branch** — `npm install -g @earendil-works/pi-coding-agent`. Inherits npm's trust model (no in-repo pinning, no sha256 verification, registry-mediated dependency tree).
- **Opt-in branch** — `PI_USE_VENDORED=1` invokes `fetch_pi_binary()` (ADR-0009) which downloads the GitHub release-asset pinned in `agent/vendor/pi/VERSION`, sha256-verifies it against `agent/vendor/pi/CHECKSUMS`, and symlinks it into `~/.local/bin/pi`.

ADR-0010 deferred the flip ("the deprecation target tracked in #107") on the basis that the vendored path needed real-world validation before becoming the default everyone hits. The original criteria were:

- ≥1 non-author install verified end-to-end on a clean machine, and
- per-triple validation across `linux/x64`, `linux/arm64`, `darwin/arm64`, `darwin/x64`.

Three evidence channels have accumulated since ADR-0010 landed:

1. **Per-PR CI smoke** ([#111](https://github.com/TheSemicolon/pi_config/issues/111) → `.github/workflows/setup-smoke.yml`) exercises `PI_USE_VENDORED=1 ./setup.sh` on `ubuntu-latest` + `macos-latest` on every PR that touches install surfaces. The current `macos-latest` runner image is Apple Silicon (since `macos-14`), so this covers `linux/x64` and `darwin/arm64`. The `darwin/x64` triple would require pinning a `macos-13` runner; the `linux/arm64` triple has no hosted-runner option on the free tier. Triggers on every install-surface PR plus weekly cron (Monday 12:00 UTC).
2. **Weekly cron** of the same workflow surfaces drift from upstream GitHub release-asset availability changes independently of PR activity.
3. **The summary-line CI assertion** added in #112 / PR #117 (`^(PASS|FAIL) — [0-9]+ errors, [0-9]+ warnings$`) provides a stronger end-to-end-completion signal than the previous "phase marker matched" greps — it caught a latent §4 abort the day it was added.

The arm64 triples remain partially CI-uncovered: `linux/arm64` has no hosted runner; `darwin/arm64` *is* covered by the current `macos-latest` runner image but the original ADR-0010 criteria predate that image change and were never updated. `fetch_pi_binary()` (ADR-0009) does host-arch detection per `uname -m` and selects the corresponding release-asset, so the code path is uniform across triples; the residual gap is `linux/arm64` — "no automated assertion that the asset actually exists and runs on that triple" rather than "no implementation".

## Considered Options

- **Option A — Status quo (npm default, vendored opt-in).** Keep deferring the flip until all four triples have automated coverage. Indefinite — GHA does not currently offer hosted arm64 Linux runners on the free tier; `darwin/arm64` is the *default* `macos-latest` runner (so it's actually already covered), but the original ADR-0010 criteria predate that runner-image change.
- **Option B — Flip default; remove npm path entirely.** Maximum posture consistency: every install hits the sha256-pinned path. Cost: any user behind a network that proxies `npmjs.org` but blocks `github.com` release-asset downloads, or any user who prefers npm-managed updates (`npm update -g`), loses their path. The npm path has been working since before pi_config existed; there is no operational reason to delete it.
- **Option C — Flip default; keep npm path indefinitely as `PI_USE_VENDORED=0` opt-out** (chosen). Default-flip happens; legacy path stays available with no scheduled removal.
- **Option D — Flip default; schedule npm-path removal in N weeks.** Compromise between B and C. Adds a calendar dependency to the setup surface and forces a follow-up issue/PR for the removal. C dominates D when there is no operational driver for removal.

## Decision Outcome

Chosen option: **C — flip default to vendored; keep npm path indefinitely as `PI_USE_VENDORED=0` opt-out**.

### What changes

- `setup.sh` §2 default branch becomes the vendored path:

  ```sh
  if [ "${PI_USE_VENDORED:-1}" != "0" ]; then
      # vendored binary path (ADR-0009): sha256-verified release-asset
      # symlinked into ~/.local/bin/pi
  else
      # legacy npm install -g @earendil-works/pi-coding-agent
  fi
  ```

- `PI_USE_VENDORED=0` is now the explicit opt-out to the legacy npm flow. Any other value (or unset) selects the default vendored path.
- The npm branch emits an `INFO  PI_USE_VENDORED=0 — using legacy npm install path (vendored is default; see ADR-0012)` line on entry — visible, not alarming, no deprecation timer.
- The `die` message inside the npm branch's permission-failure path inverts its suggestion: instead of "set `PI_USE_VENDORED=1` to use the vendored path", it now reads "(recommended) unset `PI_USE_VENDORED` (or set it to `1`) to use the default vendored binary path".
- `setup-smoke.yml` keeps its explicit `PI_USE_VENDORED: '1'` setting (now a redundant explicit-default, retained for self-documenting workflow YAML) and adds a separate ubuntu-only `smoke-npm-optout` job that exercises `PI_USE_VENDORED=0 ./setup.sh --dry-run` to keep the opt-out path from bit-rotting.

### What does *not* change

- The npm branch logic, `PI_ALLOW_SUDO_NPM`, `PI_UPDATE`, and every other npm-path env-var stay intact.
- The vendored path's mechanics (ADR-0009, `fetch_pi_binary()`, sha256 verification, the `agent/vendor/pi/` triple) are unchanged.
- No removal of the npm branch is scheduled. Future removal (if ever) requires a fresh issue + ADR.

## Tradeoffs

### Good

- **Install-trust posture is now uniform for the default path.** Every default `./setup.sh` invocation goes through sha256-verified release-asset fetch. This brings pi acquisition into parity with the nvm + toolchain channels (which have been sha256-pinned since ADR-0010 / ADR-0011).
- **Opt-out preserved indefinitely.** Users behind corporate networks that proxy `npmjs.org` but block `github.com` release assets, or users who prefer npm-managed `pi` for any reason (auto-update semantics, registry-side trust model, etc.), keep an officially-supported install path with a one-env-var toggle.
- **Instant rollback.** If a user hits any defect in the vendored path, `PI_USE_VENDORED=0 ./setup.sh` restores the previous behavior with zero code changes on their end.
- **Smoke harness exercises both paths.** The new `smoke-npm-optout` ubuntu-only job means the opt-out path gets a per-PR + weekly-cron correctness signal too. Without that job, the opt-out would be a "supported but untested" claim — exactly the failure mode this ADR is trying to avoid.

### Bad

- **arm64 triples remain partially CI-uncovered.** `linux/arm64` is uncovered (no hosted runner); `darwin/arm64` *is* covered by current `macos-latest` runners but that fact post-dates ADR-0010 and is not externally verified by a non-author. Mitigation: `fetch_pi_binary()` does per-host arch detection and fails loud on checksum mismatch (`_fpb_lookup_checksum` returns nonzero with an `ERROR` line if no row is present for the detected triple — no silent-success path); the npm opt-out is available as a one-toggle workaround if any arm64 user hits a regression.
- **Two install paths to maintain.** The cost of preserving an opt-out is real — every future change to the install surface has to consider both branches. Mitigated by: the branches are short and well-isolated; the smoke harness now covers both; the npm branch has been operationally stable for years.
- **The default-flip is a user-visible behavior change.** Anyone who runs `./setup.sh` on the day this lands gets a different install mechanism than the day before. Mitigation: the change is announced in the next CHANGELOG entry (per #99's discipline note); the resulting `pi` binary is byte-identical content from a different acquisition path, so end-user behavior is unaffected.

## Relationship to prior decisions

| ADR | Relationship |
|---|---|
| [ADR-0009](0009-pi-runtime-acquisition-strategy.md) | This ADR makes the ADR-0009 mechanism the default consumer. ADR-0009's status line is updated to reflect "consumption live as default" rather than "consumption live behind `PI_USE_VENDORED=1`". |
| [ADR-0010](0010-setup-install-trust-posture.md) | **Supersedes in part:** the § "Pi acquisition" section of ADR-0010 described the dual-path opt-in posture (npm default, vendored opt-in). That posture is inverted by this ADR. The rest of ADR-0010 (installer-vs-validator posture shift, nvm-mandatory node management, `PI_CONFIG_SKIP_DEPS` semantics) is unaffected. Per `rules/adr-required.md`, supersession is by addition rather than edit; ADR-0010 carries a top-of-section pointer to this ADR. |
| [ADR-0011](0011-toolchain-install-strategy.md) | Orthogonal. ADR-0011's hybrid vendor + distro + npm toolchain channels are untouched. |

## Implementation

- `setup.sh` — invert §2 conditional; update env-var help comment, header comment, inline section comment, `WARN  [pi]` SKIP_DEPS-conflict message, vendored-path entry `INFO` line, npm-path `die` message, and the §2 header comment block. Add an entry `INFO` line on the npm branch. (Eight edits in one block; line count change ~ +20.)
- `.github/workflows/setup-smoke.yml` — comment update on the existing `PI_USE_VENDORED: '1'` env-var (now redundant explicit-default); add a `smoke-npm-optout` ubuntu-only job exercising `PI_USE_VENDORED=0 ./setup.sh --dry-run`.
- `README.md` — flip the §2 setup-section text, rewrite the `PI_USE_VENDORED` row of the env-var table to describe the opt-out, drop `PI_USE_VENDORED=1` from the dry-run example, add ADR-0012 to the Architecture Decisions list.
- `adrs/0009-pi-runtime-acquisition-strategy.md` — status line update; § Consequences line update.
- `adrs/0010-setup-install-trust-posture.md` — top-line "partially superseded by ADR-0012" note; § Pi acquisition opens with a supersession callout; "More Information" footnote updated.
- `adrs/0012-vendored-pi-default.md` — this file.

## More Information

- Tracking issue: [#107](https://github.com/TheSemicolon/pi_config/issues/107) (auto-closes on merge).
- Evidence channel #1: PR #115 (smoke harness), `.github/workflows/setup-smoke.yml`.
- Evidence channel #2: weekly cron, same workflow.
- Evidence channel #3: PR #117 / #112 (summary-line CI assertion).
- Out of scope: removal of the npm branch (not scheduled); a hypothetical future `PI_USE_NPM=1` alias (would be a redundant way to express `PI_USE_VENDORED=0`); `linux/arm64` CI coverage (blocked on GHA runner availability).
