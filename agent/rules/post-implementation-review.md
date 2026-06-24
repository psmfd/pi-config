---
description: Run a review pass after each task and again before opening a PR; couple review completion to work-item state transitions
---

# Post-Implementation Review

This rule defines a three-tier review gate: a **per-task gate** that runs after each work item completes, a **pre-PR gate** that runs once before opening or updating the PR, and a **post-merge cleanup** step that verifies the merge landed before any branch deletion or follow-up issue closure. All three apply to substantive implementation work. Trivial single-line fixes, typo corrections, and documentation-only edits are exempt.

## Per-Task Gate

After completing the work for an individual task (GitHub Issue or other ticket), and **no later than before starting the next task, transitioning the ticket to Closed, or invoking `gh pr create` — whichever comes first**:

- **Run the `linter` subagent** on files changed by this task.
- **Verify tests pass** for the affected scope, where the project has a test suite. Do not skip failing tests — investigate and fix or flag them.
- **Self-review the diff** for unintended modifications, leftover debug code, or missed requirements.
- **Update documentation sync pairs** — when a change touches one of these surfaces, the paired surfaces must be updated in the same task:

  | If you change… | Also update |
  |---|---|
  | A skill (`agent/skills/<name>/SKILL.md`) | `README.md` skill list / table; `agent/AGENTS.md` skill catalog (if listed) |
  | An agent wrapper (`agent/agents/<name>.md`) | `agent/AGENTS.md` agent catalog (regenerate via `scripts/regen-agent-catalog.sh`); `README.md` if the agent is mentioned |
  | A prompt template (`agent/prompts/<name>.md`) | `agent/AGENTS.md` workflows section (if listed); `README.md` workflow table |
  | A rule (`agent/rules/<name>.md`) | `agent/AGENTS.md` if the rule is inlined or referenced from there |
  | A vendored extension (`agent/extensions/<name>/`) | Note the source-pi version in the commit message |
  | An extension TypeScript file (`agent/extensions/**/*.ts`) | Run `./scripts/typecheck-extensions.sh` and `./scripts/lint-extensions.sh` (or umbrella `./scripts/validate.sh`); zero errors required. New extension dir requires its own `tsconfig.json` per ADR-0021 |
  | The eslint flat config (`eslint.config.js`) or extension-deps versions (`scripts/lib/extension-deps.sh`) | `agent/rules/extension-type-check-and-lint.md` if the rule contract changes |
  | An ADR (`adrs/<n>-<name>.md`) | `README.md` Architecture Decisions list |
  | `setup.sh` (new symlinks, migration steps) | `README.md` "Setup on a new machine" section |

- **Transition the ticket to Closed (or equivalent)** only after the gates above pass. Ticket state must reflect actual delivery progress in real time, not be batched until PR merge.

## Pre-PR Gate

Once all tasks for the PR are complete, **no later than immediately before the `gh pr create` / `gh pr ready` invocation that publishes the PR** (or, on an already-open PR, before pushing the final commit that will trigger merge):

- **Run `scripts/validate.sh`** if it exists and the change touches skills, agents, prompts, rules, or extensions. Required checks must actually run: environment-unavailable or missing-script paths for required suites are validation failures, not acceptable skips.
- **Run `/review`** (the 3-way parallel review workflow) on the aggregate diff.
- **Re-review the aggregate diff** for cross-task drift — file conflicts, README aggregation issues, doc-sync pairs touched by multiple tasks.
- **Confirm every task in the PR has its per-task gate evidence** (linter clean, tests passing, ticket Closed or queued for closing-on-merge).

### Auto-Merge Race

If the target repo has auto-merge configured (an auto-merge GitHub Action, branch-protection auto-merge, or any mechanism that merges a PR the instant required checks turn green), the `/review` pass races the merge. We have observed in production:

1. PR opened, CI starts.
2. `/review` subagents fan out in parallel — typically 1-3 minutes.
3. CI completes (faster than `/review` for small PRs).
4. Auto-merge fires.
5. `/review` returns with `NEEDS_CHANGES` or `PASS_WITH_WARNINGS` findings — too late, the PR is already on the integration branch.

The `/review` findings must not be silently dropped. Choose one of the three techniques **before** opening the PR:

- **Open the PR as `--draft`** until `/review` returns and any required fixups are pushed. Then `gh pr ready <N>` to allow auto-merge to fire. **This is the preferred technique for user-owned repos** — it eliminates the race rather than racing it.
- **Withhold the CI-completing commit**: if a PR must be open for review-tool reasons but auto-merge is configured, leave the final commit that would satisfy CI requirements unpushed locally; run `/review` against the partially-pushed state (CI failing, auto-merge dormant); push the squashed resolution commit only when `/review` is in hand. Brittle — only use when draft-first is unavailable (e.g. an org policy that disables draft PRs).
- **Accept follow-up debt**: if the race fires anyway, open a clearly-labelled follow-up PR (e.g. `chore(...): address PR #<n> review warnings`) immediately and land it the same session. Do not advance to the next task until the follow-up is merged.

For repos under the user's own control, always prefer the draft-first approach.

## Post-Merge Cleanup

After a PR is reported merged — by CI, by another collaborator, or by the user — **verify the merge against the server before any destructive cleanup** (branch deletion, working-tree reset, follow-up issue closure). "Reported merged" is not the same as merged.

- **Verify with the API, not the human report.** Run:

  ```bash
  gh pr view <N> --repo <owner>/<repo> --json state,mergedAt,mergeCommit \
    -q '{state, mergedAt, mergeCommit: .mergeCommit.oid}'
  ```

  Required outcome: `state: "MERGED"`, `mergedAt` non-null, `mergeCommit` non-null. A `state: "CLOSED"` with `mergedAt: null` means the PR was closed without merging (common cause: misclick of "Close" instead of "Merge" — the buttons are adjacent in the GitHub UI).

- **Verify the merge commit landed on the target branch.** `git fetch origin <base>` then `git log --oneline origin/<base> -3` should show the merge commit (squash or merge) at HEAD. If it doesn't, the PR merged into a different base than expected — stop and reconcile.

- **Only then perform cleanup:** local fast-forward, local branch delete, remote branch delete, follow-up issue updates that assert the change is live.

- **If a premature cleanup happened**, branch commits are recoverable from GitHub's preserved PR ref:

  ```bash
  git fetch origin pull/<N>/head:<branch>
  git push origin <branch>     # restore the remote ref
  gh pr reopen <N> --repo <owner>/<repo>   # if needed
  ```

  Reflog (`git reflog`) holds the local refs for ~90 days as a secondary safety net.

## When This Rule Does Not Apply

- Documentation-only edits, single-line fixes, or configuration changes where no test suite exists.
- PRs that deliver a single task — the per-task gate and pre-PR gate collapse into one review pass.
