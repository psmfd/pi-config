---
status: Accepted
date: 2026-07-15
---

# ADR-0102: migrate branch protection to repository rulesets

**Status:** Accepted
**Date:** 2026-07-15
**Closes:** #420
**Supersedes (in part):** [ADR-0056](0056-branch-protection-model.md) — the mechanism record only (classic branch protection); ADR-0056's `verify`-gate requirement carries forward unchanged into the rulesets
**Related:** [ADR-0036](0036-dev-integration-main-stable-branch-model.md) (branch model; its deferred default-branch decision is recorded here), [ADR-0101](0101-bounded-stable-hotfix-carveout.md) (stable-hotfix carve-out whose back-propagation mechanics constrain `dev`'s merge methods), #591, #723

## Context and Problem Statement

ADR-0056 recorded classic branch protection as sufficient, judging rulesets "thin payoff" because admins were covered by `enforce_admins` and merge methods were constrained repo-wide. Two things changed:

1. **The repo-wide merge-method constraint became the problem.** Classic protection has no per-branch merge-method concept, so the repo-level settings (`allow_squash_merge: false`, `allow_merge_commit: true`) applied to both branches. Result: ordinary topic PRs into `dev` merge with merge commits — drift from the intended squash-per-topic integration log — because permitting merge commits for `dev` → `main` promotions forced permitting them everywhere. Rulesets' per-branch `allowed_merge_methods` is the only mechanism that can express the split policy.
2. **The PR #720 incident hardened the model.** ADR-0101 and the `promotion-head-guard` required check (#723) now bound and mechanically enforce what may target `main`. Registering that check once, in a ruleset that also owns the merge-method policy, removes the last reason to keep two protection mechanisms in mind.

The org is on GitHub Enterprise Cloud, where rulesets — including `allowed_merge_methods` — are fully available on private repos. No plan barrier exists.

## Considered Options

1. **Keep classic branch protection.** Rejected — cannot express per-branch merge methods, which is now the load-bearing gap. Everything else classic does, rulesets also do.
2. **Migrate to repository rulesets** (`protect-dev`, `protect-main`, no bypass actors). Chosen.
3. **Hybrid: classic protection plus convention for merge methods.** Rejected — convention already failed once (#720); a policy GitHub can enforce mechanically should be.

## Decision Outcome

**Chosen: option 2.** Two repo-level rulesets, staged in `evaluate` mode (observed against real `dev` PRs first), then activated **together in one sitting** alongside the repo-level merge-toggle change — bundled activation, not branch-at-a-time, because the repo-wide `allow_squash_merge` toggle would otherwise expose `main` to squash merges while `protect-main` was still log-only (see Cutover procedure). Classic protection is deleted only after the active rulesets are verified against a real PR.

### Ruleset contents

**`protect-dev`** (`conditions.ref_name.include: ["refs/heads/dev"]`):

- `pull_request` — 0 required approvals; `allowed_merge_methods: ["squash", "merge"]`. Squash is the method for ordinary topic PRs; **merge commits stay allowed because ADR-0101's back-propagation PRs must merge the original hotfix branch into `dev` SHA-intact** — a squash would mint a new SHA and defeat the shared-ancestry design. Policy text in `agent/rules/github-flow.md` assigns which method each PR shape uses; the ruleset enforces the outer envelope.
- `required_status_checks` — strict (branch must be up to date): `validate`, `block-artifact-review-merge`, `verify` (carried forward from ADR-0056).
- `deletion`, `non_fast_forward`.
- **No `required_linear_history`** — back-propagation merge commits are a designed feature of `dev` history (and classic protection did not require it either).

**`protect-main`** (`conditions.ref_name.include: ["refs/heads/main"]`):

- `pull_request` — 0 required approvals; `allowed_merge_methods: ["merge"]` (promotion PRs and stable-hotfix PRs both use merge commits per ADR-0101).
- `required_status_checks` — strict: `validate`, `block-artifact-review-merge`, `promotion-head-guard`.
- `deletion`, `non_fast_forward`.

**No bypass actors on either ruleset** — the rules bind the solo maintainer too, matching the `enforce_admins: true` posture being replaced.

### Repo-level prerequisites

`allowed_merge_methods` is a ceiling under the repo-level toggles, so the repo settings change to `allow_squash_merge: true`, `allow_merge_commit: true`, `allow_rebase_merge: false`, and `squash_merge_commit_title: PR_TITLE` (the pre-migration value was `COMMIT_OR_PR_TITLE`; pinning `PR_TITLE` makes the Conventional-Commits-shaped PR title the squash commit subject that `scripts/release.sh`'s `classify_bump` reads). Because a squash-merged topic PR's title becomes the *sole* version-derivation signal for that PR, PR-title format enforcement is a tracked follow-up: #731.

The repo-level toggles are repo-wide — they cannot be scoped to `dev` — and classic branch protection has no merge-method concept at all. Enabling squash therefore also exposes `main` to squash-merging until `protect-main` is `active`. The cutover procedure below closes that window by flipping the toggles and activating both rulesets in the same sitting.

### Default branch

The GitHub default branch is now **`dev`** (flipped under #591). ADR-0036 deferred this call to rollout; this ADR records it: `gh pr create` and the compare UI now target the integration branch by default, closing the dominant mistargeting path, while the `promotion-head-guard` check remains the mechanical backstop. The public mirror (`psmfd/pi-config`) has its own independent default branch and is unaffected — mirror publishing keys off merges to `main`, not the default-branch setting.

### Cutover procedure

1. Create both rulesets with `enforcement: "evaluate"` (log-only; Rule Insights shows what would have been blocked).
2. Verify a real PR against `dev` runs clean under evaluate mode (Rule Insights shows no would-block entries for a compliant PR).
3. **In one sitting, with no PR to `main` merged in between:** PATCH the repo-level merge toggles (`allow_squash_merge=true`, `squash_merge_commit_title=PR_TITLE`, `allow_merge_commit=true`, `allow_rebase_merge=false`), then immediately flip `protect-dev` and `protect-main` both to `active`. This closes the window in which `main` would accept a squash merge with no mechanical backstop (see Repo-level prerequisites).
4. Verify a topic PR squash-merges into `dev` cleanly under the active ruleset.
5. Delete classic branch protection from `dev`, then `main`. Running both simultaneously is safe (GitHub applies the union), but leaving stale classic config recreates the dual-source-of-truth confusion ADR-0056 § Context names.
6. Update `agent/AGENTS.md` Boundaries — the emergency unlock procedure changes from the classic `enforce_admins` toggle to disabling the ruleset (`gh api --method PUT repos/psmfd/pi-config/rulesets/<id> -f enforcement=disabled`, re-enable with `-f enforcement=active`). Partial-body `PUT` semantics verified live 2026-07-15: sending only `enforcement` preserves the ruleset's rules, conditions, and merge-method envelope.

Any PR open across the evaluate→active flip inherits the strict up-to-date requirement against a base that may have advanced — expect a branch update and check re-run before it can merge.

## Consequences

### Positive

- `dev` regains a squash-per-topic log while back-propagation merges stay possible — the split policy classic protection could not express.
- One protection mechanism, with `promotion-head-guard` registered in it; parity with the maintainer's framework convention.
- `evaluate` mode makes the cutover observable before it is enforcing.

### Negative / costs

- One-time cutover risk on live protected branches — mitigated by evaluate-mode staging (observed on `dev` first), bundled same-sitting activation of both rulesets with the merge-toggle change, and post-activation verification with real PRs before classic protection is deleted.
- The Boundaries unlock procedure changes; anyone following the old `enforce_admins` toggle after cutover will hit a 404 (the classic protection object is gone).

### Neutral

- The `verify` required check and its always-run trigger rationale (ADR-0056) are unchanged.
- Squash-method discipline on `dev` for topic PRs vs merge for back-propagation remains policy-assigned (rule text), mechanically bounded (ruleset envelope) — GitHub cannot distinguish PR shapes within one branch target.

## More Information

Surfaces updated with this ADR: `agent/rules/github-flow.md` (Merge Strategy — topic PRs squash; Branches — ruleset protection phrasing; carve-out — merge-method reminder), `agent/AGENTS.md` (Boundaries unlock procedure), `README.md` (Architecture Decisions list). ADR-0056 is marked superseded in part (mechanism record only; its `verify`-gate requirement carries forward unchanged). Enforcement state and ruleset IDs live in GitHub settings; `gh api repos/psmfd/pi-config/rulesets` is the source of truth.
