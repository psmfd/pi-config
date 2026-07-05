---
status: Accepted
date: 2026-07-05
---

# ADR-0074: Mirror-target onboarding lockstep gate

**Status:** Accepted
**Date:** 2026-07-05
**Tracking issue:** #512
**Related:** [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the sync engine + `mirror/targets.yml`), [ADR-0061](0061-mirror-sync-github-app-auth.md) + [ADR-0064](0064-installer-app-installation-automation.md) (the App-token `repositories:` scope + installation automation), [ADR-0051](0051-sendable-one-shot-installer.md) (`install.sh` / `EXT_MIRRORS`), [ADR-0066](0066-ci-release-automation.md) (the `sync-mirrors → release.yml` chain this protects), [ADR-0071](0071-secret-pattern-lockstep-reconciliation.md) (the lockstep-gate pattern this reuses)

## Context and Problem Statement

Adding a first-party extension mirror requires editing **three files in lockstep**:

1. `mirror/targets.yml` — the outbound sync manifest (what gets staged/pushed).
2. `.github/workflows/sync-mirrors.yml` `repositories:` — the mirror-sync App token's scope (ADR-0061); a target absent here cannot be pushed.
3. `install.sh` `EXT_MIRRORS` — what the one-shot installer wires via `pi install`.

Plus two out-of-repo steps: create the public repo (ADR-0042) and add it to the App installation (`scripts/add-mirror-to-installation.sh`, ADR-0064).

PR #509 (token-meter) added `pi-token-meter` to files 1 and 3 but **not** file 2, and never created the repo. Nothing caught it until the **v1.10.0 promotion**, where `sync-mirrors.yml` failed on the `pi-token-meter` push (`clone … failed`). Because `release.yml` is gated on `sync-mirrors` success (ADR-0066), the failure **silently skipped the entire release** — no tag, no GitHub Release — and v1.10.0 had to be completed manually via `release.sh --tag-only` (#512).

The failure mode is a documented-but-unenforced onboarding checklist: a human forgets one of the lockstep edits, and the gap only surfaces post-merge, at release time, as a confusing unrelated failure. This ADR adds enforcement.

## Considered Options

| Option | Verdict |
|---|---|
| **A — Static lockstep gate in `validate.sh` (offline, fail-closed, pre-merge)** — assert the `pi-*` extension set is identical across the three files. | **Chosen (primary).** Deterministic, network-free, runs as a required check on every PR to `dev`; catches the exact #509 drift *before merge*. Directly reuses the ADR-0071 lockstep-gate pattern. Cannot see repo-existence / App-authorization (those need network + the installer App). |
| **B — Reachability preflight in `sync-mirror.sh` (network)** — before staging, verify every target repo is reachable via `gh api`. | **Chosen (secondary).** Catches the piece A cannot: a target present in all three files whose repo does not yet exist / is not App-authorized. **Mode-aware:** a definitive 404 fails **closed in `--push` mode** (real sync — the exact point a missing repo silently skips `release.yml`), and surfaces a loud **WARN in dry-run** (the `verify` PR gate, local previews) so a repo-existence check does not block the required gate or unrelated PRs. Any indeterminate result (no gh/auth/network) warns and proceeds. A is the deterministic pre-merge backstop; B turns the cryptic mid-run `clone failed` into an actionable ONBOARD message and makes the real sync fail loudly instead of silently skipping the release. |
| C — Warn-only + auto-file an onboarding issue (pin-drift style, ADR-0069) | Rejected as the primary mechanism. A non-blocking signal is exactly what failed here — the onboarding step was already documented and still missed. Fail-closed is the point. (An advisory notification may be layered on later without changing this decision.) |
| D — Do nothing / rely on the runbook | Rejected. The runbook already documented the three edits; a human still skipped one and it silently broke a release. |

## Decision Outcome

Add a **two-layer fail-closed guard**, both landing in this change:

1. **`validate.sh` static lockstep gate** (`#512`): the set of `pi-*` extension targets (excluding the `pi-config` base clone) must be identical across `mirror/targets.yml`, `sync-mirrors.yml` `repositories:`, and `install.sh` `EXT_MIRRORS`. Any membership gap fails the PR with the specific missing entry and a pointer to the onboarding runbook.
2. **`sync-mirror.sh` onboarding preflight** (`#512`): before staging, `gh api repos/<owner>/<name>` each target. A definitive 404 fails **closed in `--push` mode** with the onboarding steps and surfaces a loud **WARN in dry-run** (so the `verify` gate is not blocked by a repo-existence check); an indeterminate result (no gh/auth/network) warns and proceeds. The existing mid-run `clone failed` message is also upgraded to the same ONBOARD guidance.

`pi-config` is the base distribution clone, not a `pi install` extension, so it is intentionally excluded from the `EXT_MIRRORS` comparison.

## Consequences

**Positive:**

- The #509 class of drift (target added to some but not all lockstep files) fails the PR that introduces it, offline and deterministically.
- A target whose repo does not exist is flagged in the `verify` PR gate and at sync time with actionable onboarding steps, instead of silently skipping a release.
- No new standing infrastructure; reuses the ADR-0071 gate pattern and the existing sync engine.

**Negative / cost:**

- The preflight adds one `gh api` call per target on each `sync-mirror.sh` run (dry-run included); bounded (~13 calls), and network failures degrade to a warning rather than a hard failure.
- The static gate encodes the parse of three file formats (YAML target list, the `repositories:` block, the `EXT_MIRRORS` array); a large refactor of any of those must keep the parser in step.

**Neutral:**

- Onboarding still requires the two out-of-repo steps (repo create + App-installation add); the guard makes their omission *fail loudly and early* rather than performing them.

## Doc-Impact

| Surface | Classification | Reason |
|---|---|---|
| `adrs/0074-*.md` | in-scope | this ADR |
| `scripts/validate.sh` | in-scope | the static lockstep gate |
| `scripts/sync-mirror.sh` | in-scope | the reachability preflight + upgraded clone-failure message |
| `.github/workflows/sync-mirrors.yml` | in-scope | add `pi-token-meter` to `repositories:` (closes the #509 drift so the gate passes) |
| `docs/outbound-mirror-sync.md` | in-scope | reference the gate + preflight in the onboarding section |
| ADR | in-scope | this record (lockstep-gate decision, per ADR-0071 precedent) |
