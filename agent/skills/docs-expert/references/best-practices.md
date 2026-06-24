# Documentation Best Practices

## Structure and Hierarchy

- Lead with the most important information (inverted pyramid)
- Use progressive disclosure: summary first, details on demand
- Keep heading depth shallow (3 levels is usually sufficient)
- One topic per page/section — split when a document serves multiple audiences
- Front-load keywords in headings for scannability

## Audience Awareness

| Audience | Focus | Tone | Examples |
|---|---|---|---|
| Developers | API contracts, code examples, architecture rationale | Precise, terse, imperative | README, CONTRIBUTING, inline docs |
| Operators | Runbooks, config reference, troubleshooting | Step-by-step, declarative | Ops guides, playbooks |
| End users | Task completion, UI flows, error resolution | Conversational, outcome-focused | Help articles, tutorials |

Identify the primary audience before writing. Mixed-audience documents should use clear section boundaries rather than blending concerns.

## DRY Documentation

- Single source of truth: define a concept once, reference it everywhere else
- Reference, do not repeat — link to the canonical location
- When duplication is unavoidable (e.g., self-sufficient documents), note the canonical source
- Stale duplicates are worse than missing documentation

## README Patterns

Essential sections for a repository README:

| Section | Purpose | Required |
|---|---|---|
| Title + one-liner | What this is | Yes |
| Quick Start | Minimum steps to get running | Yes |
| Prerequisites | Tools, versions, access needed | When non-trivial |
| Architecture | Structure, key decisions | When non-obvious |
| Configuration | Settings, environment variables | When configurable |
| Usage | Beyond quick start | When usage patterns exist |
| Constraints | Limitations, boundaries | When non-obvious |

Omit: changelog (use git tags), authors (use git history), license (use LICENSE file), badges/shields (noise).

## API Documentation

- Document every public endpoint with: method, path, parameters, request body, response shape, error codes
- Include runnable examples (curl, SDK snippets) — not just schema descriptions
- Show error responses alongside success responses
- Version the documentation alongside the API

## Changelog and Release Notes

- Changelogs track what changed; release notes explain what it means for users
- Group by: Added, Changed, Deprecated, Removed, Fixed, Security
- Link to issues/PRs for traceability
- Write release notes in user-facing language, not commit-message language
