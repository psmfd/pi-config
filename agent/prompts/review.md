---
name: review
description: Three-way parallel review — code-review-expert + security-review-expert + linter — fanned out via the subagent extension. Synthesizes findings into a single merged table.
---

# /review

Run a parallel review of the current changes using three specialist subagents. Synthesize their findings into a single merged table.

## Step 1 — Identify the diff under review

Determine the scope of the review:

- If the user named a base branch or commit (e.g. `/review main`, `/review HEAD~3`), use that.
- Otherwise default to the current branch's diff against `dev` (or `main` when not on a feature branch). Run `git rev-parse --abbrev-ref HEAD` and `git log --oneline <base>..HEAD` to confirm what's in scope. Surface the chosen scope to the user before fanning out.

## Step 2 — Fan out via the subagent tool

Invoke the `subagent` tool **once** in parallel mode. All three agents run concurrently with isolated context windows.

```json
{
  "tasks": [
    {
      "agent": "code-review-expert",
      "task": "Review the diff: <base-ref>..HEAD in <repo-path>.\n\nSource path: <absolute-repo-path> (revision: <base-ref>..HEAD).\n\nRead the diff, examine surrounding context for the files touched, and produce findings per the structured-review-format."
    },
    {
      "agent": "security-review-expert",
      "task": "Security review of the diff: <base-ref>..HEAD in <repo-path>.\n\nSource path: <absolute-repo-path> (revision: <base-ref>..HEAD).\n\nMap trust boundaries, identify auth/authz/secret/crypto concerns, cite first-party docs, produce findings per the structured-review-format."
    },
    {
      "agent": "linter",
      "task": "Lint changed files in the diff <base-ref>..HEAD in <repo-path>. Run the appropriate linter per file type in report-only mode."
    }
  ]
}
```

Substitute `<base-ref>`, `<repo-path>`, and `<absolute-repo-path>` with concrete values. Each task brief must be self-contained — subagents have no shared memory. The `Source path:` line in `code-review-expert` and `security-review-expert` briefs is mandatory per `agent/rules/research-parallelism.md` § Ground-Truth Source Precondition; without it the subagent will return `PRECONDITION_FAILURE` and the fan-out will need to be re-issued.

## Step 3 — Synthesize the merged report

When all three return, produce a single output:

````markdown
# Review Summary

**Scope:** `<base-ref>..HEAD` (`<n>` commits, `<m>` files)
**Reviewers:** code-review-expert, security-review-expert, linter

## Merged Findings

| Severity | Source | File | Line | Finding |
| --- | --- | --- | --- | --- |
| Critical | security-review | src/auth.cs | 42 | … |
| Error | code-review | src/db.py | 118 | … |
| Warning | linter (shellcheck) | setup.sh | 7 | SC2086 … |

**Aggregate Verdict:** PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES

## Notes

- Cross-reviewer agreement: <list any finding flagged by ≥2 reviewers>
- Escalations: <any "Escalate to X" notes from subagents>
- Source conflicts: <any unresolved first-party doc conflicts from security review>
````

Aggregate-verdict rule (most-severe wins):

- Any reviewer reports `NEEDS_CHANGES` → aggregate is `NEEDS_CHANGES`
- Otherwise any `PASS_WITH_WARNINGS` → aggregate is `PASS_WITH_WARNINGS`
- Otherwise `PASS`

## Constraints

- Do **not** inline a review yourself instead of fanning out — that defeats the purpose of the workflow.
- Do **not** add a fourth agent unless the user asked for `/full-review`. Three is the standard fan-out per `agent/rules/research-parallelism.md`.
- Do **not** mutate any files. This workflow is read-only end to end.
