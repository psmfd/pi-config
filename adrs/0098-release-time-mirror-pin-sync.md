---
status: Accepted
date: 2026-07-12
---

# ADR-0098: Pre-promotion extension-mirror release + pin reconciliation

**Status:** Accepted
**Date:** 2026-07-12
**Related:** [ADR-0055](0055-automated-mirror-releases.md) (automated mirror releases), [ADR-0066](0066-ci-release-automation.md) (CI release automation), [ADR-0069](0069-ext-ref-pin-drift-automation.md) (EXT_REF pin-drift automation), [ADR-0075](0075-per-extension-install-pins.md) (per-extension pins), [ADR-0036](0036-dev-integration-main-stable-branch-model.md) (dev integration / main stable), #704 (the defect)

## Context and Problem Statement

Every cut pi-config release shipped an `install.sh` whose per-extension
`EXT_MIRRORS` pins pointed at the **previous** extension-mirror releases — the
release never carried the extension versions corresponding to its own content.

The cause is a release-ordering race. On the dev→main promotion merge, two CI
jobs fire on the same push:

- `sync-mirrors.yml` cuts the new extension-mirror releases from the promoted
  content, and
- `release.yml` cuts the config-mirror release,

so at the instant the config release is created, the new mirror releases the
pins should reference **do not yet exist** — the pins can only name the prior
releases. `pin-drift-check.yml` (ADR-0069) then repairs `dev` afterward, but the
cut release snapshot is immutable and permanently stale. Verified from the
v1.22.0 timeline (2026-07-12): mirror releases at 18:41, config release with the
old pins at 18:42, pin bump on dev at 19:10 — one full cycle too late.

## Decision Drivers

- The fix must make the released snapshot self-consistent, not merely repair
  `dev` after the fact.
- `dev` is a protected branch (ADR-0036 / rulesets): no actor, including
  `release.sh`, may push to it outside a PR. Any pin bump must go through a PR.
- The solo-maintainer release path (`release.sh`, ADR-0047/0066) is
  operator-driven and already authenticated as the org owner (`TheSemicolon`),
  which has push + release rights on the mirror repos.
- Must compose with, not duplicate, the existing post-merge `sync-mirrors.yml`
  and `pin-drift-check.yml` automation.

## Considered Options

1. **Post-hoc repair only (status quo)** — rejected: the immutable release stays
   stale; `pin-drift-check.yml` fixes dev but never the cut release.
2. **Reorder CI so `release.yml` waits for `sync-mirrors.yml`** — rejected: the
   pins are baked into the *merged content*; reordering the two post-merge jobs
   cannot change what the already-merged `install.sh` says. The pins must be
   correct *before* the merge.
3. **Pre-promotion phase in `release.sh` via `workflow_dispatch`** — dispatch
   `sync-mirrors.yml` against dev, wait for it, then rely on the async
   `pin-drift-check.yml` to open the bump PR. Rejected as the primary mechanism:
   it makes `release.sh` poll a CI run and then coordinate with an
   asynchronously-opened PR it cannot observe synchronously — more moving parts,
   no provenance benefit over option 4 for a solo owner-authenticated run.
   Recorded as the alternative if local mirror push is ever undesirable.
4. **Pre-promotion phase in `release.sh`, synchronous + local (chosen).**

## Decision Outcome

A new **Phase 1.5** in `scripts/release.sh`, between version inference (Phase 1)
and the promotion PR (Phase 2), on the normal path only (skipped by `--tag-only`
and `--no-mirror-release`):

- **1.5a — pre-release changed extension mirrors from dev.**
  `sync-mirror.sh --all --overlay-only --changed --push --release`. The
  `--overlay-only` filter (added for this phase) drops the replace-mode config
  mirror from the resolved target set **entirely**. This is load-bearing:
  `sync-mirror.sh`'s `push_target` rsyncs + pushes content for every resolved
  target *unconditionally*, and only the config mirror's tag/Release (not its
  content push) is skipped without `--release-version` — so merely omitting
  `--release-version` would still publish unmerged `dev` content to the public
  config mirror before the promotion PR opens. Excluding the target is the only
  safe scoping. The config mirror is still cut by `release.yml` / Phase 6
  post-merge. `--changed` makes an unchanged mirror a no-op, so the phase is
  idempotent across re-runs. Gated by an explicit confirmation prompt.
