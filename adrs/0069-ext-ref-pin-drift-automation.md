---
status: Accepted
date: 2026-07-03
---

# ADR-0069: automate EXT_REF pin-drift detection

**Status:** Accepted
**Date:** 2026-07-03
**Related:** [ADR-0058](0058-extension-version-bump-protocol.md) (mirror versions are computed, so consumer pins must chase them), [ADR-0061](0061-mirror-sync-github-app-auth.md) (the mirror-sync App — deliberately NOT reused here), [ADR-0068](0068-shared-semver-classify-library.md) (`ver_gt`, sourced by the drift checker), #492 (install.sh per-mirror pin split — the root-cause fix this detector cannot itself perform).

## Context and Problem Statement

`install.sh` and `install-expertise.sh` pin the extension mirrors they install via
hand-edited `EXT_REF` values. Nothing kept them current: mirror releases are cut
automatically from CI (ADR-0055/0058) whenever an extension's source changes, but
the consumer pins are bumped only when a human remembers. The result was silent
staleness — verified 2026-07-03, `install.sh`'s single shared `EXT_REF="v0.1.0"`
was already behind **10 of 11** mirrors' latest releases, and `install-expertise.sh`
needed three manual bump commits across #486/#488/#490 to track one mirror.

`agent-framework-claude` already solved the analogous problem for its container
digest pins with `pin-drift-check.yml` + `scripts/check-pin-drift.sh`: a weekly
cron that files/refreshes one idempotent labelled issue. We want the same
discipline here, adapted to GitHub-release-backed pins.

## Considered Options

1. **Scheduled poll** comparing each pin to `gh release view` on the producer repo,
   filing/refreshing a `pin-drift` issue and (where safe) opening a bump PR.
2. **Producer-triggered `repository_dispatch`** from each mirror release into a
   pin-check workflow here.
3. **A privileged GitHub App** to open cross-repo bump PRs.
4. **Do nothing** — keep bumping pins by hand.

## Decision Outcome

**Chosen: option 1 (poll), with a local CLI counterpart.**

- **`scripts/check-ext-ref-drift.sh`** — the local/CI checker. Derives the overlay
  repo list from `mirror/targets.yml` (single source of truth, like
  `check-mirror-alerts.sh`), compares each pin to the mirror's latest release, and
  reports in the `script-output-conventions` format. `--fix` rewrites a pin in
  place (tempfile + `cat >` to preserve the exec bit; never `sed -i`, which forks
  BSD/GNU). It uses `ver_gt` from `scripts/lib/semver-classify.sh` (ADR-0068) so a
  fix never downgrades.
- **`.github/workflows/pin-drift-check.yml`** — weekly cron + manual dispatch.
  Files/refreshes a single `pin-drift` issue with the report, auto-closing it when
  drift clears, and opens a bump PR for the one safely-fixable pin.

**No GitHub App (option 3 rejected).** The bump PR is a **same-repo** write plus
**public, unauthenticated** release reads, fully covered by the workflow's default
`GITHUB_TOKEN` (`contents`/`issues`/`pull-requests: write`). Reusing or widening the
mirror-sync App (ADR-0061, scoped to push the 12 downstream mirrors) would collapse
exactly the least-privilege boundary it was built for.

**Poll, not dispatch (option 2 deferred).** A weekly cron is self-contained here and
degrades gracefully — a missed run is caught next tick. `repository_dispatch` would
require a dispatch step in every producer's release workflow, each a cross-repo
credential to manage, and a broken step fails **silently** with no backstop. A
dispatch fast-path may be added later as a strictly-additive optimization; the cron
remains the mechanism relied on for correctness.

### The install.sh vs install-expertise.sh asymmetry

`install-expertise.sh` pins a single mirror 1:1, so its pin is safely auto-bumped
when the mirror is strictly newer. `install.sh` pins **all 11** overlay mirrors with
one shared `EXT_REF` — which cannot represent independently-versioned mirrors
(ADR-0058). The checker therefore **reports** install.sh drift per-repo but
**refuses `--fix`** whenever the mirrors' latest tags diverge (they do), because a
single bump would pin a tag some mirrors lack. The root-cause fix — splitting
install.sh into per-mirror pins — is tracked as #492; until it lands, install.sh
drift surfaces via the issue, not an auto-bump.

### Consequences

- **Positive:** pins can no longer silently rot; the near-term active signal is the
  weekly issue for install.sh's known divergence.
- **Positive:** no new privileged identity; the App boundary (ADR-0061) is untouched.
- **Neutral:** a `GITHUB_TOKEN`-authored bump PR does not itself trigger the
  `validate` workflow (GitHub's loop-prevention) — acceptable for a solo maintainer
  who reviews/re-runs before merge; the near-term bump path is dormant anyway
  (install-expertise.sh is currently current).
- **Trade-off:** up to one week of staleness between a mirror release and the issue —
  acceptable, and shortenable later with the optional dispatch fast-path.
