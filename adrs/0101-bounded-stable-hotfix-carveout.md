---
status: Accepted
date: 2026-07-15
---

# ADR-0101: bounded stable-hotfix carve-out

**Status:** Accepted
**Date:** 2026-07-15
**Tracking issue:** #725
**Amends:** [ADR-0036](0036-dev-integration-main-stable-branch-model.md) — § Hotfix handling only
**Related:** [ADR-0056](0056-branch-protection-model.md), [`agent/rules/github-flow.md`](../agent/rules/github-flow.md), #723 (promotion-head guard, the mechanical enforcement of this carve-out), #720 (the incident that motivated the cluster)

## Context and Problem Statement

ADR-0036 § Hotfix handling authorizes urgent stable fixes to branch from and target `main` directly, distinguished "by their base and target branch, not by a separate mandatory prefix," with back-propagation to `dev` "immediately." The carve-out carries no bounding criteria: no authorization requirement, no auditable marker, no eligibility bar, and no defined propagation deadline.

PR #720 demonstrated the failure class this leaves open: a PR targeting `main` with a non-`dev` head merged and auto-published a release. #720 itself was a mistake, not an invoked carve-out — but the unbounded carve-out is a standing, named permission structure that a rationalizing agent could legitimately cite to reproduce the same outcome ("this feels urgent, so `main` is a permitted target"). The recovery PR (#726) deliberately left the carve-out untouched because tightening it is a decision change to ADR-0036, not a doc realignment (#725).

Separately, #723 adds a mechanical required check failing any PR that targets `main` with a head other than `dev`. That guard needs a well-defined, auditable exception for the legitimate hotfix path. This ADR defines that exception.

## Considered Options

1. **Leave the carve-out unbounded (status quo).**
   Rejected. An unbounded "urgent" path whose invocation criterion is the invoker's own judgment is exactly the rationalization surface the #720 postmortem identified. It also blocks #723: a head-branch guard with an undefined exception either blocks real emergencies or needs an ad-hoc bypass, recreating the problem.

2. **Delete the carve-out entirely — all fixes flow through `dev` and a promotion PR.**
   Rejected. A production-breaking defect or security fix on the stable channel is a real scenario for a stable-branch model. Forcing an artificial `dev`-first detour during an incident adds latency exactly when it is least affordable, and `scripts/release.sh`'s full promotion machinery is heavier than an emergency patch needs.

