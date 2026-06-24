---
description: Require structured output format with severity classification, findings table, and machine-readable verdict for all review output
---

# Structured Review Format

When producing review output — whether from a dedicated review subagent (`code-review-expert`, `security-review-expert`, `checkmarx-expert`), the linter, or a self-review pass — use this structured format.

## Severity Classification

Every finding must be assigned one of these severity levels:

- **Critical** — data loss, security vulnerability, or outage risk. Must be fixed before merge.
- **Error** — incorrect behavior, logic bug, or broken functionality. Must be fixed before merge.
- **Warning** — code smell, design concern, or non-idiomatic pattern. Should be addressed but does not block merge.
- **Info** — suggestion, minor improvement, or style observation. Optional to address.

## Findings Table

Present all findings in a single `## Findings` section with this table format:

```markdown
## Findings

| Severity | File | Line | Finding |
| --- | --- | --- | --- |
| Critical | src/auth.py | 42 | SQL injection via unsanitized user input |
| Warning | lib/utils.ts | 118 | Unused import — `lodash` is imported but never referenced |
```

Every finding must include a `file:line` reference. Do not report findings without location information.

## Verdict

End every review with a machine-readable verdict line:

```markdown
**Verdict:** PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE
```

- **PASS** — no findings, or Info-only findings.
- **PASS_WITH_WARNINGS** — Warning-level findings exist but no Critical or Error findings.
- **NEEDS_CHANGES** — one or more Critical or Error findings. The review does not pass.
- **PRECONDITION_FAILURE** — the source under review was not cited in the brief, or the cited path was not readable, so no findings were produced. Distinct from `NEEDS_CHANGES`: signals the review did not happen, not that the code was rejected. Applies to `security-review-expert` and `code-review-expert` per `rules/research-parallelism.md` § Ground-Truth Source Precondition. Emission format is a single line, e.g. `**Verdict:** PRECONDITION_FAILURE — no Source path cited in brief`.

## Merged Reports (multi-subagent fan-out)

When the orchestrator combines output from multiple review subagents (e.g. via `/review` or `/full-review`), the merged report adds a `Source` column to identify which subagent produced each finding, and uses a most-severe-wins aggregate verdict:

```markdown
| Severity | Source | File | Line | Finding |
| --- | --- | --- | --- | --- |
| Critical | security-review | src/auth.cs | 42 | … |
| Warning | linter (shellcheck) | setup.sh | 7 | SC2086 … |

**Aggregate Verdict:** NEEDS_CHANGES
```

Most-severe-wins: any reviewer's `NEEDS_CHANGES` → aggregate `NEEDS_CHANGES`; otherwise any `PASS_WITH_WARNINGS` → aggregate `PASS_WITH_WARNINGS`; otherwise `PASS`.

**`PRECONDITION_FAILURE` in merged reports:** a `PRECONDITION_FAILURE` from one reviewer does not propagate to the aggregate verdict (the other reviewers' findings are still valid). Render the precondition-failed reviewer as a separate row with `Source = <agent>` and `Severity = PRECONDITION_FAILURE`, and add a note above the aggregate verdict identifying which reviewer's input is missing and what brief change would resolve it (typically: add a `Source path:` line and re-dispatch). Treat the aggregate as `PASS_WITH_WARNINGS` at minimum even if all other reviewers returned `PASS`, because the orchestrator's review coverage is incomplete.

## Reviewer-independence brief discipline

Briefs sent to `code-review-expert`, `security-review-expert`, or `checkmarx-expert` MUST NOT cite peer-produced `.review/` artifacts (or any other peer-subagent output from the same session) as inputs. Reviewers receive only the diff under review and their own tool surface. This preserves review independence: aggregated verdicts are most-severe-wins precisely because the inputs are mutually uncorrelated. Surfacing peer artifacts to reviewers correlates findings and defeats aggregation. Cross-referenced from [ADR-0008](../../adrs/0008-tier-3-as-sole-intra-session-inter-agent-channel.md) § Operational obligations.

## When this rule applies

- Any subagent performing code review (`code-review-expert`, `security-review-expert`, `checkmarx-expert`)
- The `linter` subagent
- Self-review passes during implementation
- PR review output produced by orchestrator-driven workflows

## When this rule does not apply

- Exploratory research or question-answering — not every analysis needs a verdict
- Linter raw output that follows its own tool-centric format (the `linter` subagent normalizes it before returning)
- Trivial single-file checks where a prose response is more appropriate
