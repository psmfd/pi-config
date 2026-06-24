---
name: full-review
description: Four-way parallel review — code + security + linter + checkmarx. Use when a Checkmarx One environment is configured and you want SAST/SCA/IaC scanning alongside semantic review.
---

# /full-review

Run a comprehensive review using all four specialist subagents in parallel: `code-review-expert`, `security-review-expert`, `linter`, and `checkmarx-expert`.

Use this when:

- A Checkmarx One environment is authenticated and configured (`cx --version` works)
- The change is large enough to warrant SAST/SCA/IaC scanning in addition to semantic review
- You want the most comprehensive read-only assessment possible before merge

For routine PRs, prefer `/review` (3-way, no scanner dependency).

## Pre-flight check

Before invoking, verify Checkmarx is available:

```bash
cx --version 2>&1
```

If `cx` is missing or unauthenticated, **fall back to `/review`** and tell the user. Do not attempt the four-way fan-out without `cx`.

## Step 1 — Identify scope

Same as `/review`: respect a user-supplied base ref, otherwise default to current branch vs `dev`/`main`. Surface scope before fanning out.

## Step 2 — Fan out via the subagent tool

Invoke the `subagent` tool once in parallel mode with all four agents. Note: parallel mode is capped at 8 tasks / 4 concurrent — four reviewers fits comfortably.

```json
{
  "tasks": [
    { "agent": "code-review-expert", "task": "Review the diff <base>..HEAD in <repo-path>. Source path: <absolute-repo-path> (revision: <base>..HEAD). …" },
    { "agent": "security-review-expert", "task": "Security review of <base>..HEAD in <repo-path>. Source path: <absolute-repo-path> (revision: <base>..HEAD). …" },
    { "agent": "linter", "task": "Lint changed files in <base>..HEAD in <repo-path>. …" },
    { "agent": "checkmarx-expert", "task": "Run cx scan against <repo-path> appropriate for the languages present. Report Critical/High findings with file:line and triage notes." }
  ]
}
```

The `Source path:` line in `code-review-expert` and `security-review-expert` briefs is mandatory per `agent/rules/research-parallelism.md` § Ground-Truth Source Precondition; without it the subagent will return `PRECONDITION_FAILURE` and the fan-out will need to be re-issued.

## Step 3 — Synthesize the merged report

Same shape as `/review`'s merged report, with a fourth `Source` column value (`checkmarx (sast)`, `checkmarx (sca)`, `checkmarx (kics)`, `checkmarx (scs)`).

````markdown
# Full Review Summary

**Scope:** `<base-ref>..HEAD` (`<n>` commits, `<m>` files)
**Reviewers:** code-review-expert, security-review-expert, linter, checkmarx-expert

## Merged Findings

| Severity | Source | File | Line | Finding |
| --- | --- | --- | --- | --- |
| Critical | checkmarx (sast) | src/db.py | 88 | SQL Injection — taint flow from request.args to cursor.execute |
| Error | security-review | src/auth.cs | 42 | … |
| Warning | linter (markdownlint) | README.md | 14 | MD024 … |

**Aggregate Verdict:** PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES

## Cross-reviewer Convergence

- Findings flagged by ≥2 reviewers: <list — these are the highest-confidence issues>
- Findings only checkmarx flagged: <list — verify reachability before fixing>
- Findings only semantic reviewers flagged: <list — checkmarx blind spots>
````

Same most-severe-wins aggregate verdict rule as `/review`.

## Constraints

- Do **not** invoke without `cx` available — fall back to `/review` and tell the user.
- Do **not** mutate files. The four reviewers are all read-only; checkmarx may write its own scan-output artifacts but does not touch source.
