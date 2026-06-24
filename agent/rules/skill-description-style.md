---
description: House style for skill description frontmatter
---

# Skill Description Style

The `description:` field in `agent/skills/<name>/SKILL.md` frontmatter is the skill's elevator pitch. Since all 22 wrapper-paired skills in this repo carry `disable-model-invocation: true` (ADR-0003), descriptions are no longer consumed by the parent session's `<available_skills>` system-prompt block. Their remaining audience is:

1. `/skill:<name>` tab-completion in interactive mode (pi `interactive-mode.js:339`)
2. RPC `listSkills` consumers (pi `rpc-mode.js:514`)
3. Humans reading the file in the repo or via `gh` web UI

This rule defines how to write descriptions for that audience. It does **not** apply to `agent/agents/<name>.md` wrapper descriptions, which feed the AGENTS.md catalog and remain verbose by design.

## Format

```yaml
description: '<Domain> reference for the <name> subagent — <topic inventory>.'
```

- **Length:** 100–180 bytes of the YAML scalar value (UTF-8, excluding the surrounding single quotes). 200 byte hard ceiling. Em-dash counts as 3 bytes. Measure with `LC_ALL=C awk -F"'" '/^description:/{print length($2); exit}' SKILL.md` (the `LC_ALL=C` is required so `awk` reports bytes rather than codepoints). The original 200–800 byte "Use when…" prose pre-dates ADR-0003 and is now over-budget for the surviving audience.
- **Shape:** one sentence, no trailing newline, no Markdown formatting (the surfaces that render this do not honor it).
- **Quoting:** single-quoted YAML scalar, matching the existing convention. Escape internal single quotes by doubling them.
- **Voice:** noun phrase, not imperative. Drop "Use when…" / "Use this to…" / "Triggers when…" clauses — they were artifacts of auto-trigger heuristics that no longer apply.

## Required elements

- **Domain anchor.** What technology, surface, or activity the skill covers (e.g. ".NET 10 LTS", "Tauri 2 desktop apps", "Helm 3 chart authoring").
- **Subagent linkage.** The literal phrase "for the `<name>` subagent" — partly redundant with the file path and with the `name` field that surfaces alongside the description in `/skill:` autocomplete and RPC `listSkills`, but earns its keep as (a) a grep anchor when searching the repo for the wrapper-skill pairing and (b) a structural reminder to authors that the skill is wrapper-mediated. Keep the phrase verbatim for consistency across the catalog.
- **Topic inventory.** A short comma-separated list of the major subdomains the skill body covers. 3–8 items. Pick the items the operator would scan for when deciding whether to spawn the subagent manually via `/skill:`, prioritising domain-specific gotchas (e.g. Tauri's `build vs bundle` distinction) over generic framework names.
- **Sentence terminator.** End with a single period inside the closing quote.

## Forbidden elements

- "Use when…" / "Use this to…" / "Triggers on…" clauses — auto-trigger heuristics for a surface the skill no longer appears on.
- Behavioral postscripts ("read-only by default", "requires approval", etc.) — boundary metadata belongs in the agent wrapper, not the skill description.
- Implementation-detail nouns that drift across upstream versions (specific class names, undocumented internal modules). Stay at the topic level.
- Marketing adjectives ("comprehensive", "best-in-class", "extensive"). Topic nouns only.
- Double trailing periods or a trailing period outside the closing quote.

## Examples

**Good:**

```yaml
description: '.NET 10 LTS reference for the dotnet-expert subagent — SDK, csproj, ASP.NET Core, BackgroundService, EF Core, testing, publishing.'
```

**Good:**

```yaml
description: 'Tauri 2 reference for the tauri-expert subagent — tauri.conf.json, capabilities v2, sidecars, plugin ecosystem, GitHub Actions 3-OS matrix.'
```

**Good:**

```yaml
description: 'Helm 3 reference for the helm-expert subagent — chart authoring, values merge, hooks, helm diff.'
```

**Bad** (over-budget, 281 bytes, "Use when…" clause):

```yaml
description: '.NET specialist — .NET 10 LTS SDK, cross-platform development (macOS, Linux, Windows, containers), ASP.NET Core minimal APIs, worker services, dependency injection, EF Core, testing, publishing, and security best practices. Use when working on .NET projects or .NET CLI commands.'
```

## When this rule applies

- Authoring a new skill in `agent/skills/<name>/SKILL.md`
- Editing the description of an existing skill
- Adopting a skill from an upstream source (strip the upstream description and rewrite to this style)

## When this rule does not apply

- `description:` in `agent/agents/<name>.md` wrappers — those feed the AGENTS.md catalog and should remain verbose enough to drive orchestrator routing decisions
- Skill bodies (the prose under the frontmatter) — no length cap, follow progressive-disclosure conventions documented in `agent/skills/pi-agent-expert/references/agent-and-skill-authoring.md`
- Skill `name:` field — governed by pi's frontmatter contract (≤64 chars, lowercase + digits + hyphens)

## Validation

`scripts/validate.sh` enforces both the 100–180 byte target (200 byte hard ceiling, with 181–200 surfaced as a warning) and the 3–8 topic-inventory item-count cap on every `agent/skills/*/SKILL.md` description. Descriptions missing the em-dash separator surface as a shape warning. Style judgments (topic relevance, marketing adjectives, presence of "Use when…" prose, redundancy) remain contributor-enforced and surfaced through `/review` on the diff. ADR-0003 § Follow-ups tracks the consensus that motivated this rule.

## Cross-references

- [ADR-0003](../../adrs/0003-expand-disable-model-invocation-to-all-wrapper-paired-skills.md) — the decision that collapsed the description audience and motivated this rule
- `agent/skills/pi-agent-expert/references/agent-and-skill-authoring.md` — the broader frontmatter contract, of which this rule is one slice
- pi `docs/skills.md` — first-party documentation of frontmatter fields (description ≤ 1024 chars, hard error if missing)
