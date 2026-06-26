---
status: Accepted
date: 2026-06-25
---

# ADR-0055: automated tag + GitHub Release creation for the distribution mirrors

**Status:** Accepted
**Date:** 2026-06-25
**Closes:** #414 (mirrors had no release mechanism)
**Related:** [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the sync engine this extends), [ADR-0042](0042-standalone-extension-distribution.md) (extension mirrors own their packaging/version), [ADR-0054](0054-no-source-ci-on-distribution-mirror.md) (no source CI on the mirror), [ADR-0047](0047-release-automation-script.md) (`release.sh`, which gains the config-mirror hook). **Follow-up:** #415 (extension version-bump protocol).

## Context and Problem Statement

The outbound sync engine (`scripts/sync-mirror.sh`, ADR-0050) pushed **content +
`.mirror-provenance` only** to the six public mirrors — it created no tags and no
GitHub Releases. Consequences:

- The config mirror `psmfd/pi-config` had no pinnable release; consumers could
  only track a rolling `main`.
- The five extension mirrors had an initial `v0.1.0` annotated tag but **no
  Release object** (invisible in the GitHub "Releases" UI; the `pi-ecosystem`
  dashboard fell back to the bare tag).

A release on a mirror is safe under `replace`-mode `rsync --delete` because tags
and Release objects are separate refs, untouched by the content sync. The two
mirror types version differently, and that difference is load-bearing:

- **Config mirror** (`pi-config`, `replace`) is a wholly-derived artifact of
  `pi_config`; its version is a projection of the **source** version (`v1.3.0`).
- **Extension mirrors** (`pi-<name>`, `overlay`, ADR-0042) are composite: source
  provides the implementation, the mirror owns the packaging (`package.json`,
  …). Their version is **independent SemVer**, authoritative in the **mirror's
  own `package.json`**, not in `pi_config`.

There is also a timing constraint: the `sync` job fires on the **push to `main`**
(the promotion merge), but `release.sh` pushes the source `vX.Y.Z` tag *after*
the merge — so at sync time the new source tag may not yet exist.

## Considered Options

1. **One release mechanism in the sync engine, invoked per mirror type.** Chosen.
   `sync-mirror.sh` gains an idempotent `--release`; *where* it is invoked
   differs by versioning model (below).
2. **Put all release logic in `release.sh`.** Rejected: `release.sh` does not
   know the extension versions (mirror-local), and the extension release must run
   in CI after the content sync, not in the manual source-release ritual.
3. **Put all release logic in the CI `sync` job.** Rejected for the config
   mirror: the job fires on the promotion push before the source tag exists, so
   it cannot know the config version. (It *is* the right place for extensions.)

## Decision Outcome

**Chosen: option 1** — one idempotent mechanism, a split invocation.

- **Mechanism (`sync-mirror.sh --release` [`--release-version vX.Y.Z`]):** after a
  successful push (or an already-current mirror), ensure an **annotated tag +
  GitHub Release** on the mirror. `replace`-mode targets take the version from
  `--release-version`; `overlay`-mode targets read it from the mirror's own
  `package.json` `.version`. A `replace` target with no `--release-version` is
  **skipped** (not an error), so an `--all --release` CI run releases the
  extensions while leaving the config mirror to `release.sh`.
- **Idempotency:** two independent probes — the tag (`git rev-parse
  refs/tags/vX.Y.Z`) and the Release (`gh release view`) — gate creation, so the
  step is safe to re-run and a partial failure (tag pushed, Release missing)
  self-heals. The `--changed` early-skip returns before the release phase, so an
  unchanged target is never re-released.
- **Annotated tags on the automated path:** `gh release create` alone creates a
  *lightweight* tag; the engine instead creates the annotated tag with `git tag
  -a` and pushes it, then `gh release create --verify-tag` attaches the Release.
  This keeps mirror tags annotated, matching the manual-path discipline rather
  than relying on the ADR-066 lightweight-automation exemption.
- **Config mirror hook (`release.sh` Phase 6):** after the source tag is pushed,
  `release.sh` calls `sync-mirror.sh --target pi-config --push --release
  --release-version $VERSION`. The version is known, identity is verified, and a
  TTY confirmation gate applies. Independent of `--no-release` (which governs the
  private source's Release only); a new `--no-mirror-release` opts out.
- **Extension hook (CI `sync` job):** the job runs `--all --changed --push
  --release`, with `GH_TOKEN=MIRROR_SYNC_TOKEN` so `gh` can create the
  tag/Release on the mirror repos. Each extension is released from its
  `package.json` version when its content syncs.
- **Token scope:** both the tag push and `gh release create` need **Contents:
  write** only — already held by `MIRROR_SYNC_TOKEN`, and consistent with the
  narrowing in #412.
- **`pi-ecosystem` dashboard** auto-discovers each cataloged repo's
  `latestRelease` on a 6-hourly cron, so new mirror releases surface there with
  no code change (a manual `gh workflow run dashboard` refreshes sooner).

### Consequences

- Good: every mirror gets a pinnable, UI-visible release; the config mirror stays
  in lockstep with source versions and extensions keep independent SemVer.
- Good: one idempotent code path, re-run-safe, fail-closed per target without
  aborting an `--all` run.
- Neutral / accepted: in CI, `--all --changed --push --release` only releases an
  extension when its **content** changes. Because the extension version lives in
  the mirror's `package.json` (overlay-owned, not synced) and `--changed` skips
  unchanged targets, a version bump alone does not trigger a release. After the
  `v0.1.0` backfill the extension automation is effectively inert until a
  **version-bump protocol** exists — tracked as #415.
- Accepted: a non-`--changed` `--push` rewrites `.mirror-provenance` and pushes a
  sync commit even when file content is unchanged (pre-existing engine behavior);
  the release phase is unaffected and remains idempotent.
