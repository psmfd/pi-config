---
status: Accepted
date: 2026-08-14
---

# ADR-0141: repo-dash spawns git to scope the CI widget to the current branch

**Status:** Accepted — approved with the #1005 implementation plan on 2026-08-14.

**Amends** [ADR-0140](0140-repo-dash-ci-widget.md) § *Repository-wide, not branch-scoped*, and nothing else. Every other decision in ADR-0140 — opt-in via the user settings layer, the three-check idle gate, the 60-second floor, `agent_settled` as the edge trigger, backoff on every failure, and the finding that widget content sits outside the model's context — stands unchanged.

**Related:** [ADR-0137](0137-github-read-core-shared-extraction.md) (the argv-gated `gh` path this sits beside), [ADR-0120](0120-worktree-session-isolation.md) (per-session worktrees — the reason the branch is both ambiguous and awkward to read), [ADR-0088](0088-cross-extension-import-boundary.md) (why an existing git helper in another extension could not simply be imported).

## Context and Problem Statement

ADR-0140 shipped the CI widget repository-wide, deviating from what #987 asked for. That deviation was recorded as a **deferral with a named cause**, not a settled preference:

> Pi exposes the current git branch to extensions only through `ReadonlyFooterDataProvider`, which is handed exclusively to the factory passed to `ctx.ui.setFooter` — reading it means replacing the entire footer … The alternative is spawning `git rev-parse`, which is well-precedented elsewhere in this repo but would put repo-dash's *first* subprocess vector beyond the single gated `gh` path into the same change as its first background activity.

That was a sequencing argument. The widget has since landed and soaked; the remaining question is only whether repo-dash gives up its "one gated subprocess" property.

The value of scoping also grew rather than shrank on inspection. ADR-0120 puts **every** pi session in its own linked worktree, so several sessions routinely sit on different branches at once. "Which branch am I on" is not rhetorical here, and a repository-wide widget shows one session the CI results of another session's work.

## Decision Drivers

- **The property being given up should be named precisely.** "One subprocess" is not itself a security control; the control is that argv reaching a subprocess is not built from untrusted parts.
- **Branch detection must never break the widget.** It is a display refinement on a feature that already works.
- **Do not weaken the model-facing path to serve an operator-facing one.**
- **Prefer correctness over cleverness on git plumbing** — the worktree case is the common case here, not an edge case.

## Considered Options

| Option | Verdict |
| --- | --- |
| **Extension-local helper spawning `git rev-parse --abbrev-ref HEAD`** | **Chosen.** Constant argv, correct on worktrees and detached HEAD for free, fails soft. |
| Read `.git/HEAD` directly, no subprocess | Rejected — see below. Preserves the property absolutely but reimplements plumbing, and gets the *common* path wrong most easily. |
| Generalize `shared/github-read-runner.ts` into a `runCommand(bin, args)` | **Rejected firmly.** See below. |
| A new `shared/git-branch.ts` | Rejected for now. `shared/` is for cross-extension reuse; repo-dash is the only consumer, and `shared/` carries the ADR-0137 flatness constraint and closure-resolver implications. Promote it if a second consumer appears. |
| Import the existing helper from `git-read` or `worktree` | Not available. ADR-0088 gates cross-extension imports; only `shared/` is a legal path. |
| Ask upstream for a branch accessor on `ExtensionContext` | Still the cleanest long-term answer and not foreclosed; too slow to gate this on. A patch-train candidate under ADR-0138 if it soaks. |
| Close #1005 as won't-do | Rejected once ADR-0120's multi-worktree reality was weighed — the value is not as marginal as the issue's solo-maintainer framing suggested. |

### Why not generalize the `gh` runner

`runGh` hardcodes `spawn("gh", …)`, scrubs the environment to a `GH_`-shaped allowlist, and returns a `GhRunResult` carrying `authSource`. Parameterizing the binary would remove a structural guarantee from a module the **model** reaches through `github-read`: today the model-facing path cannot execute anything but `gh`, whatever else goes wrong. That narrowness is a feature, and trading it for code reuse in an operator-facing widget is the wrong direction. The new helper does its own small `spawn`.

### Why not read `.git/HEAD`

This was the option most worth wanting, since it adds no subprocess at all. It was rejected on evidence rather than principle: under ADR-0120 a pi session's `.git` is a **file** containing `gitdir: …/.git/worktrees/<name>`, not a directory — verified directly on this host — so worktree gitdir resolution is the *normal* path, and `GIT_DIR`, bare repositories, and parent-directory discovery remain unhandled after that. `rev-parse` gets all of it right.

## Decision Outcome

`agent/extensions/repo-dash/git-branch.ts` runs `git rev-parse --abbrev-ref HEAD` and returns the branch, or `undefined`. Three properties keep the new vector narrow:

1. **The argv is a constant.** Nothing interpolated, nothing operator- or attacker-influenced. The concern that motivates `assertReadOnlyPlan` on the `gh` path is argv *construction*; there is none here to get wrong.
2. **Every failure is soft.** Not a repository, no git on PATH, detached HEAD (`--abbrev-ref` prints the literal `HEAD`), timeout, or a name outside GitHub's ref grammar — all yield `undefined`, and the caller falls back to ADR-0140's repository-wide behaviour. stderr is discarded, so a non-repository session produces no noise.
3. **It runs once per session**, cached beside the repository, so it is not on the polling path. The cache is keyed on a resolved *flag* rather than on the value being non-undefined — an unscopable session legitimately resolves to `undefined`, and without the flag that would re-spawn `git` on every poll forever.

### The ref grammar is screened locally, on purpose

`validateRef` in `shared/github-read-validation.ts` **throws** on a name outside `REF_RE`. Left unscreened, a branch name that is perfectly legal in git but outside GitHub's accepted shape would reject the widget's `load`, trip the backoff, and show a permanently unavailable widget. The helper therefore mirrors `REF_RE` and returns `undefined` instead, degrading to an unscoped widget. **Keep the two patterns in lockstep.**

### Scoped-and-empty does not fall back

A scoped widget with no runs reports `no recent runs for <branch>` rather than reverting to the repository-wide list. Falling back would show one session another session's CI results under a widget the operator now reads as scoped — reintroducing, silently, the exact confusion scoping was added to remove. On a freshly pushed branch "no runs for this branch" is also the more useful statement.

### The `/ci` panel stays repository-wide

Only the widget is scoped. The panel is a browser whose purpose is referencing *any* run into the prompt — including a run on another branch — and narrowing it would remove reach the operator asked for by opening it. The widget is an ambient "how is my current work doing" indicator, and those are different questions.

## Consequences

**Good.** The widget answers the question #987 actually asked. Display needed no special case: scoping makes every row share a branch, so ADR-0140's existing per-entry `@branch` logic collapses on its own and the branch is reported once on the detail line. The real spawn path was verified on this host in all three shapes that matter — main checkout, a linked worktree where `.git` is a file, and a non-repository directory.

**Bad.** repo-dash now has two subprocess vectors instead of one, and the "everything goes through one argv-gated path" sentence is no longer true of the extension as a whole. The claim that survives is narrower and must be stated as such: *every GitHub read* goes through the gated path. Anyone auditing repo-dash now has two things to look at.

**Neutral.** `REF_RE` is duplicated rather than imported, adding a lockstep pair. Importing it would have been legal — `shared/` is a permitted path — but would pull the validation module's throwing contract into a fail-soft caller, which is the behaviour this deliberately avoids. The duplication is one line and is commented at both ends.
