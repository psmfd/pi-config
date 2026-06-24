---
description: Use GitHub Flow branching with main as integration, squash merge for features, branch protection on main
---

# GitHub Flow

This repo follows GitHub Flow: short-lived feature branches merged via PR into a single integration branch.

## Branches

- **`main`** is both the integration branch and the stable branch. Feature branches target `main` via pull request. This is canonical GitHub Flow (no separate `dev` branch).
- **`main` is branch-protected** with `enforce_admins: true` — required status checks (`validate`) cannot be bypassed even by repo admins. See [`AGENTS.md` Boundaries section](../AGENTS.md) for the unlock procedure if a required-check misconfiguration ever locks the repo.

Some downstream repos in this ecosystem use a `dev` integration branch with `main` reserved for release promotion. That pattern is also valid GitHub Flow; this repo's choice is the simpler one because there is no release artifact (`pi_config` is consumed via `git clone` + `setup.sh`).

## Branch Naming

`<type>/kebab-case-description` where `<type>` is a Conventional Commits type.

Valid prefixes: `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`, `ci/`, `style/`.

The description is lowercase kebab-case, 2-5 words, no ticket numbers unless the user explicitly asks. Examples: `feat/rule-updates-batch`, `chore/179-followup-warnings`, `docs/readme-workflow-diagrams`.

Do not use `hotfix/`, `release/`, or `dev/` prefixes. All work follows the same branch-PR-merge flow regardless of urgency.

## Branch Lifecycle

1. Create from `main`: `git switch main && git pull && git switch -c <type>/description`
2. Keep branches short-lived. Target merge within 3 days. Branches open longer than 7 days are a review signal.
3. After merge, delete the branch (local and remote). `gh pr merge --squash --delete-branch` handles both.

## Merge Strategy

All PRs to `main` use **squash and merge**. The squash commit message defaults to the PR title (per repo settings), so the PR title must be a valid Conventional Commits message — see [`conventional-commits.md`](conventional-commits.md).

Do not use rebase merge. Do not use merge commits. This repo has no release-promotion branch that would benefit from preserved-SHA merges.

## Carve-out: `artifact-review`-labeled draft PRs

Draft PRs carrying the `artifact-review` label are an explicit exception to the squash-merge-to-`main` rule above: they exist solely as a Tier 3 review surface for long single-file artifacts (per [ADR-0006 § Tiered transport ladder](../../adrs/0006-artifact-handoff-and-review-format.md#tiered-transport-ladder), payload path resolved by [ADR-0007](../../adrs/0007-tier-3-payload-path.md) as `.review/<topic>.md`) and **must never be merged**. Tier 3 is opt-in — the orchestrator escalates only on explicit user request. Convergence is signaled by `gh pr close --delete-branch`; the artifact lands via a separate normal PR. The `artifact-review` label is the sole carve-out marker — branch naming follows the standard `<type>/kebab-case-description` rule above. Enforcement: the `.github/workflows/artifact-review-guard.yml` workflow fails any `artifact-review`-labeled PR and is a required status check on `main`; `CODEOWNERS` on `.review/**` is a belt-and-suspenders second policy surface.

## What This Rule Does Not Cover

- **Commit message format** is covered by [`conventional-commits.md`](conventional-commits.md).
- **Review gates** are covered by [`post-implementation-review.md`](post-implementation-review.md).
- **PR body structure** is covered by [`pr-template-standard.md`](pr-template-standard.md).
