# Documentation for Agent Platforms

## Copilot Instruction Files

Copilot instruction files (`.instructions.md`) are the Copilot equivalent of Claude Code rules:

| File type | Location | Scoping |
|---|---|---|
| Always-on instructions | `.github/copilot-instructions.md` | Applies to all interactions (no frontmatter) |
| Scoped instructions | `.github/instructions/<name>.instructions.md` | `applyTo` glob pattern in frontmatter |
| User-level instructions | `~/.copilot/instructions/<name>.instructions.md` | Same `applyTo` scoping |

Instructions are condensed mirrors of their Claude Code rule counterparts, noting platform-specific caveats.

## Copilot Agent Wrappers

Copilot agent wrappers (`.agent.md`) must be self-sufficient — all domain knowledge must be in the body because Copilot has no `skills:` injection. Key authoring constraints:

- `validate.sh` enforces a 500-character minimum body for skill-backed wrappers
- Section coverage checks verify that SKILL.md H2 heading keywords appear in the Copilot body
- Only documented Copilot fields are permitted: `description`, `name`, `tools`
- No Claude-specific fields: `skills`, `isolation`, `maxTurns`, `effort`, `memory`, `permissionMode`, `background`

## AGENTS.md Convention

`AGENTS.md` in a project root is read by both Claude Code and the GitHub Copilot coding agent. It serves as the cross-platform source of truth for project conventions that both platforms should follow.

## Cross-Platform Content Parity

When documenting conventions that apply to both Claude Code and Copilot:

- Use platform-neutral phrasing ("the agent must..." not "Claude must...")
- When tool names differ, pair both: "`Bash` (Claude) / `execute` (Copilot)"
- Document platform-specific limitations alongside shared behavior
- If a convention has a different implementation per platform, describe both

## Copilot Development Caveats

Key differences when developing for or advising on GitHub Copilot:

| Constraint | Claude Code | Copilot |
|---|---|---|
| Skill injection | `skills:` field injects SKILL.md at startup | Not available — inline all knowledge in wrapper body |
| Agent invocation | Parallel fan-out via Agent tool | Sequential only — invoke one agent at a time |
| Hooks | `UserPromptSubmit`, `Stop`, `PreToolUse` | VS Code: 8 events, `command` type only; CLI: 8 events but only `preToolUse` deny is actionable — behavioral guards in body instructions supplement CLI coverage |
| Shell access | `Bash` tool (always available to agents with it listed) | `execute` tool; VS Code requires user to opt-in per session |
| File writing | `Write`/`Edit` tools | `edit` tool — must be declared in frontmatter for VS Code to allow writes without per-file confirmation |
| Subagent networking | Always available | Copilot CLI silently blocks network I/O in subagent contexts |
| Model selection | `model:` in frontmatter (`opus`, `sonnet`, `haiku`) | Limited — model selection depends on Copilot plan and availability |

### Mermaid in Copilot Chat Output

Mermaid diagram blocks included in an agent's response are not rendered in Copilot chat — they appear as raw fenced code blocks. When outputting documentation advice in a Copilot context:

- Describe diagram intent in prose rather than emitting raw Mermaid syntax
- Direct users to add Mermaid diagrams in their documentation files (where they will render)
- Use tables or bullet lists as alternatives for simple relationships