- **1.5b — reconcile pins, fail-closed.** Run `check-ext-ref-drift.sh`. If clean,
  proceed. If drift remains, `release.sh` cannot push the bump to protected dev,
  so it runs `check-ext-ref-drift.sh --fix` on a `chore/release-pin-sync-<VERSION>`
  branch, opens a PR to dev, and **stops** with a clear instruction: merge the
  PR, `git pull`, then re-run `release.sh`. The re-run finds 1.5a idempotent and
  pins clean, and proceeds to Phase 2 — now the promoted snapshot carries pins
  matching the just-cut releases.

The post-merge `sync-mirrors.yml` job is unchanged and becomes an idempotent
no-op for the already-released mirrors (`sync-mirror.sh --release` skips an
existing tag/Release).

### Why local + synchronous (option 4 over 3)

`release.sh` already requires and verifies the `TheSemicolon` identity (Phase 0),
which owns push + release rights on every mirror. Cutting the mirror releases
locally is therefore a synchronous, deterministic step with no CI-run polling
and no async-PR coordination. The mirror commits keep their existing
`sync@users.noreply.github.com` authorship (set by `sync-mirror.sh`), so
attribution is unchanged from the CI path. The `workflow_dispatch` alternative
(option 3) remains available if local mirror push is ever restricted.

## Consequences

- **Good:** the cut release is self-consistent — its pins match its content's
  mirror releases. The defect class is closed at the source, not repaired after.
- **Good:** composes with existing automation; the post-merge sync job and
  pin-drift automation still run and are simply no-ops when already reconciled.
- **Trade-off:** a release that changes extension content now takes **two passes**
  when pins drift (cut mirrors → merge bump PR → re-run). This is the direct cost
  of dev being protected; it is surfaced explicitly rather than worked around
  with an unsafe direct push. A release with no extension-content change is a
  single pass (1.5a no-ops, 1.5b finds no drift).
- **Interaction with the code-scanning gate (accurate framing):** Phase 1.5a
  does more than cut a tag — `--push` publishes the extension-mirror *content*
  to the public mirrors. The Phase 0 `check-mirror-alerts` gate queries each
  mirror's *currently-open* CodeQL alerts, i.e. alerts on the mirror state that
  existed *before* this push, so it does not scan the content 1.5a is about to
  publish. This timing gap is **pre-existing and unchanged in width**: the
  post-merge `sync-mirrors.yml` job published the identical content with the
  identical gate-before-push ordering. Phase 1.5a moves that same push earlier
  in the ritual; it does not create a new unscanned-publish window that did not
  already exist, and CodeQL re-scans the mirror on its own cadence after the
  push. The gate is a promotion guard against *known-open* alerts, not a
  pre-publish scanner — do not rely on it as the latter.
- **Least-privilege trade-off (credentials):** Phase 1.5a pushes content +
  releases to the extension mirrors using the operator's standing personal
  `gh`/git credentials (the `TheSemicolon` org-owner identity verified in Phase
  0), whereas the post-merge `sync-mirrors.yml` job performs the identical
  mutation under a narrowly-scoped, 1-hour GitHub App installation token
  (ADR-0061). Moving the extension-mirror push to the local pre-promotion path
  therefore widens the blast radius of a compromised operator session for those
  mirrors, relative to the CI-only path. This is an accepted trade-off of the
  synchronous local design (option 4) for a solo maintainer already holding
  owner rights, consistent with Phase 6's pre-existing local config-mirror
  release cutting; the `workflow_dispatch` alternative (option 3) avoids it at
  the cost of CI-run polling and async-PR coordination.
