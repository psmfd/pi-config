# Content Curation

## Information Architecture

- Organize by audience need, not by internal team structure
- Three primary organizations: by task (how-to), by reference (API docs), by explanation (architecture)
- Navigation should answer: "Where do I find X?" within two clicks/scrolls
- Cross-reference related documents rather than merging unrelated topics

## Content Lifecycle

| Stage | Action | Trigger |
|---|---|---|
| Creation | Draft, review, publish | New feature, process, or decision |
| Maintenance | Update, verify accuracy | Feature change, dependency update, user feedback |
| Deprecation | Mark deprecated, point to replacement | Feature sunset, superseded process |
| Removal | Archive or delete | Content no longer applicable, replacement fully adopted |

## Documentation Debt

- Stale docs are worse than no docs — they erode trust
- Review docs when the code they describe changes
- Track documentation debt alongside tech debt (tag issues, add to backlog)
- Prioritize: incorrect docs > incomplete docs > missing docs > style issues

## Wiki vs Repo-Hosted Docs

| Factor | Wiki | Repo-hosted |
|---|---|---|
| Versioning | Usually none or weak | Full git history |
| Review process | Usually none | PR-based review |
| Proximity to code | Separate system | Same repo |
| Discoverability | Search, navigation tree | File browser, IDE |
| Non-developer access | Easier (web UI) | Harder (requires repo access) |
| Best for | Runbooks, onboarding, process docs | Architecture, API, developer docs |
