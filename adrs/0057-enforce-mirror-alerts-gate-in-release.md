---
status: Accepted
date: 2026-06-25
---

# ADR-0057: enforce the code-scanning promotion gate in release.sh

**Status:** Accepted
**Date:** 2026-06-25
**Closes:** #408 (promote the gate from runbook-manual to enforced)
**Related:** [ADR-0052](0052-mirror-code-scanning-followup.md) (the gate and `check-mirror-alerts.sh`), [ADR-0047](0047-release-automation-script.md) (`release.sh`, the release ritual this hooks into), [ADR-0055](0055-automated-mirror-releases.md) (the mirror-release phase the same script gained). **Related follow-up:** #403 (auth posture for cross-repo queries from CI, if the gate ever moves there).

## Context and Problem Statement

ADR-0052 ships `scripts/check-mirror-alerts.sh`: a promotion gate that queries
the six public distribution mirrors for **open HIGH/CRITICAL CodeQL alerts** and
exits non-zero if any remain untriaged. It was documented as a **runbook-manual**
preflight — a step the operator was trusted to run by hand before a `dev`→`main`
promotion. A manual gate is exactly the control most likely to be skipped under
time pressure, which is when a HIGH/CRITICAL finding most needs to block a
release. The gate exists; nothing *enforced* it.

`release.sh` (ADR-0047) is the single, scripted entry point for a promotion, with
a Phase 0 preflight that already fails closed on identity drift, a dirty tree, and
branch divergence. That preflight is the natural place to make the gate
mandatory.

## Considered Options

1. **Wire the gate into `release.sh` Phase 0.** Chosen. The release ritual already
   runs locally as the operator (org owner), whose `gh` has the `security_events`
   read the gate needs across the mirror repos — no new token. The gate becomes
   unskippable on the normal path, with an explicit override.
2. **A scheduled / promotion-PR GitHub Actions check.** Deferred. The gate queries
   *other* repos, so the default `GITHUB_TOKEN` is insufficient; it needs a scoped
   cross-repo token, which ties into the PAT→GitHub-App migration (#403). More
   moving parts for the same outcome on the manual release path; revisit if
   releases ever move off the local script.
3. **Leave it manual (status quo).** Rejected: a control that depends on operator
   memory is not a control.

## Decision Outcome

**Chosen: option 1.** `release.sh` Phase 0 runs `check-mirror-alerts.sh` as its
final preflight step:

- **Fail-closed.** A non-zero exit aborts the release via `fatal` — both exit 1
  (open HIGH/CRITICAL alert) and exit 2 (the gate could not run, e.g. a `gh`
  access error). You cannot promote what you cannot verify.
- **Runs under `--dry-run`.** The gate is read-only, so a dry-run still surfaces a
  release that *would* be blocked, rather than hiding it until the real run.
- **Override:** `--skip-mirror-alerts` bypasses the gate with a visible `WARN`,
  for a known-accepted state or an unresolvable access error. It is the lowest-
  blast-radius escape hatch (one release, announced in the output), mirroring the
  override posture of the secrets/identity guards.
- **Threshold:** the gate's default (`high`) — HIGH and CRITICAL block; dismissed
  alerts are `state=closed` and never count (ADR-0052).

### Consequences

- Good: a HIGH/CRITICAL finding on a public mirror now blocks the release by
  default, not by operator diligence; the control is enforced where promotions
  actually happen.
- Good: no new credential — the gate reuses the operator's existing `gh` auth on
  the local release path.
- Neutral: the gate runs on every release attempt (a handful of `gh` API calls);
  negligible cost, and `--dry-run` previews it.
- Bad / accepted: a raw-shell `git`/`gh` promotion that bypasses `release.sh`
  also bypasses the gate. `release.sh` is the sanctioned path (ADR-0047); a
  CI-side check (option 2, #403-coupled) would close that gap if it becomes a
  concern.
- Bad / accepted: the override exists by design; like `--no-verify`, it trusts
  the operator, but it announces itself in the output and is documented.
