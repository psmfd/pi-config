---
status: Accepted
date: 2026-07-09
---

# ADR-0086: Consumer update mechanism — on-demand `update.sh` + release-tag default ref

**Status:** Accepted
**Date:** 2026-07-09
**Related:** [ADR-0051](0051-sendable-one-shot-installer.md) (the `install.sh` this extends; fulfils its explicitly-deferred release-tag-pinning item), [ADR-0075](0075-per-extension-install-pins.md) (per-extension pins travel as `install.sh` content), [ADR-0069](0069-ext-ref-pin-drift-automation.md) (the drift automation that keeps those pins current; source of the accepted pin-lag), [ADR-0066](0066-ci-release-automation.md) (the automation that cuts the mirror release tags this tracks), [ADR-0055](0055-automated-mirror-releases.md) (mirror annotated-tag + Release creation), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) / [ADR-0040](0040-consume-psmfd-attested-pi-releases.md) (the pi-binary integrity chain the config channel does not yet match — #627), [ADR-0046](0046-psmfd-pi-main-ruleset-migration.md) & the no-mcp-servers rule (the network-content-into-context prohibition that rules out a fetch-hook update check)

## Context and Problem Statement

The original distribution goal (ADR-0051) delivered a one-shot `install.sh` that
takes a recipient from nothing to a working install. It has no counterpart for
the *second* time: a consumer who installed weeks ago has no easy, safe way to
move to a newer release.

Two facts make this now both possible and specific:

1. **The mirror cuts releases.** ADR-0051 deferred release-tag pinning "until the
   mirror cuts releases." That condition is met — `psmfd/pi-config` carries
   annotated release tags `v1.3.0` … `v1.18.0`, each with a GitHub Release
   (ADR-0066). `install.sh` still hardcodes `REF="main"` with a stale comment
   flagging exactly this deferral.
2. **An update here is high-consequence.** `setup.sh` symlinks `~/.pi` to the
   clone and its extensions run **in-process** inside the pi harness — hooks fire
   on every tool call, extensions can shell out. An update to this repo is an
   update to code the harness executes at its own privilege. That is closer to
   updating a browser extension with full DOM access than to a leaf-library bump.

The problem: provide an *easy* consumer update path without weakening the
operator-visible, fail-closed, review-gated trust posture the project applies to
every other privileged surface (pi-binary acquisition, dependency install, mirror
sync, release promotion).

The naive answers fail:

- **"Re-run your saved `install.sh`."** A consumer's standalone copy has the
  `EXT_MIRRORS` pins (ADR-0075) baked in at download time. The running process
  parses that array *before* it git-updates the clone, so it re-installs stale
  extension versions. Broken.
- **A standalone `update.sh` that reimplements clone/setup/`pi install`.**
  Duplicates the tested logic in `install.sh` and drifts against it (including the
  nvm/npm-PATH mitigation for #557).
- **A fully-automatic / background update.** Collapses the "PR is the review
  surface" control into an unattended write to `~/.pi` that activates on the next
  session — the compromise lands before the operator can notice.
- **A session-start hook that checks GitHub and surfaces "update available."**
  If it emits fetched release-notes text into hook stdout / `additionalContext`,
  it is the exact network-content-into-context vector ADR-0046 / no-mcp-servers
  prohibit.

## Considered Options

| Option | Verdict |
|---|---|
| **A — Thin `update.sh` trampoline in the clone that git-updates, then `exec`s the freshly-reset `install.sh`** | **Chosen.** Solves the stale-pin problem for free (the re-exec'd installer is the updated one), sidesteps the self-modifying-script hazard (`exec` into a *different* file after the reset), and duplicates zero clone/setup logic — `install.sh` stays the single source of truth and the trampoline inherits its nvm/npm mitigation. |
| B — Document "re-run install.sh" | Rejected — stale baked-in `EXT_MIRRORS` pins (above). |
| C — Standalone `update.sh` reimplementing the install logic | Rejected — duplicate-maintenance and drift against `install.sh`. |
| D — Fully-automatic / background update | Rejected — unreviewed in-process code execution; collapses the project's review-gated posture. |
| E — Session-hook update check that surfaces fetched release text | Rejected — network-content-into-context prohibition (ADR-0046, no-mcp-servers). A local, structural version compare printing a static message is permitted; a remote-authored string entering a session is not. |

## Decision Outcome

**Chosen: option A**, an on-demand `update.sh` trampoline shipped in the mirror
clone, plus flipping `install.sh`'s default ref to the latest release tag.

1. **`update.sh` (repo root, shipped in the clone via `mirror/targets.yml`).**
   Resolves the target ref (latest `v*` release tag by default via
   `git ls-remote --tags --refs` + the repo's `ver_gt` — never `sort -V`, which
   is absent/mis-sorting on BSD; `--ref vX.Y.Z` overrides for rollback), runs
   two fail-closed guards, does a full (non-shallow) `fetch` + `reset --hard`,
   then `exec "${DIR}/install.sh"`.
   - **Anti-downgrade guard:** refuse to move to a SemVer-lower version unless the
     user explicitly passed `--ref` (that *is* the rollback path). Fail closed on
     an unparseable target version. A compromised mirror cannot silently force a
     consumer backward to a previously-patched revision.
   - **Dirty-tree guard:** abort (with a `--force` override) if tracked files have
     local modifications, tested via `git diff --quiet HEAD --` / `--cached` (not
     `status --porcelain`, which over-reports untracked files that `reset --hard`
     never touches). Gitignored live config (`agent/settings.json`,
     `models.json`) survives `reset --hard` by construction.
   - **`--check` mode:** prints installed-vs-latest + the release URL, mutates
     nothing. Purely local structural compare; the surfaced version name is
     regex-validated (`^v[0-9]+\.[0-9]+\.[0-9]+$`) before interpolation. No
     release-notes prose is ever printed.
2. **`install.sh` default ref flips from `main` to the latest release tag**,
   resolved at runtime (inline minimal `ver_gt`, lockstep-commented against
   `scripts/lib/semver-classify.sh` — `install.sh` is standalone and cannot
   source the lib). Resolution failure fails closed with a message to pass
   `--ref main` explicitly. `--ref` remains available for `main`/branch/older-tag.
3. **`update.sh` is added to `mirror/targets.yml`'s `pi-config` `sources:`** (or
   it never ships) and to `validate.sh`'s shellcheck target list.

Extension version coherence rides ADR-0075 unchanged: pins are tracked content, so
the tag the consumer updates to carries the pins current at that release's cut
time; the re-exec'd `install.sh` re-runs `pi install` with them. The
ADR-0069-accepted lag (an extension released between config promotions is up to
one drift-cron + one promotion cycle behind) is documented in the update output,
not treated as a bug.

## Consequences

**Positive:**

- Fulfils the "update once installed" goal with the same one-command, auditable
  UX shape as `install.sh` — no new trust class.
- The `exec`-into-fresh-`install.sh` design makes "pins travel with the release"
  actually reach the consumer, and inherits `install.sh`'s existing failure-mode
  mitigations for free.
- Anti-downgrade + dirty-tree guards match the project's fail-closed norm
  (secrets-guard, gh-identity-guard).
- Flipping the default ref to a released tag replaces "whatever `main` currently
  is" with an operator-reviewed, PR-gated snapshot where config and `EXT_MIRRORS`
  pins are coherent.

**Negative / cost:**

- `update.sh` diverges from `install.sh`'s current unconditional-reset behavior by
  adding the dirty-tree guard — deliberate for the higher-stakes update path.
- Tag-tracking lags `main` by the sync→release `workflow_run` hop and is exposed
  to that job's lower failure visibility (#474) — cited here so a tag-tracking
  consumer's freshness depends on that automation staying healthy.

**Deferred (filed, not built):**

- **Channel integrity parity** (#627): the config mirror rides plain HTTPS +
  unsigned tags while the pi binary is Sigstore-attested (ADR-0038/0040).
  Tag-pinning closes most of the gap; signed/attested release verification at
  update time is a separate reviewed release-automation surface.
- **Automated update-available nudge** (#628) on top of `update.sh --check`,
  under the same local-compare / static-text / no-fetch-hook constraints.

## Doc-Impact

- `update.sh` — new (this decision).
- `install.sh` — default-ref flip + stale-comment fix.
- `mirror/targets.yml` — `update.sh` added to `pi-config` `sources`.
- `scripts/validate.sh` — `update.sh` added to the shellcheck target list.
- `mirror/readme/pi-config.md` — consumer-facing "Updating" section.
- `README.md` — this ADR's index row.
- Follow-ups #627, #628 track the two out-of-scope surfaces.
