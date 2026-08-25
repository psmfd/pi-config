---
name: review
description: Three-reviewer serial sequence — code-review-expert, security-review-expert, then linter — synthesized into one verdict.
---

# /review

Run the standard three-lens review as one deterministic serial sequence.

## Step 1 — Scope

Use a user-supplied base or default to the current branch against `dev` (`main` only when appropriate). Confirm the branch and commits. Every semantic reviewer brief must include an explicit `Source path:` and revision range.

## Step 2 — Execute the sequence

Invoke `subagent` once. Every item below includes the complete Form B return contract because child context files are suppressed.

```json
{
  "sequence": [
    {
      "agent": "code-review-expert",
      "task": "Review <base>..HEAD. Source path: <absolute-repo-path> (revision: <base>..HEAD). Produce structured findings and verdict. Return Form B: open a fenced block with three backticks followed by report, place the complete report inside, close with three backticks, then output Summary: <one line> and Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE."
    },
    {
      "agent": "security-review-expert",
      "task": "Security review <base>..HEAD. Source path: <absolute-repo-path> (revision: <base>..HEAD). Map trust boundaries and cite first-party sources. Return Form B: open a fenced block with three backticks followed by report, place the complete report inside, close with three backticks, then output Summary: <one line> and Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE."
    },
    {
      "agent": "linter",
      "task": "Lint changed files in <base>..HEAD under <absolute-repo-path> in report-only mode. Return Form B: open a fenced block with three backticks followed by report, place the complete report inside, close with three backticks, then output Summary: <one line> and Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE."
    }
  ]
}
```

The order is code → security → lint. Items are independent: do not expose earlier findings to later reviewers. Continue after a failed reviewer and report incomplete coverage.

## Step 3 — Synthesize

Merge findings into `Severity | Source | File | Line | Finding`, deduplicate overlaps, preserve attribution, and apply most-severe-wins:

- any `NEEDS_CHANGES` → `NEEDS_CHANGES`;
- otherwise any `PASS_WITH_WARNINGS` → `PASS_WITH_WARNINGS`;
- otherwise `PASS`.

`PRECONDITION_FAILURE` marks coverage incomplete without replacing substantive verdicts. Include an Agent Efficacy Report after all three items finish. Never mutate files during this workflow.
