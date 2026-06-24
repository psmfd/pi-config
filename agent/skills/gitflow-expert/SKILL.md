---
name: gitflow-expert
description: 'Git workflow reference for the gitflow-expert subagent — branching strategies (GitFlow, GitHub Flow, trunk-based), PR workflows, releases, commit conventions.'
disable-model-invocation: true
---

# Git Workflow Expert

Read-only reference for Git workflow guidance — branching strategies, merge strategies, commit conventions, release processes, and common anti-patterns.

Scope: branching strategy selection, branch naming conventions, merge strategies, commit message formatting, release and hotfix mechanics, and SemVer tagging. Out of scope: work item creation, issue triage, backlog management, sprint planning, and linking commits to issues or work items — route those to `work-item-management-expert`.

## Branching Strategies

### GitFlow

Five branch types: `main` (production-tagged), `develop` (integration target), `feature/*`, `release/*`, `hotfix/*`. Release branches carry only QA fixes and version bumps. Hotfixes branch from `main` and merge back to both `main` and `develop`.

**Use when:** Packaged/desktop/mobile software, 3+ concurrent product versions, 50+ developers, regulated industries requiring audit trails.

**Avoid when:** Continuous deployment, single production version, small teams — the overhead provides no benefit.

### GitHub Flow

Single long-lived branch (`main`, always deployable). All work happens in short-lived feature branches merged via PR. Merge triggers deployment.

**Use when:** SaaS/web apps with a single production version, teams of 5-15, mature CI/CD.

**Avoid when:** Multiple concurrent versions needed, or test coverage is weak.

### Trunk-Based Development

All developers commit to `main` at least daily. Branches live at most 1-2 days. Incomplete features hidden via feature flags, not branches. Maximum 3 active branches at any time.

**Use when:** High-performing DevOps teams, SaaS requiring rapid continuous deployment, mature feature flag infrastructure, baseline ~70% code coverage.

**Avoid when:** Team lacks testing discipline, no CI/CD pipeline, no feature flag infrastructure.

### Release Branching

`release/x.y` branches cut from `develop` (or `main`) to freeze scope while preparing for delivery. Only bug fixes, version bumps, and release notes go into release branches. Must merge back to both `main` and `develop` on completion.

**Use when:** Scheduled releases with parallel development of next version.

## Decision Framework

| Factor | GitFlow | GitHub Flow | Trunk-Based | Release Branching |
|---|---|---|---|---|
| Deployment model | Scheduled releases | Continuous / frequent | Multiple per day | Scheduled + hotfix |
| Team size | 50+ | 5-15 | Any (disciplined) | Medium+ |
| Test maturity | Moderate | High | Very high | Moderate |
| Version support | 3+ concurrent | Single | Single | 2+ concurrent |
| Complexity | High | Low | Very low | Moderate |
| CI/CD requirement | Moderate | High | Mandatory | Moderate |
| Feature flags needed | Rarely | Sometimes | Always | Rarely |

## Merge Strategies

### Comparison

| Strategy | History shape | Bisect-friendly | Reversibility | Best for |
|---|---|---|---|---|
| Merge commit | Preserves full branch topology | Yes (granular) | Easy per-commit revert | OSS, auditable history, full context |
| Squash merge | Single commit per feature | Poor (one large commit) | Easy per-feature revert | Clean log, one unit per feature |
| Rebase merge | Linear, all commits preserved | Yes (granular) | Easy per-commit revert | Linear log, solo/small team work |

### The Golden Rule of Rebase

Never rewrite history that has been shared. This is a correctness constraint, not a preference. Rebasing a branch that others have pulled creates divergent repositories.

- `git rebase main` onto a feature branch: safe only if the branch is private/unpushed
- `git merge main` onto a feature branch: always safe, adds merge commits

### Keeping a Feature Branch Current

| Approach | When to use |
|---|---|
| `git merge main` into feature | Branch is shared with others — non-destructive |
| `git rebase main` onto feature | Branch is private/local only — produces linear history |

## Commit Message Conventions

### The Seven Rules

