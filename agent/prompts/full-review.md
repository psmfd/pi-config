---
name: full-review
description: Four-reviewer serial sequence — code, security, lint, then Checkmarx — with one synthesized verdict.
---

# /full-review

Use when `cx --version` succeeds and the change warrants semantic review plus SAST/SCA/IaC scanning. Otherwise fall back to `/review`.

## Step 1 — Scope

Resolve the requested base or compare the current branch with `dev`. Confirm the repository path and revision range.

## Step 2 — Execute the sequence

Each self-contained task defines Form B because child context files are suppressed.

```json
{
  "sequence": [
    { "agent": "code-review-expert", "task": "Review <base>..HEAD. Source path: <absolute-repo-path> (revision: <base>..HEAD). Return Form B: open a fenced block with three backticks followed by report, include the complete report, close with three backticks, then output Summary: <one line> and Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE." },
    { "agent": "security-review-expert", "task": "Security review <base>..HEAD. Source path: <absolute-repo-path> (revision: <base>..HEAD). Cite first-party sources. Return Form B: open a fenced block with three backticks followed by report, include the complete report, close with three backticks, then output Summary: <one line> and Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE." },
    { "agent": "linter", "task": "Lint changed files in <base>..HEAD under <absolute-repo-path> in report-only mode. Return Form B: open a fenced block with three backticks followed by report, include the complete report, close with three backticks, then output Summary: <one line> and Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE." },
    { "agent": "checkmarx-expert", "task": "Run the appropriate cx scan against <absolute-repo-path>. Report Critical/High findings with file:line and triage notes. Return Form B: open a fenced block with three backticks followed by report, include the complete report, close with three backticks, then output Summary: <one line> and Verdict: PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE." }
  ]
}
```

The deterministic order is code → security → lint → Checkmarx. Reviewers remain independent, and one failure does not stop later items.

## Step 3 — Synthesize

Merge and deduplicate all findings with source attribution. Apply structured-review most-severe-wins. Treat `PRECONDITION_FAILURE` as incomplete coverage. Include an Agent Efficacy Report only after the complete sequence. This workflow is read-only.
