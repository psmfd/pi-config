---
status: Accepted
date: 2026-07-03
---

# ADR-0068: share the Conventional-Commits bump classifier via scripts/lib

**Status:** Accepted
**Date:** 2026-07-03
**Supersedes in part:** [ADR-0058](0058-extension-version-bump-protocol.md) — specifically its "the bump logic is duplicated inline (not shared via `scripts/lib`, which `sync-mirror.sh` deliberately does not depend on) and kept in lockstep with `release.sh` via comment" consequence. ADR-0058's core decision (extension mirror versions are computed from Conventional-Commits history) is unchanged.
**Related:** [ADR-0066](0066-ci-release-automation.md) (CI release automation that calls `release.sh --print-version`), [ADR-0047](0047-release-automation-script.md) (`release.sh`), the `script-output-conventions` rule (the `scripts/lib` `--self-test` convention).

## Context and Problem Statement

The Conventional-Commits bump classifier (`classify_bump`) and SemVer arithmetic
(`bump_version`, and `sync-mirror.sh`'s `ver_gt`) existed as **two byte-identical
copies**: one in `scripts/release.sh` (deriving the source-repo version, also via
`--print-version` in CI per ADR-0066) and one inline in `scripts/sync-mirror.sh`
(deriving each overlay mirror's version, ADR-0058). ADR-0058 recorded the
duplication as an accepted "Neutral" trade-off, kept in lockstep "by comment,"
justified by a claim that `sync-mirror.sh` "installs standalone in CI and cannot
source `scripts/lib`."

Two problems:

1. **Lockstep-by-comment is fragile.** Nothing mechanically prevented the two
   copies from drifting — and they *had* silently drifted: `release.sh` fed the
   classifier `git log --format='%s'` (subject only), while `sync-mirror.sh` fed
   `%s%n%b` (subject + body). A `BREAKING CHANGE:` footer lives in the commit
   body, so `release.sh` — and therefore the CI-driven source tag — could not
   detect a footer-only breaking change, only the inline `!:` marker. A latent
   under-classification bug hiding behind two textually-identical functions.

2. **The "cannot source scripts/lib" rationale was stale.** All three CI call
   sites invoke `./scripts/sync-mirror.sh` from a full `actions/checkout`, and the
   script already reads `mirror/targets.yml` and `mirror/sanitize/` from the repo
   tree — it cannot run standalone regardless. There is no curl-piped or
   out-of-tree install path for it.

## Considered Options

1. **Extract a shared `scripts/lib/semver-classify.sh`, sourced by both scripts.**
2. **Keep the duplication, add a `validate.sh` diff-equality gate** between the two
   function bodies to replace comment discipline with a mechanical check.
3. **Do nothing** — accept the fragility and the footer bug.

## Decision Outcome

**Chosen: option 1.** Extract `classify_bump` / `bump_version` / `ver_gt` into
`scripts/lib/semver-classify.sh` — pure functions, bash-3.2-safe, no shell options
at top level (the caller owns `set -euo pipefail`), with a `--self-test` mode wired
into `validate.sh` as the canonical coverage. `release.sh` and `sync-mirror.sh`
source it and delete their local copies. As part of the same change, **both call
sites standardize on `git log --format='%s%n%b'`**, closing the footer-detection
gap in `release.sh`.

Option 2 was rejected: a diff-equality gate freezes the duplication in place rather
than removing it, and does nothing about the divergent *inputs* (the `%s` vs
`%s%n%b` feed) that were the actual bug — two identical function bodies fed
different data. Option 3 leaves a real breaking-change misclassification live.

### Consequences

- **Positive:** one source of truth for bump logic; the classifier is unit-tested
  in one place; `release.sh` now correctly detects `BREAKING CHANGE:` footers.
- **Positive:** the ADR-0058 "lockstep by comment" fragility is gone.
- **Neutral:** `sync-mirror.sh` gains a `scripts/lib` dependency — already true in
  practice (it reads the repo tree) and now explicit.
- **Trade-off:** the shared lib must stay bash-3.2-safe even though `sync-mirror.sh`
  itself already uses a bash-4+ `local -n` elsewhere; `release.sh` is stricter, so
  the lib holds to the lower floor.
