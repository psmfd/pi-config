---
name: security-review
description: Single-agent security review — invokes security-review-expert in an isolated subprocess against the current diff or a named scope.
---

# /security-review

Run a focused security review using `security-review-expert` only. Use this when:

- You only want the security lens (not code-quality / lint findings)
- You're scoping a change too large for a 3-way fan-out and want a targeted check
- You're following up on a `Escalate to security-review-expert` note from a prior `/review`

For a full multi-lens review, use `/review` (3-way) or `/full-review` (4-way with checkmarx).

## Step 1 — Identify scope

- If the user named a base branch, commit, or specific files, use that.
- Otherwise default to the current branch's diff against `dev` (or `main` when not on a feature branch).
- Surface the chosen scope before invoking.

## Step 2 — Invoke the subagent

Single-mode invocation:

```json
{
  "agent": "security-review-expert",
  "task": "Security review of <scope> in <repo-path>.\n\nSource path: <absolute-repo-path> (revision: <base-ref>..HEAD).\n\nMap trust boundaries, identify auth/authz/secret/crypto/IAM/network concerns, cite first-party documentation with reviewed dates, produce findings per the structured-review-format."
}
```

The brief MUST include an explicit `Source path:` line naming a working-tree path the subagent can `read`/`grep`/`find`/`ls` (or a revision range plus repo path) per `agent/rules/research-parallelism.md` § Ground-Truth Source Precondition. If the orchestrator has not cloned/checked out the target before dispatching, do that first — the subagent will return `PRECONDITION_FAILURE` rather than reviewing from memory.

The brief must be self-contained — name the repo path, the diff range or files, and any context the orchestrator already gathered.

## Step 3 — Surface the result

Return the subagent's findings table verbatim. Add a one-paragraph orchestrator summary above it noting the scope and any escalation notes the subagent emitted (e.g. "Recommended: dispatch checkmarx-expert for SAST validation of finding #3").

## Constraints

- Do **not** add other reviewers — that's `/review` or `/full-review`.
- Do **not** inline the review yourself.
- Do **not** mutate files.
