# Agent and skill authoring

Authoritative sources: `docs/skills.md`, `docs/prompt-templates.md` in the installed pi package. This reference covers the **two parallel concepts** pi exposes — skills (model-loaded knowledge) and our `subagent` extension's agents (subprocess wrappers) — plus prompt templates. The conventions here are what our `agent/AGENTS.md` orchestrator routing depends on.

## Skills (pi-native)

Self-contained capability packages the model loads on demand. Format defined by the [Agent Skills standard](https://agentskills.io/specification); pi implements it with one relaxation (skill `name` need not match parent directory).

### Discovery (in priority order)

| Location | Scope | Notes |
|---|---|---|
| `~/.pi/agent/skills/` | Global | Root `.md` files OR `<dir>/SKILL.md`. **Our agents live here.** |
| `~/.agents/skills/` | Global | `<dir>/SKILL.md` only — root `.md` files ignored |
| `.pi/skills/` | Project | Same as `~/.pi/agent/skills/` |
| `.agents/skills/` in cwd + ancestors up to git root | Project | `<dir>/SKILL.md` only |
| Pi packages | Per-package | `skills/` dir or `pi.skills` in `package.json` |
| `settings.json` `skills[]` | Per-source | Files or directories |
| `--skill <path>` CLI | Ad-hoc | Repeatable; bypasses `--no-skills` |

Discovery walks ancestors up to the git repo root (or filesystem root when not in a repo). Name collisions warn and keep the first found.

Disable all auto-discovery with `--no-skills` (explicit `--skill` paths still load).

### `SKILL.md` frontmatter

| Field | Required | Constraint | Purpose |
|---|---|---|---|
| `name` | Yes | 1–64 chars, lowercase `a-z0-9-`, no leading/trailing/consecutive hyphens | Skill identifier; LLM sees this in `<available_skills>` |
| `description` | Yes | ≤1024 chars | Determines when the model triggers the skill. **Missing description = skill won't load.** |
| `license` | No | — | License name or bundled-file reference |
| `compatibility` | No | ≤500 chars | Environment requirements |
| `metadata` | No | object | Arbitrary key-values |
| `allowed-tools` | No | space-delimited list | Pre-approved tools (experimental) |
| `disable-model-invocation` | No | boolean | When `true`, hidden from system prompt — must invoke via `/skill:name` or be loaded explicitly by an agent wrapper. **Set on all 20 wrapper-paired skills in this repo to force `subagent`-tool routing and shrink the parent system prompt.** |

Unknown frontmatter fields are ignored. Name validation issues *warn* and load; missing description is a *hard error*.

### How auto-trigger works

1. At startup, pi scans all skill locations and extracts `name` + `description` from each `SKILL.md` frontmatter.
2. These are injected into the system prompt as an XML block (per the [agentskills.io integration spec](https://agentskills.io/integrate-skills)). You can see your own session's `<available_skills>` block in the active system prompt.
3. The model reads the description, decides if a task matches, and uses `read` to load the full `SKILL.md`.
4. Models don't always do this reliably. Force-loads: prompt explicitly ("load the X skill") or use `/skill:name` if enabled.

`/skill:name` registration is gated by `enableSkillCommands` in settings (toggle via `/settings`).

### Skill directory structure (progressive disclosure)

```text
my-skill/
├── SKILL.md              # Frontmatter + overview + reference table
├── references/           # Detailed docs, loaded on demand
│   ├── topic-a.md
│   └── topic-b.md
├── scripts/              # Helper scripts (if any)
└── assets/               # Templates, examples
```

The pattern: `SKILL.md` is always in context (via description); `references/*.md` files load only when the agent reads them. Our `pi-agent-expert`, `tauri-expert`, and `dotnet-expert` all follow this pattern.

## Agents (subagent-extension concept — NOT pi-native)

"Agents" in this repo are **our extension's** concept, not pi's. They are `.md` files our `agent/extensions/subagent/agents.ts` parses to construct subprocess invocations. Pi itself has no `agents/` directory concept.

### Discovery

Our extension reads:

| Location | Scope | Set by `cwd:` parameter |
|---|---|---|
| `~/.pi/agent/agents/*.md` | Global ("user") | `scope: "user"` or `"both"` (default) |
| `<cwd>/.pi/agents/*.md` or nearest ancestor | Project | `scope: "project"` or `"both"` |

When `scope: "both"`, project entries override global entries with the same `name`. See `agents.ts:96-117`.

### Wrapper frontmatter (what we currently parse)

`agents.ts:54-71` reads exactly these fields:

| Field | Required | Type | Behavior |
|---|---|---|---|
| `name` | Yes | string | Becomes the `agent:` value for the `subagent` tool |
| `description` | Yes | string | Goes into the orchestrator's agent catalog and the tool spec |
| `tools` | No | comma-separated string | Passed to child as `--tools <csv>` |
| `model` | No | string | Passed to child as `--model <id>` |

**Body** of the `.md` file (after frontmatter) becomes the child's `--system-prompt`. Everything else in frontmatter is silently ignored. We use `mode:` (e.g. `read-only`, `interactive`) for our agent catalog regen script, but the extension doesn't read it — it's documentation for `scripts/regen-agent-catalog.sh`.

### Candidate fields for migration (not currently parsed)

If we migrate tintinweb-style frontmatter, the additions go in *both* `agents.ts` (parse + store in `AgentConfig`) and `index.ts:265` (translate to argv):

| Field | Maps to | Child argv |
|---|---|---|
| `thinking` | pi CLI `--thinking` flag | `--thinking <level>` |
| `extensions: false` | pi CLI `--no-extensions` | `--no-extensions` |
| `max_turns` | No native CLI flag; needs in-process counting | Implement in parent's event-stream parser; abort or steer via SIGTERM |
| `skills` (list) | No native CLI flag for preloading specific skills by name | Resolve to paths and pass `--skill <path>` for each |

### Why our agents are "wrappers" — the two-layer design

Each catalog entry has two coordinated files:

| File | Purpose |
|---|---|
| `agent/agents/<name>.md` | **Wrapper** — frontmatter for our extension + role/boundary text for the LLM. Sets `tools:` allowlist and (optionally) `model:`. |
| `agent/skills/<name>/SKILL.md` | **Skill** — pi-native domain knowledge, progressive disclosure. Auto-loadable. |

When the orchestrator invokes `subagent` with `agent: "tauri-expert"`, our extension spawns a child `pi` subprocess with the wrapper's body as `--system-prompt` and the wrapper's `tools` as `--tools`. The child *also* inherits all globally-discoverable skills (including the matching `tauri-expert` skill), and the wrapper body tells it to load that skill.

All 20 wrapper-paired skills set `disable-model-invocation: true` on the **skill** to remove parent auto-trigger — they're reachable only through the `subagent` tool (or a manual `/skill:<name>`), guaranteeing isolated-subprocess execution and shrinking the parent system prompt. The three review specialists (`code-review-expert`, `security-review-expert`, `checkmarx-expert`) are *additionally* gated by opus pinning and a read-only tool allowlist. See [`AGENTS.md`](../../../AGENTS.md#agent-catalog).

### Agent catalog regen

`scripts/regen-agent-catalog.sh` reads `name`/`description`/`mode` frontmatter from every `agent/agents/*.md` and rewrites the table in `agent/AGENTS.md` between markers. **Run after adding or removing an agent** — the table is the orchestrator's source of truth for valid `agent:` values. Idempotent.

## Prompt templates

Markdown snippets expanded into prompts. Discovered from:

| Location |
|---|
| `~/.pi/agent/prompts/*.md` (global) |
| `.pi/prompts/*.md` (project) |
| Packages (`prompts/` dir or `pi.prompts` manifest entry) |
| `settings.json` `prompts[]` |
| `--prompt-template <path>` CLI (repeatable) |

Discovery is **non-recursive** — subdirectories are ignored unless explicitly added.

### Format

```markdown
---
description: Run all three reviewers in parallel
argument-hint: "[scope]"
---
Fan out to code-review-expert, security-review-expert, and linter in one subagent call...
```

| Field | Required | Purpose |
|---|---|---|
| `description` | No (defaults to first non-empty line) | Shown in autocomplete |
| `argument-hint` | No | Shown before description in autocomplete; convention is `<required>` and `[optional]` |

Filename → command: `review.md` → `/review`.

### Argument syntax

- `$1`, `$2`, … positional args
- `$@` or `$ARGUMENTS` — all args joined
- `${@:N}` — args from position N (1-indexed)
- `${@:N:L}` — `L` args starting at position N

### Our prompts

| Command | File | Effect |
|---|---|---|
| `/review` | `agent/prompts/review.md` | Fan out 3 ways: `code-review-expert` + `security-review-expert` + `linter` |
| `/security-review` | `agent/prompts/security-review.md` | Single agent: `security-review-expert` |
| `/full-review` | `agent/prompts/full-review.md` | Fan out 4 ways (adds `checkmarx-expert` if `cx` available) |

These templates are the orchestrator's pre-composed routing decisions. When users want a workflow that fits one of them, prefer the slash command over hand-rolled `subagent` calls.

## Naming conventions in this repo

- Agent + skill share the **same `name`** (`tauri-expert` agent ↔ `tauri-expert` skill). The wrapper instructs the LLM to load the matching skill.
- Skills with no agent wrapper exist (e.g. infrastructure-only `*-expert` skills that don't need subprocess isolation — though we currently have a 1:1 mapping).
- Built-in pi tools that operate inside the harness without a subprocess (e.g. `linter`) still have an agent wrapper so they're reachable via the `subagent` tool with the same routing protocol.

## Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| Skill not appearing in `<available_skills>` | `disable-model-invocation: true` set, OR missing `description`, OR `description` >1024 chars, OR `name` invalid (uppercase, etc.) |
| Agent invocation says "unknown agent" | `name` mismatch between `agent:` argument and `agent/agents/<file>.md` frontmatter `name` field |
| Catalog table out of date | Forgot to run `scripts/regen-agent-catalog.sh` after agent change |
| Project agent not overriding global | `.pi/agents/` not found in cwd or any ancestor — our extension walks up looking for `.pi/agents/`, not `.pi/agent/agents/` |
| `/skill:name` doesn't work | `enableSkillCommands` not set in settings |
| Slash command not found | Template in a subdirectory of `prompts/` (discovery is non-recursive) or filename has uppercase / special chars |
