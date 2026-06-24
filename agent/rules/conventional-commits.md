---
description: Use Conventional Commits format for all commit messages
---

# Conventional Commits

All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) format.

## Format

```text
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

## Types

| Type | Use when |
|---|---|
| `feat` | Adding a new feature (skill, agent wrapper, prompt template, rule, extension, script) |
| `fix` | Fixing a bug or incorrect behavior |
| `docs` | Documentation-only changes (README, ADRs, SKILL.md content, rule prose) |
| `chore` | Maintenance tasks (dependency updates, CI config, validate.sh tweaks) |
| `refactor` | Restructuring without changing behavior (e.g. progressive-disclosure splits) |
| `test` | Adding or updating tests or validation checks |
| `ci` | CI/CD pipeline changes |
| `style` | Formatting, whitespace, or linting fixes with no logic change |

## Constraints

- **Type is required.** Every commit message must start with a valid type.
- **Scope is optional but recommended.** Use the skill/agent/rule name or affected area: `feat(linter):`, `fix(validate):`, `docs(adr):`, `feat(orchestration):`.
- **Description is imperative, lowercase, no period.** Write "add shell-expert wrapper" not "Added shell-expert wrapper."
- **No authorship attributions** in commit messages — no "Co-authored-by", "authored by AI", or tool-name trailers.
- **Body** is optional. Use it for context on non-obvious changes, references to issues/ADRs, and a concise summary of what shipped.
- **Breaking changes** use `!` after the type/scope: `feat(rules)!: require all subagents to declare model explicitly`.
- **PR titles follow the same rules** when the target repo runs a semantic-PR linter (e.g. `amannn/action-semantic-pull-request`). After `<type>(<scope>):` the subject must start with a lowercase letter, must not end with a period, and must not lead with punctuation like `/` or `#`. A subject starting with a slash-command name (e.g. `feat(pi-prompts): /expertise-search slash commands`) fails the linter — rephrase to lead with a verb (`feat(pi-prompts): slash-command templates for ...`).
