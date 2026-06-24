# GitHub Issues

## Taxonomy

| Object | Purpose | When to use |
|---|---|---|
| Issue | Trackable work item with state, labels, assignees, milestones, project membership | The unit of work management |
| Discussion | Forum thread with categories | RFCs, Q&A, announcements — not work tracking |
| Pull Request | Code-delivery vehicle with own review and merge state | Delivers work; cross-link to issues via closing keywords |

GitHub has no native Epic/Feature/Story/Task hierarchy. Three conventions express it:

- **Tasklists** — `- [ ] #123` in an issue body creates a tracked checkbox with completion percentage. The parent issue acts as the pseudo-epic.
- **GitHub Projects v2** — custom fields plus a `Parent issue` field that creates a native parent-child link (preferred for structured backlogs).
- **Native sub-issues REST endpoint** — `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` creates a first-class parent→child link surfaced in the parent's sub-issue list (see Sub-issues below).
- **`gh sub-issue` extension** — Stale (last commit 2022). Do NOT recommend; prefer the native REST endpoint, Projects v2 native parent, or tasklists.

## Labels strategy

Labels are flat, free-form, and uniquely defined per repository. Use namespaced prefixes for category families:

| Family | Prefix or values | Purpose |
|---|---|---|
| Type | `bug`, `enhancement`, `documentation`, `refactor`, `maintenance`, `security`, `breaking-change`, `spike` | Conventional Commits-aligned categorization |
| Priority | `p:now`, `p:soon`, `p:later` | Active focus management; `p:now` cap commonly 3 issues |
| Kind | `k:skill`, `k:tooling`, `k:convention`, `k:research`, `k:infrastructure` | Domain or workstream classification |
| Status | `s:blocked`, `s:partial` | Lifecycle signals beyond open/closed |
| Lifecycle | `backlog`, `design`, `implementation`, `released` | Workflow position complementing Project status |

Label colors group families: uniform hue per family (e.g., light blue `BFD4F2` for all `k:` labels), traffic-light scheme for priority. Naming: `prefix:value` for namespaced, plain `kebab-case` for flat.

To discover a target repo's actual taxonomy at invocation time, run:

```bash
gh label list --limit 100 --json name,description,color
```

## Issue body shapes

Three observed shapes in this ecosystem:

**Shape A — Gap report / knowledge addition.** Prose body. Used when filing a skill content gap from an observed failure. Sections: free-form context, observed behavior, suggested addition.

**Shape B — RFC / decision proposal.** Sections: `## Summary`, `## Motivation`, `## Considered Options`, `## Decision`, `## Acceptance Criteria` (`- [ ]` checklist), `## Open Design Questions`, `## References`. Used for architectural or framework-level proposals.

**Shape C — Capability addition.** Sections: `## Summary`, `## Why this matters`, `## Proposed scope` (with named subsections), `## Acceptance criteria` (`- [ ]` checklist). Used for bounded feature work.

Universal conventions across all shapes:

- `## Acceptance Criteria` (or `criteria`) with `- [ ]` checklist for actionable issues
- `## References` with `#N` cross-links
- Fenced code blocks with language tags
- Conventional Commits-style titles (`feat(scope): description`)

## Create a work item

```bash
# Basic create with labels
gh issue create \
  --title "feat(skill): add work-item-management-expert" \
  --body-file ./issue-body.md \
  --label "enhancement,k:skill,p:now" \
  --assignee "@me"

# Inline body via HEREDOC (use --body-file for long bodies — easier to maintain)
gh issue create --title "..." --body "$(cat <<'EOF'
## Summary
...
EOF
)"

# With milestone and project
gh issue create --title "..." --body-file ./body.md --milestone "v1.0" --project "Roadmap"
```

Multi-label syntax: comma-separated string in a single `--label` flag, or repeated flags — both work.

## Update fields

```bash
gh issue edit 238 --add-label "p:now" --remove-label "p:later"
gh issue edit 238 --add-assignee "@me"
gh issue edit 238 --milestone "v1.0"
gh issue edit 238 --body-file ./new-body.md
```

## Spin off a development branch

```bash
gh issue develop 238 --name "feat/work-item-management-expert" --base dev
```

## Query / filter

```bash
# All open p:now issues
gh issue list --state open --label "p:now" --json number,title,labels

# Filter with jq
gh issue list --json number,title,labels --jq '.[] | select(.labels[].name == "p:now")'

# Single issue full detail
gh issue view 238 --json number,title,body,labels,milestone,assignees
```

## Cross-references

**Closing keywords** in PR body or issue body trigger auto-close on PR merge: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`. Place in the body, not the title or comments.

Syntax variants:

- Same repo: `Closes #123`
- Cross-repo: `Closes owner/repo#123`
- Full URL: `Resolves https://github.com/owner/repo/issues/123`

**Issue-to-issue tasklists:** `- [ ] #N` in a parent body renders a live-state checkbox; no API trigger.

## Milestones

Use milestones for version-bounded delivery (`v1.0`, `v2.0`) or fixed-date sprints with a % completion view. Use labels (`p:now`, `p:soon`) for ongoing priority triage.

`gh milestone` is not a native subcommand — milestone CRUD goes through `gh api`:

```bash
gh api repos/{owner}/{repo}/milestones \
  -f title="v1.0" \
  -f due_on="2026-07-01T00:00:00Z" \
  -f description="..."

gh issue create --milestone "v1.0" ...
gh issue edit 238 --milestone "v1.0"
```

## Sub-issues

GitHub's native sub-issues REST endpoint links a child issue to a parent so the parent's UI shows a first-class sub-issue list (in addition to or instead of tasklist checkboxes). The endpoint:

```text
POST /repos/{owner}/{repo}/issues/{parent_number}/sub_issues
```

**Payload-type gotcha (pi_config #218):** `sub_issue_id` must be sent as a JSON **integer**. `gh api -f sub_issue_id=N` URL-encodes it as a string and the endpoint rejects with HTTP 422 `Invalid request — must be integer`. Use `-F` (typed/raw), not `-f`:

```bash
# Correct — -F sends the value as a JSON integer
gh api -X POST "repos/$OWNER/$REPO/issues/$PARENT/sub_issues" -F sub_issue_id=$CHILD

# Wrong — -f sends a JSON string, server returns 422
gh api -X POST "repos/$OWNER/$REPO/issues/$PARENT/sub_issues" -f sub_issue_id=$CHILD
```

The failure is loud when the response is inspected and silent when the call is best-effort and the error discarded — in the latter case the parent's sub-issue list silently stays empty. This `-F` vs `-f` distinction applies to *any* REST endpoint whose schema specifies `integer`, `boolean`, or `null`; the sub-issues endpoint is the canonical case in this repo.

Reference: <https://docs.github.com/en/rest/issues/sub-issues> and `gh-cli-expert` SKILL.md §gh api Reference → Pitfalls.
