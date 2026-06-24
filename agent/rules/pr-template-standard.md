---
description: Standardize PR description structure across pi_config (Summary / Type / Test Plan / Checklist)
---

# PR Template Standard

Every PR opened against this repo follows a consistent section structure so review can focus on substance rather than re-deriving context.

## Required Sections

### Summary

Free-text description of what the PR does and **why**. The "why" is mandatory; the "what" is covered by the diff. Target 2-4 sentences. For multi-issue PRs include a small table mapping commits to closed issues.

### Type of Change

Implicit in the PR title (`<type>(<scope>): ...`) — see [`conventional-commits.md`](conventional-commits.md). A separate checklist is not required; the PR title is the source of truth and is also enforced by the squash-merge commit message.

### Test Plan

What the author did to verify the change works. **Do not delete this section even for trivial changes** — the explicit "no testable behaviour changed" entry is itself the evidence. Valid entries:

- `scripts/validate.sh` output (this repo's pre-PR check)
- `/review` verdict and a one-line summary per reviewer (code-review-expert, security-review-expert, linter)
- `markdownlint-cli2` output for prose-only changes
- For changes that touch the vendored `subagent` extension: `npm run typecheck` + smoke-test note
- "No testable behaviour changed" for pure documentation or comment edits

### Risk

One paragraph describing blast radius if the change is wrong. For config-only repos this is short — "Documentation-only, no code paths touched, no CI impact" is a valid entry when accurate. For substantive rule changes, name the agents/workflows the rule will affect.

## Optional Sections

Include when applicable. Delete when not.

- **Out of scope / follow-ups** — for any work explicitly deferred. Include issue numbers when filed.
- **Doc-sync pairs touched** — when the change updates one half of a sync pair (per `post-implementation-review.md`), confirm the other half is in the PR.
- **ADR reference** — for changes that implement or amend a decision recorded in `adrs/`.

## PR Title

The PR title is a valid Conventional Commits message: `<type>(<scope>): <description>`. It becomes the squash-merge commit message on `main`, so the same constraints apply (imperative, lowercase, no period, no leading punctuation per the semantic-PR-linter constraint in [`conventional-commits.md`](conventional-commits.md)).

## When This Rule Does Not Apply

- This repo does not maintain a `.github/PULL_REQUEST_TEMPLATE.md` file — the rule is enforced by convention, not by template auto-fill. Downstream repos in the ecosystem may choose to add one.
- Trivial single-line fixes where the PR body can be a single sentence — the "Summary" and "Test Plan" sections collapse to one line each but are still both present.
