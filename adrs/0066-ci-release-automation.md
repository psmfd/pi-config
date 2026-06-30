---
status: Accepted
date: 2026-06-29
---

# ADR-0066: automate the dev→main release in CI (tag + Release on merge); retire the `release.sh` poller

**Status:** Accepted
**Date:** 2026-06-29
**Supersedes:** [ADR-0047](0047-release-automation-script.md) — `release.sh` no longer owns the post-merge tagging/Release/mirror-release; it becomes the PR-opener (+ a `--tag-only` fallback), and CI owns the rest.
**Related:** [ADR-0036](0036-dev-integration-main-stable-branch-model.md) (the dev→main promotion model), [ADR-0055](0055-automated-mirror-releases.md) (the extension-mirror releases already automated in `sync-mirrors.yml`), [ADR-0057](0057-enforce-mirror-alerts-gate-in-release.md) (the code-scanning gate this keeps in `release.sh`), [ADR-0061](0061-mirror-sync-github-app-auth.md) (the App-token model reused for the config-mirror release), [ADR-0053](0053-pin-github-actions-to-sha.md) (SHA-pinning), [ADR-0058](0058-extension-version-bump-protocol.md) (the version-derivation kept in lockstep)

## Context and Problem Statement

ADR-0047 made `release.sh` own the full release sequence, including **Phase 3 — polling the manual owner-bypass merge** and then tagging + releasing. The poll ties the operator to the terminal through the merge, which is the constraint a "merge and walk away" workflow targets.

Facts a three-way expert fan-out (Actions implementation / release-workflow model / CI trust boundary) established:

- `main` advances **only** via a dev→main promotion merge done by the owner through GitHub's per-merge **bypass** of the inherited enterprise ruleset. So a push to `main` is, structurally, a release event — and that merge is and stays a deliberate manual action.
- `sync-mirrors.yml` **already** runs on push to `main` and auto-releases the 11 extension mirrors (`--all --changed --push --release`), but deliberately **skips** the replace-mode config mirror (no `--release-version`), which `release.sh` cut. The only post-merge work not yet in CI is the **source tag + Release + config-mirror release**.
- The code-scanning promotion gate (`check-mirror-alerts.sh`) needs `gh` with `security_events` **read on the mirror repos**. Neither the source `GITHUB_TOKEN` nor the Contents-only App token (ADR-0061) can run it in CI.
- No tag-protection ruleset exists on `psmfd/pi-config`, so `GITHUB_TOKEN` (`contents: write`) can push annotated tags; the enterprise ruleset is scoped to the `main` **branch** ref, not tag refs.

## Considered Options

1. **Adopt `semantic-release`** (as the sibling agent-framework repo does). Rejected: pi_config has no Node toolchain; `semantic-release` produces **lightweight** tags via the Releases API (pi_config's history is all annotated), and the Conventional-Commits derivation already exists in `release.sh`. `semantic-release` is healthy (Active; low risk) — the rejection is *fit*, not health.
2. **A `push: main`-triggered custom `release.yml`.** Closes the gap but **races** `sync-mirrors.yml` (both fire on the same push): the config-mirror tag could land before the content sync finishes, pointing the Release at stale content.
3. **A `workflow_run`-after-`sync-mirrors` custom `release.yml` (chosen).** Fires only after `sync-mirrors.yml` completes successfully, so the config-mirror content is current before the tag lands. Reuses `release.sh`'s version logic and keeps annotated tags.

## Decision Outcome

**Chosen: option 3.** A new `.github/workflows/release.yml`:

1. **Trigger:** `workflow_run` on `sync-mirrors` `completed`, filtered to `branches: [main]`, gated `if: github.event.workflow_run.conclusion == 'success'` (fail-closed — a failed sync skips the release). Checks out `workflow_run.head_sha` with `fetch-depth: 0`.
2. **Version:** a new **`release.sh --print-version`** mode (Phase-1 logic only; prints `vX.Y.Z` or `NONE`, no preflight/PR/tag) — single source of truth, no duplicated derivation. `NONE` ⇒ the workflow skips cleanly.
3. **Source tag:** annotated `git tag -a` under `GITHUB_TOKEN` (`contents: write`, **job-scoped**), tagger `github-actions[bot]`; idempotent (skip if the tag exists).
4. **Source Release:** `gh release create --verify-tag --generate-notes`; idempotent.
5. **Config-mirror release:** mint the App token (`environment: mirror-production`, scoped to `pi-config` only — ADR-0061) and run `sync-mirror.sh --target pi-config --push --changed --release --release-version` (content is a no-op via `--changed`; just the tag + Release).
6. **`release.sh`** keeps Phases 0–2 (preflight + code-scanning **gate** + version + open PR) as the PR-opener and **retires Phase 3 (the poll)** — it now exits after opening the PR. A new **`--tag-only`** mode is the emergency local fallback when CI did not tag (it re-runs the gate, then tags main + cuts the Release + mirror release).

### The code-scanning gate (kept local; the CI-enforcement gap is deferred)

The gate **stays in `release.sh` Phase 0**, which runs locally whenever the operator opens the promotion PR (under their `security_events`-scoped `gh`). It is **not** bypassed on the documented path. The only residual gap — a **hand-opened** promotion PR that skips `release.sh` — is pre-existing (true under ADR-0047 too) and is deferred: enforcing the gate as a required CI check needs a `security_events` cross-repo token, i.e. an ADR-0061 amendment (#473).

### Hardening (from the trust-boundary review)

- SHA-pin every `uses:` (ADR-0053); reuse the existing `actions/checkout` and `actions/create-github-app-token` pins.
- Workflow-default `permissions: contents: read`; `contents: write` only on the release job.
- `environment: mirror-production` gates the App-key access to this one job (ADR-0061's isolation control).
- `concurrency: release-${{ github.event.workflow_run.head_sha }}, cancel-in-progress: false` — one run per triggering SHA, never cancelled mid-tag.
- Idempotency: tag-exists and release-exists guards make re-runs (the CI failure fallback) safe.

The new trust surface — a push-to-main-triggered workflow holding `contents: write` on the source — is bounded: the code it runs is already owner-reviewed (push-to-main is owner-bypass-only) and the actions are SHA-pinned. It does not widen the ADR-0061 mirror trust model (same App token, same environment, `pi-config` already in scope).

## Consequences

- **Good:** a promotion is merge-and-walk-away — the operator opens the PR with `release.sh`, merges via owner bypass, and CI tags + releases. The poller retires; one source of version truth.
- **Accepted:** the source tagger becomes `github-actions[bot]` (a cosmetic divergence from `v1.0.0`–`v1.7.0`).
- **Accepted / deferred:** the hand-opened-PR gate gap (#473); `workflow_run` failures are less visible than push failures (#474).
- **Coupling:** `release.yml`'s `workflow_run` matches `sync-mirrors.yml`'s `name:` field — a rename silently breaks the trigger (documented in the workflow header).
- **Migration:** lands on `dev`; takes effect from the **next** promotion (v1.8.0+). v1.7.0 was cut manually.