1. Separate subject from body with a blank line
2. Subject line: 50-character target, 72-character hard limit
3. Capitalize the subject line
4. No trailing period on subject line
5. Use imperative mood: "Fix bug" not "Fixed bug"
6. Wrap body at 72 characters
7. Body explains what and why, not how

Commit messages must be concise and contain technical changes only. No authorship attributions at any time.

### Conventional Commits

Format: `<type>(<scope>): <description>`

| Type | Purpose | SemVer impact |
|---|---|---|
| `feat` | New feature | MINOR (x.Y.0) |
| `fix` | Bug fix | PATCH (x.y.Z) |
| `docs` | Documentation only | None |
| `style` | Formatting, no logic change | None |
| `refactor` | Code restructuring, no behavior change | None |
| `test` | Adding or updating tests | None |
| `chore` | Build, tooling, dependencies | None |
| `perf` | Performance improvement | None |
| `ci` | CI/CD configuration | None |
| `build` | Build system changes | None |
| `revert` | Reverting a previous commit | Depends on reverted type |

Breaking changes: append `!` before colon (`feat!: rename API`) or add `BREAKING CHANGE:` footer.

### Commit Atomicity

One logical change per commit. If a refactor is needed to implement a feature, they should be separate commits. Atomic commits enable `git bisect` and targeted `git revert`.

## Release and Hotfix Workflows

### GitFlow Release Cycle

1. Cut `release/x.y.z` from `develop` when feature freeze begins
2. Only fixes, version bumps, and release notes go into the release branch
3. On completion: merge to `main` (tag with version), then merge back to `develop`
4. If a release branch is active when a hotfix is needed, merge hotfix into the release branch — it flows to `develop` when the release closes

### Universal Hotfix Pattern

1. Branch from the tagged production commit on `main`, not from `develop`
2. Name: `hotfix/<issue-id>` or `hotfix/x.y.z+1`
3. After fix: merge to `main` (tag immediately), then merge to `develop` (or active release branch)
4. The tag is the deployable artifact, not the branch

### SemVer Alignment with Conventional Commits

- `fix` commits → PATCH bump (x.y.Z)
- `feat` commits → MINOR bump (x.Y.0)
- `BREAKING CHANGE` footer or `!` type → MAJOR bump (X.0.0)

Tools like `semantic-release` automate this derivation from Conventional Commits.

## Anti-Patterns

### Branch Lifecycle

- **Long-lived feature branches** — the most damaging anti-pattern. Branches exceeding a few days accumulate merge debt exponentially. Remedy: feature flags, smaller story decomposition.
- **Branch mania** — creating branches for no clear reason. Adds cognitive overhead without benefit.
- **Cascading branches** — branches that never merge back to mainline; creates permanent divergence.

### Merge

- **Big bang merge** — deferring all branch integration to end-of-cycle. Creates catastrophic integration events.
- **Wrong-way merge** — merging a newer branch into an older one accidentally. Causes regressions.
- **Merge paranoia** — avoiding merges out of fear. Causes divergence and duplicate work.

### Process

- **GitFlow for web apps** — applying a versioned-release model to a continuously deployed service. The overhead provides no benefit and slows delivery.
- **Environment branches** — using a branch per deployment environment (staging, prod) and promoting via merge. Merge conflicts introduce unintended changes. Correct model: same commit deployed to all environments, config externalized.
- **Rebase on shared branches** — rebasing rewrites SHAs. Any collaborator who fetched old SHAs will have a divergent repository.
- **Development freeze** — halting all development while merging/branching. The most costly process anti-pattern.

## Trade-Off Tables

### Branching Strategy Comparison

| Dimension | GitFlow | GitHub Flow | Trunk-Based |
|---|---|---|---|
| Long-lived branches | 2 (main + develop) | 1 (main) | 1 (main) |
| Supporting branches | feature, release, hotfix | feature only | very short-lived (optional) |
| Complexity | High | Low | Very low |
| Merge conflict exposure | High | Low | Minimal |
| Release cadence | Scheduled | Flexible | Continuous |
| Multi-version support | Excellent | None | None |
| Best team profile | Large, enterprise, regulated | Small-medium, SaaS | Disciplined, high-velocity |
