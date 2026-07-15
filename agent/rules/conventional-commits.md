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
| `perf` | Performance improvement with no functional behavior change (PATCH bump, like `fix`) |
| `docs` | Documentation-only changes (README, ADRs, SKILL.md content, rule prose) |
| `chore` | Maintenance tasks (dependency updates, CI config, validate.sh tweaks) |
| `refactor` | Restructuring without changing behavior (e.g. progressive-disclosure splits) |
| `test` | Adding or updating tests or validation checks |
| `ci` | CI/CD pipeline changes |
| `style` | Formatting, whitespace, or linting fixes with no logic change |
| `revert` | Reverting a prior change. Hand-write the title (`revert(scope): undo ...`) — GitHub's auto-generated `Revert "..."` title fails the PR-title lint. Classifies as no version bump: a revert never auto-triggers a release without a human decision |

## Constraints

- **Type is required.** Every commit message must start with a valid type.
- **Scope is optional but recommended.** Use the skill/agent/rule name or affected area: `feat(linter):`, `fix(validate):`, `docs(adr):`, `feat(orchestration):`.
- **Description is imperative, lowercase, no period.** Write "add shell-expert wrapper" not "Added shell-expert wrapper."
- **No authorship attributions** in commit messages — no "Co-authored-by", "authored by AI", or tool-name trailers.
- **Body** is optional. Use it for context on non-obvious changes, references to issues/ADRs, and a concise summary of what shipped.
- **Breaking changes** use `!` after the type/scope: `feat(rules)!: require all subagents to declare model explicitly`.
- **PR titles targeting `dev` are mechanically enforced** by the `lint-pr-title` required check (`.github/workflows/lint-pr-title.yml`, #731) — since squash merges use the PR title as the commit subject, the title is the sole Conventional Commits signal feeding release version derivation. The check enforces structure only: a type from the table above, optional `(scope)`, optional `!`, a colon and single space, a subject starting with an alphanumeric character, and no trailing period. A subject leading with punctuation (e.g. `feat(pi-prompts): /expertise-search slash commands`, or a `--flag` name) fails — rephrase to lead with a verb (`feat(pi-prompts): slash-command templates for ...`). Lowercase-first and length are stylistic recommendations, not lint failures: subjects legitimately lead with acronyms or proper nouns (`docs(adr): ADR-0046 migrate ...`).
