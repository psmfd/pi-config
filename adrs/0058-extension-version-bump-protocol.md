---
status: Accepted
date: 2026-06-25
---

# ADR-0058: extension mirror versions are computed from Conventional-Commits history

**Status:** Accepted
**Date:** 2026-06-25
**Closes:** [#415](https://github.com/psmfd/pi_config/issues/415) (extension releases were stuck at v0.1.0)
**Related:** [ADR-0055](0055-automated-mirror-releases.md) (the release automation this completes), [ADR-0042](0042-standalone-extension-distribution.md) (overlay-owns-packaging — this carves a narrow exception), [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the sync engine), [ADR-0047](0047-release-automation-script.md) (`release.sh`, which derives the SOURCE version the same way — the logic kept in lockstep).

## Context and Problem Statement

ADR-0055 made `sync-mirror.sh --release` create an annotated tag + GitHub Release
for each mirror. For **overlay** (extension) mirrors it read the version from the
**mirror's own `package.json` `.version`**. That value never advanced on its own,
so the automation was inert past the initial `v0.1.0` (#415). Two facts pinned it:

1. **Version authority was mirror-local.** The extension `package.json` lives only
   on the mirror (overlay-owned per ADR-0042); the overlay sync *preserves* it.
   Nothing in `pi_config` changed it, so `--release` kept finding an existing
   `v0.1.0` release and skipping.
2. **`--changed` only fires on a source change.** The CI `sync` job runs
   `--all --changed --push --release`; `--changed` compares the target's source
   subtree (`agent/extensions/<name>/`) against the SHA in the mirror's
   `.mirror-provenance` and skips unchanged targets. A bump made only on the
   mirror is invisible to it.

So the version had to (a) be derived from something in `pi_config` source so
`--changed` fires, and (b) advance automatically as the extension's code changes.

## Considered Options

A three-way expert fan-out (versioning strategy / bash implementation / CI
mechanics) produced:

1. **Manual `version:` field in `mirror/targets.yml`.** Explicit and reviewed, but
   relies on the author remembering to bump (a forgotten bump silently ships no
   release), needs a `validate.sh` check that *itself* derives the bump from
   commits to catch under-bumps, and a version-only manifest edit strands (it does
   not change the extension subtree, so `--changed` skips).
2. **Compute the version from Conventional-Commits history over the extension
   subtree.** Chosen. The version is derived, not stored; the same commits that
   trigger the sync determine the bump, so there is no "forgot to bump" failure
   mode and nothing to strand.
3. **Manual bump on the mirror.** Rejected: invisible to `--changed`; never
   releases.

The deciding point: option 1 needs the Conventional-Commits derivation *anyway*
(to police the manual value), so computing the version directly is simpler and
strictly more robust. It also matches `release.sh`, which already derives the
**source** version from Conventional Commits.

## Decision Outcome

**Chosen: option 2.** In the `--release` overlay path, `sync-mirror.sh`:

1. **Anchors** at the SHA in the mirror's current `.mirror-provenance` (the SHA the
   mirror was last synced from) — the range `provenance..HEAD` over
   `agent/extensions/<name>/` is *exactly* the change set this sync ships.
2. **Classifies** the Conventional-Commits types in that range and computes the
   next pre-1.0 SemVer bump:

   | Commit signal over the subtree | Bump |
   |---|---|
   | `feat` | MINOR (`0.Y.0`) |
   | `fix`, `perf` | PATCH (`0.y.Z`) |
   | `!` / `BREAKING CHANGE` | MINOR pre-1.0 (SemVer §4 — **not** MAJOR; v1.0.0 is a deliberate, separate decision) |
   | `docs`, `chore`, `style`, `refactor`, `test`, `ci`, `build`, none | NONE — content syncs, but no release |

3. **Injects** the computed version into the mirror clone's `package.json` (`jq`,
   temp-file rewrite) *before* the provenance rewrite and commit, so the bump ships
   with the content. The existing `maybe_release()`/`create_release()` then tag and
   release it idempotently.
4. **Guards:** a no-regression check refuses a version ≤ the current one; a NONE
   result skips the release for that target with a clear message; an unreachable
   anchor SHA fails closed.

**The narrow ADR-0042 carve-out:** the overlay still owns every `package.json`
field; only `.version` becomes a sync-injected, source-derived value. This is the
minimum needed to give the engine a single source of truth `--changed` can act on.

**Where the knowledge lives (for humans):** the decision is here; the operational
flow and the commit-discipline rule are in
[`docs/outbound-mirror-sync.md`](../docs/outbound-mirror-sync.md) § Releases; the
mechanism is in `scripts/sync-mirror.sh` (`ext_advance_version` /
`ext_next_version` / `_classify_bump`, lockstep-commented to `release.sh`), with a
`--self-test` gate wired into `validate.sh`.

### Consequences

- Good: an extension code change typed per Conventional Commits produces the right
  release automatically — no manual version step, no forgotten-bump silent miss,
  consistent with `release.sh`.
- Good: the review gate is the **commit message** (reviewed at PR time), the same
  signal `release.sh` trusts for the source version.
- Neutral: the bump logic is duplicated inline (not shared via `scripts/lib`,
  which `sync-mirror.sh` deliberately does not depend on) and kept in lockstep
  with `release.sh` via comment; the `--self-test` guards against drift.
- Accepted / commit-discipline: a behavior-changing commit typed `chore` (e.g. a
  `web-fetch` allowlist expansion) yields **no** release. Such commits must be
  `fix` (or `feat`) to ship; this is a commit-message rule, documented in the
  runbook, not a code change.
- Accepted: a version-only release with no source delta is not expressible (there
  is nothing to compute from); force it with `--target <name> --push --release`
  plus an explicit source touch if ever needed.
- Migration: the five mirrors stay at `v0.1.0`; the first promotion carrying a
  `feat`/`fix` over an extension subtree cuts its first computed release. No
  re-tagging.
