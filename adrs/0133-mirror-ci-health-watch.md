---
status: Accepted
date: 2026-08-12
---

# ADR-0133: the distribution mirrors' own CI is watched from the source repo

**Status:** Accepted — the operator approved the design on 2026-08-12 (#967).

## Context and Problem Statement

The thirteen public `psmfd/pi-*` mirrors are the distribution surface: what a
user actually installs. Each extension mirror runs its own `ci.yml`
(`npm ci && npm run typecheck && npm test`) on every push to `main`, and that
run is the only gate standing between a bad sync and a broken published
artifact.

Nothing observed it. `sync-mirror.sh --push` pushes and returns; it never waits
on, or reports, the run its own push triggered. `check-mirror-alerts.sh`
(ADR-0052) watches code-scanning alerts, which is a different signal entirely.
So a mirror could sit red on `main` indefinitely with no signal reaching this
repo — and one did: `psmfd/pi-token-meter` was red from 2026-07-24 until the
packaging sweep of #856 happened to run every mirror's CI commands by hand
**eighteen days later**.

The obvious spot-check does not find it, which is the part worth recording:

```console
$ gh run list --repo psmfd/pi-token-meter --branch main --limit 1
success  2026-08-09  github_actions in /. - Update #1515570266   # <- Dependabot

$ gh run list --repo psmfd/pi-token-meter --workflow ci.yml --branch main --limit 1
failure  2026-07-24  chore(sync): update from psmfd/pi-config@...
```

Dependabot updater runs also land on `main`, are frequent, and are almost always
green, so they dominate a branch-only listing. Any check that omits
`--workflow` reports the same false green. That masking is the whole bug, and
it generalizes: **a green-looking signal that was never actually produced by the
gate you care about is worse than no signal**, because it converts an unwatched
surface into one that reports as watched.

## Considered Options

1. **Do nothing; rely on the packaging sweep.** Rejected — that is the status
   quo that produced an 18-day red. The sweep is an occasional, manually
   triggered event (ADR-0119 row 6); it is not a monitor.

2. **Make the mirror CI state a `release.sh` promotion gate**, the way ADR-0057
   wired the code-scanning gate into Phase 0. Rejected, and the current incident
   is exactly why: `pi-token-meter` is red *pending* the fix that the next
   promotion carries. Blocking promotion on mirror red would deadlock the very
   case the watch exists to surface. Mirror CI is a lagging indicator of what
   was already published; the promotion is the mechanism that repairs it.

3. **Have `sync-mirror.sh --push` surface the triggered run's URL and wait on
   it.** Rejected. The run does not exist yet when `--push` returns, so this
   needs polling inside the release path — added latency and a new flake mode on
   the most consequential script in the repo, for a signal a daily watch
   delivers within 24h. The attribution value it was reaching for is delivered
   instead by including the run's head commit and subject in the report: the
   commit subject *is* the sync (or packaging commit) that broke it.

4. **A scheduled watch in this repo that queries each mirror's `ci.yml`
   conclusion and files a rolling issue.** Chosen.

## Decision Outcome

`scripts/check-mirror-ci.sh` reports the CI state of every target in
`mirror/targets.yml`; `.github/workflows/mirror-ci-watch.yml` runs it daily at
15:00 UTC and maintains one rolling issue.

Six decisions are load-bearing:

1. **Query by workflow, never by branch alone.** The gate names `ci.yml`
   explicitly. This is the fix for the Dependabot masking above.

2. **Scope is derived from `mirror/targets.yml`** — the single source of truth
   for what gets published — never a second hardcoded list. This deliberately
   adds **no fourth site** to the ADR-0074 lockstep triple (`targets.yml` /
   `sync-mirrors.yml` / `install.sh`); a new mirror is watched the moment it is
   onboarded, with no further edit.

3. **Fail closed. "Cannot tell" is a finding.** A workflow that cannot be
   queried, a repo that 404s, and a workflow with no completed run on `main` are
   all errors. No-data and green must never collapse into the same report — that
   collapse is the failure mode this ADR exists to prevent.

4. **The gate asserts the workflow is `active`, not merely that its last run was
   green.** A `ci.yml` set to `disabled_manually` leaves its last green run
   standing forever: the purest form of the false green. This is checked
   separately from the conclusion.

5. **The `replace`-mode exemption is asserted, not assumed.** The config mirror
   (`psmfd/pi-config`) ships no source CI workflows by design (ADR-0054), so it
   has no `ci.yml` to check. Rather than skipping it, the gate asserts the
   *absence* and reports it as drift if a workflow appears there. An exemption
   that never re-checks its own premise is how a skip silently becomes a hole.

6. **The default `GITHUB_TOKEN` is sufficient; the mirror-sync App is not
   widened.** The mirrors are public, so their Actions API is readable without
   any cross-repo grant (verified: an unauthenticated request returns `200`).
   The ADR-0061 App keeps its `Contents: write`-only scope and gains no
   `Actions: read`. Decision 3 covers the residual risk: if this assumption ever
   stops holding, the query fails and is reported as a finding rather than
   passing silently.

The workflow is **notify-only**, in the established shape of
`pin-drift-check.yml` (ADR-0069): one rolling issue on a fixed title plus the
`mirror-ci` label, refreshed on each red run and **auto-closed** when every
mirror goes green. The job itself fails only on a precondition error (exit 2) —
a red mirror is reported through the issue, not through a daily red workflow run
that would train the maintainer to ignore it.

## Consequences

- A mirror that breaks is visible within 24h instead of "whenever someone
  happens to run its CI commands by hand."
- The watch reports the state of the *last published* artifact. It cannot
  pre-empt a bad sync; `sync-mirrors.yml`'s PR-time dry-run gate covers that
  direction.
- Two extra API calls per target per day (thirteen targets) against public
  endpoints — negligible against the rate limit.
- On landing, the watch will correctly report `pi-token-meter` red until the
  next `dev`->`main` promotion syncs the #966 fix out. That is the gate working,
  not a false positive.
- A window of up to a few seconds exists where a push has landed but its run has
  not been created; the latest *completed* run is then one commit stale. At a
  daily cadence this is not reachable in practice, and decision 4 covers the
  case where a run is missing because the workflow is off rather than because it
  is pending.

## Related

- [ADR-0052](0052-mirror-code-scanning-followup.md) — the code-scanning gate
  (`check-mirror-alerts.sh`), this gate's sibling and structural model
- [ADR-0057](0057-enforce-mirror-alerts-gate-in-release.md) — enforcing that
  gate in `release.sh` Phase 0; deliberately *not* followed here (option 2)
- [ADR-0069](0069-ext-ref-pin-drift-automation.md) — `pin-drift-check.yml`, the
  rolling-issue watch pattern this workflow copies
- [ADR-0054](0054-no-source-ci-on-distribution-mirror.md) — why the config
  mirror ships no workflows, the premise decision 5 asserts
- [ADR-0074](0074-mirror-target-onboarding-lockstep-gate.md) — the lockstep triple
  this gate deliberately does not extend
- [ADR-0061](0061-mirror-sync-github-app-auth.md) — the mirror-sync App whose
  scope decision 6 leaves unchanged