3. **Bound the carve-out: explicit maintainer authorization + `stable-hotfix` label + narrow eligibility + same-working-day back-propagation.**
   Chosen. Keeps the emergency path one label away while removing every self-service rationalization: the authorization must come from the maintainer, the label is machine-checkable (and is #723's designed exception), eligibility is stated in the rule text, and the propagation deadline is concrete.

## Decision Outcome

**Chosen: option 3.** ADR-0036 § Hotfix handling is amended (not replaced — branch source, naming format, and the back-propagation obligation stand). A PR targeting `main` whose head is not `dev` is permitted only when ALL of the following hold:

1. **Explicit maintainer authorization.** The carve-out applies only when the maintainer's instruction explicitly directs the fix at `main` or the stable channel (or names this carve-out). Generic urgency in the abstract ("this is important, ship it fast") is not authorization. An agent must never infer urgency or self-classify work as a stable hotfix — absent explicit authorization, the answer is always the normal `dev`-first flow.
2. **The `stable-hotfix` label** is applied to the PR. The label is the sole carve-out marker (the same single-marker discipline as the `artifact-review` carve-out) and the auditable record that the carve-out was invoked. It is the designed exception recognized by the #723 promotion-head guard: PRs to `main` with head ≠ `dev` and no `stable-hotfix` label fail the required check.
3. **Narrow eligibility.** Production-breaking defects in the stable channel and security fixes only. "Convenient shortcut," "small change, low risk," and "forgot to branch from `dev`" are explicitly ineligible.
4. **Same-working-day back-propagation.** The back-propagation PR into `dev` is opened the same working day the hotfix merges; the hotfix task is not complete until that back-propagation PR exists and cross-links the hotfix PR. The back-propagation merges the original fix branch into `dev` (preserving the shared SHA that `scripts/release.sh`'s `${LAST_TAG}..dev` version-range derivation depends on); because the repo auto-deletes head branches on merge, restore the branch or recreate it at the retained SHA (the hotfix merge commit's second parent) first. A cherry-pick is the fallback only when a direct merge is impossible, with the accepted cost that the next promotion's commit range re-lists the change.

The hotfix PR itself merges with a **merge commit**, like promotion PRs and for the same shared-ancestry reason. This is stated policy independent of current repository merge-method settings, so a future per-branch merge-method enforcement change (#420) must preserve merge-commit availability on `main`.

### Enforcement

- **Mechanical:** the #723 promotion-head-guard required check enforces conditions 2's presence (label) against the head-branch rule. Label add/remove events re-trigger the check.
- **Textual:** `scripts/validate.sh` § 4a extends its phrase set to guard the bounded carve-out wording in `agent/rules/github-flow.md` against regression, alongside the existing ADR-0036 phrases.
- **Self-report:** conditions 1 (authorization provenance), 3 (eligibility), and 4 (deadline) are convention. A CI back-propagation watchdog (flagging a merged hotfix with no `dev` back-merge PR after N hours) was considered and deferred — solo-maintainer blast radius does not currently justify the machinery; revisit if a deadline is ever missed.

## Consequences

### Positive

- Closes the unbounded direct-to-`main` permission structure while keeping a genuine emergency path one label and one explicit instruction away.
- Gives #723's guard a precise, auditable exception shape, so the mechanical gate can reject everything else without blocking real incidents.
- The label leaves a queryable audit trail of every carve-out invocation (`gh pr list --label stable-hotfix --state merged`).

### Negative / costs

- A real emergency requires two extra actions (explicit authorization wording + label). Accepted: both are seconds, and both are the audit trail.
- The back-propagation deadline and eligibility bar remain self-report until/unless a watchdog is added.
- **A hotfix merge bypasses `scripts/release.sh`'s pre-promotion gates.** Any merge to `main` auto-publishes via `sync-mirrors.yml` → `release.yml`, but only the `release.sh` promotion path runs the Phase 0 code-scanning gate (`check-mirror-alerts.sh`, ADR-0052/ADR-0057) and Phase 1.5 pin reconciliation (ADR-0098). A hotfix therefore publishes without them — a material gap precisely for the security-fix eligibility branch. Mitigation until a mechanical gate exists: the maintainer runs `scripts/check-mirror-alerts.sh` manually before merging a `stable-hotfix` PR. The mechanical closure is tracked in #473 (enforce the code-scanning gate as a required check on PRs targeting `main`), which would cover hotfix PRs automatically.

### Neutral

- ADR-0036 remains Accepted; only § Hotfix handling is amended by this ADR.
- Branch naming is unchanged: hotfix branches remain normal `fix/kebab-case` branches distinguished by base/target — plus, now, the label.

## More Information

Surfaces updated with this ADR: [`agent/rules/github-flow.md`](../agent/rules/github-flow.md) (bounded carve-out section and Merge Strategy), [`agent/AGENTS.md`](../agent/AGENTS.md) (GitHub Flow catalog row and Boundaries), `scripts/validate.sh` § 4a phrase set, `README.md` Architecture Decisions list. The `stable-hotfix` label was created in the repo when this ADR landed. The mechanical guard lands separately under #723.

**Sequencing against an in-flight promotion:** if a `dev` → `main` promotion PR is open when a hotfix becomes necessary, merge the hotfix first, then close the stale promotion PR and re-open it via `scripts/release.sh` so its commit range and version derivation account for the advanced `main`. The back-propagation PR is the only path by which the fix reaches `dev` — promotions flow one way (`dev` → `main`) and `main` is never merged back into `dev`.
