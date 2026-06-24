---
status: Accepted
date: 2026-06-12
---

# ADR-0036: dev as integration branch, main as protected stable branch

**Status:** Accepted
**Date:** 2026-06-12
**Tracking issue:** none — adopted via decision PR
**Related:** [`agent/rules/github-flow.md`](../agent/rules/github-flow.md), [`agent/AGENTS.md`](../agent/AGENTS.md), [ADR-0012](0012-vendored-pi-default.md) (stable vendored-default posture), [`README.md`](../README.md), [`.github/workflows/validate.yml`](../.github/workflows/validate.yml)

## Context and Problem Statement

This repo currently documents a single-branch GitHub Flow model where **`main` is both the integration branch and the stable branch**. In practice, the maintainer standard for this ecosystem is different: **`dev` is the day-to-day integration branch and `main` is the protected stable branch** promoted from `dev`.

That mismatch is now load-bearing.

- New implementation planning for the pi build-and-attest mirror assumed `dev` as the integration target.
- Current repo policy text in [`agent/rules/github-flow.md`](../agent/rules/github-flow.md) and the generated synopsis in [`agent/AGENTS.md`](../agent/AGENTS.md) still say `main` is the integration branch.
- Workflow and protection assumptions keyed only to `main` risk leaving the actual integration branch under-protected once work starts landing there.

This repo is not a packaged library with a formal release train; it is primarily consumed from git plus `setup.sh`. Even so, it benefits from separating **ongoing integration** from the **stable branch consumers clone by default**. The repo therefore needs an explicit recorded decision for branch roles, promotion flow, hotfix handling, and branch protection expectations.

## Considered Options

1. **Keep single-branch GitHub Flow on `main`.**
   Rejected. This conflicts with the maintainer's standard operating model and with the intended implementation flow for upcoming work. It also removes the stable-buffer role that `main` is meant to serve.

2. **Adopt a lightweight two-branch model: `dev` for integration, `main` for stable promotion.**
   Chosen. This matches the maintainer standard while keeping process overhead low: short-lived topic branches, deliberate promotion to `main`, and no permanent release branches.

3. **Adopt full GitFlow with long-lived `develop`, `release/*`, and `hotfix/*` branches.**
   Rejected. This repo does not need that level of ceremony. A permanent release-branch layer would add branch-management cost without clear operational payoff.

## Decision Outcome

**Chosen: option 2 — use `dev` as the integration branch and `main` as the protected stable branch.**

### Branch roles

- **`dev`** is the integration branch for normal work.
  - Feature/fix/docs/chore branches are cut from `dev`.
  - Normal pull requests target `dev`.
- **`main`** is the protected stable branch.
  - `main` is the branch consumers should treat as the stable channel.
  - `main` advances only by deliberate promotion from `dev` or by urgent stable-branch fixes.

### Normal development flow

1. Create a short-lived topic branch from `dev` using the existing `<type>/kebab-case-description` naming convention.
2. Open the pull request against `dev`.
3. Merge topic branches into `dev` using the repo's standard PR flow.
4. When `dev` is ready for stabilization, open a **promotion PR** from `dev` to `main`.
5. Merge the promotion PR to advance `main`.

### Promotion semantics

- Promotion from **`dev` → `main`** is the mechanism for publishing a new stable snapshot of the repo.
- Promotion PRs must pass the same required checks as any other protected-branch PR, plus any additional stable-branch checks introduced later.
- Tags, when used, are created from **`main`** only.
- `dev` is an integration channel, not a release/stable channel.

### Hotfix handling

- Urgent fixes required on the stable branch start from **`main`**, not `dev`.
- The branch naming convention remains the existing `<type>/kebab-case-description` format; urgent fixes are distinguished by **their base and target branch**, not by a separate mandatory prefix.
- After a hotfix lands on `main`, it must be propagated back into `dev` immediately via PR or cherry-pick so the branches do not diverge.

### Protection expectations

- **Both `dev` and `main` are protected branches.**
- **`dev`** must carry the validation and review gates required for safe integration work.
- **`main`** remains the more tightly controlled stable branch, including admin-enforced protections where the repo policy requires them.
- No direct pushes to either long-lived branch.
- Workflow triggers and required checks must follow the actual branch roles so the integration branch is never less protected than the stable branch.

### Scope of this ADR

This ADR records the **branching convention and promotion model**. Follow-up implementation work will update:

- repository settings and branch protection
- workflow branch filters and required checks
- contributor-facing documentation and rule text
- any automation or runbooks that currently assume `main` is the integration branch

Whether the GitHub **default branch** remains `main` or later changes to `dev` is an implementation decision to be evaluated explicitly during rollout. This ADR only fixes the canonical **integration** and **stable** branch roles.

## Consequences

### Positive

- Aligns the repo with the maintainer's standard branch model.
- Restores a clear stable-channel role for `main` while allowing normal work to integrate on `dev`.
- Creates a clean promotion boundary for larger efforts, including the pi mirror implementation.
- Makes branch-role expectations explicit for workflows, protections, and contributor guidance.

### Negative / costs

- Existing docs and automation that assume `main` as the integration branch will need coordinated updates.
- Promotion from `dev` to `main` becomes an explicit operational step that maintainers must manage.
- Urgent fixes now require disciplined propagation from `main` back to `dev` to avoid branch drift.

### Neutral / non-goals

- This is **not** full GitFlow; the repo does not adopt standing `release/*` branches.
- This ADR does not change Conventional Commits, branch naming format, PR body standards, or ADR requirements.
- This ADR does not by itself change release/versioning policy beyond establishing that stable tags, when used, originate from `main`.

## More Information

Implementation work following this ADR should minimally touch:

- [`agent/rules/github-flow.md`](../agent/rules/github-flow.md)
- [`agent/AGENTS.md`](../agent/AGENTS.md)
- [`README.md`](../README.md) (Architecture Decisions list and any workflow guidance)
- [`.github/workflows/validate.yml`](../.github/workflows/validate.yml)
- any branch protection or required-check settings in GitHub repo configuration

The pi mirror planning document that surfaced this mismatch should reference this ADR once accepted.
