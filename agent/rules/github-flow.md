---
description: Use GitHub Flow with dev integration, main stable promotion, and protected long-lived branches
---

# GitHub Flow

This repo follows the lightweight two-branch GitHub Flow recorded in
[ADR-0036](../../adrs/0036-dev-integration-main-stable-branch-model.md):
short-lived topic branches integrate into `dev`, and deliberate promotions
advance the stable `main` branch.

## Branches

- **`dev`** is the integration branch. Normal feature, fix, documentation,
  maintenance, and CI branches are cut from `dev` and target `dev`.
- **`main`** is the stable release branch. It advances through a deliberate
  `dev` → `main` promotion PR opened by `scripts/release.sh`, except for a
  `stable-hotfix`-labeled urgent fix under the bounded carve-out below, which is
  propagated back to `dev` within the carve-out's same-working-day deadline.
- **Both long-lived branches are protected** by repository rulesets
  (`protect-dev`, `protect-main`) with no bypass actors — the rules bind the
  maintainer too (ADR-0102). Direct pushes are prohibited and
  required checks must pass: on `dev` — `validate`,
  `block-artifact-review-merge`, `verify`, and `lint-pr-title` (Conventional
  Commits PR-title lint, #731); on `main` — `validate`,
  `block-artifact-review-merge`, and `promotion-head-guard`. See
  [`AGENTS.md` Boundaries section](../AGENTS.md#boundaries) for the
  emergency unlock procedure.

## Branch Naming

`<type>/kebab-case-description` where `<type>` is a Conventional Commits type.

Valid prefixes: `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`, `ci/`, `style/`.

The description is lowercase kebab-case, 2-5 words, no ticket numbers unless the user explicitly asks. Examples: `feat/rule-updates-batch`, `chore/179-followup-warnings`, `docs/readme-workflow-diagrams`.

Do not use `hotfix/`, `release/`, or `dev/` prefixes. Urgent stable fixes use a
normal `fix/` branch cut from and targeted to `main` under the
[`stable-hotfix` carve-out](#carve-out-stable-hotfix-labeled-urgent-fixes)
below, followed by back-propagation to `dev` per the carve-out's
same-working-day deadline.

## Branch Lifecycle

1. Create normal work from `dev`: `git switch dev && git pull --ff-only && git switch -c <type>/description`
2. Keep branches short-lived. Target merge within 3 days. Branches open longer than 7 days are a review signal.
3. Open the topic PR against `dev`, not `main`.
4. After merge, delete the topic branch locally and remotely.

## Merge Strategy

- Normal topic PRs target `dev` and use **squash merge** — one commit per
  topic keeps the integration log scannable. (The `protect-dev` ruleset also
  permits merge commits, solely so ADR-0101 back-propagation PRs can merge
  the hotfix branch SHA-intact; do not use merge commits for ordinary topic
  PRs.) Every commit and PR title still
  follows [Conventional Commits](conventional-commits.md).
  - The merge method decides **which subject reaches `dev`**, and therefore
    which one `scripts/release.sh` reads. Under squash it is the PR title, so
    the required `lint-pr-title` check governs the bump. Under a merge commit
    it is the **branch commit subjects**, which that check never sees — the
    gap recorded in #1004. `commit-subject-advisory.yml` reports non-Conventional
    branch subjects as a **non-blocking** PR comment; it is deliberately not a
    required check, and merging past it is allowed. Squashing remains the way
    to make branch subjects irrelevant.
- Release promotion PRs target `main`, have `dev` as their head, and use a
  **merge commit** so the shared history is preserved. Open them through
  `scripts/release.sh`; do not open ordinary feature PRs to `main`.
- `stable-hotfix` carve-out PRs (head ≠ `dev`, target `main`) also use a
  **merge commit**, for the same shared-ancestry reason: the fix branch's SHA
  must remain mergeable into `dev` so `scripts/release.sh`'s
  `${LAST_TAG}..dev` version-range math stays correct on the next promotion.
  This is stated policy, not an artifact of current repository settings.
- Do not use rebase merge. Do not squash a `dev` → `main` promotion.

Every merge to `main` is a release boundary: `sync-mirrors.yml` publishes the
mirrors and a successful sync triggers `release.yml` to tag and publish the
release. Bypassing `scripts/release.sh` also bypasses its pre-promotion mirror
and pin-reconciliation gates.

## Carve-out: `artifact-review`-labeled draft PRs

Draft PRs carrying the `artifact-review` label are an explicit exception to the
normal topic-PR flow: they exist solely as a Tier 3 review surface for long
single-file artifacts (per
[ADR-0006 § Tiered transport ladder](../../adrs/0006-artifact-handoff-and-review-format.md#tiered-transport-ladder),
payload path resolved by
[ADR-0007](../../adrs/0007-tier-3-payload-path.md) as `.review/<topic>.md`) and
**must never be merged**. Tier 3 is opt-in — the orchestrator escalates only on
explicit user request. Convergence is signaled by
`gh pr close --delete-branch`; the artifact lands via a separate normal PR.
The `artifact-review` label is the sole carve-out marker — branch naming follows
the standard `<type>/kebab-case-description` rule above. Enforcement: the
`.github/workflows/artifact-review-guard.yml` workflow fails any
`artifact-review`-labeled PR; `CODEOWNERS` on `.review/**` is a
belt-and-suspenders second policy surface.

## Carve-out: `stable-hotfix`-labeled urgent fixes

PRs targeting `main` with a head other than `dev` are prohibited except under
this carve-out, recorded in
[ADR-0101](../../adrs/0101-bounded-stable-hotfix-carveout.md) (amending
[ADR-0036 § Hotfix handling](../../adrs/0036-dev-integration-main-stable-branch-model.md#hotfix-handling)).
All four conditions are required:

- **Explicit maintainer authorization.** The carve-out applies only when the
  maintainer's instruction explicitly directs the fix at `main` or the stable
  channel (or names this carve-out). Generic urgency — "this is important,
  ship it fast" — is not authorization. An agent
  must never infer urgency or self-classify work as a stable hotfix — absent
  explicit authorization, use the normal `dev`-first flow.
- **The `stable-hotfix` label** on the PR is the sole carve-out marker and the
  auditable record of invocation. It is the designed exception for the
  promotion-head guard (#723): an unlabeled PR to `main` whose head is not
  `dev` fails the required check.
- **Narrow eligibility.** Production-breaking defects in the stable channel
  and security fixes only. "Convenient shortcut," "small change, low risk,"
  and "forgot to branch from `dev`" are ineligible.
- **Same-working-day back-propagation.** Open the back-propagation PR into
  `dev` the same working day the hotfix merges. Merge the original fix branch
  into `dev` — that preserves the shared SHA that `scripts/release.sh`'s
  `${LAST_TAG}..dev` version-range math depends on. When merging the
  back-propagation PR, select **Create a merge commit**, not squash — the
  `protect-dev` ruleset permits both, and a squash here silently defeats the
  SHA preservation this condition exists for. The repo auto-deletes head
  branches on merge — restore the branch (GitHub's "Restore branch") or
  recreate it at the retained SHA (the hotfix merge commit's second parent)
  before opening the back-propagation PR. Cherry-pick only when a
  direct merge is impossible, accepting that the next promotion's range
  re-lists the change. The hotfix is not complete
  until the back-propagation PR exists and cross-links the hotfix PR.

Before merging a `stable-hotfix` PR, run `scripts/check-mirror-alerts.sh`
manually — a hotfix merge bypasses `release.sh`'s Phase 0 code-scanning gate
(ADR-0101 Consequences; mechanical closure tracked in #473).

## What This Rule Does Not Cover

- **Commit message format** is covered by [`conventional-commits.md`](conventional-commits.md).
- **Review gates** are covered by [`post-implementation-review.md`](post-implementation-review.md).
- **PR body structure** is covered by [`pr-template-standard.md`](pr-template-standard.md).
