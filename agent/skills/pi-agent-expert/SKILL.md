---
name: pi-agent-expert
description: 'pi internals reference for the pi-agent-expert subagent — CLI modes, JSON event stream, extension API, agent/skill authoring, prompt templates, settings, snapshot-bump.'
disable-model-invocation: true
---

# pi Agent Expert

Read-only reference for pi (`@earendil-works/pi-coding-agent`) internals — the CLI, harness API, agent/skill authoring contracts, and our vendored `subagent` extension. Use this skill before proposing changes to anything under `agent/extensions/`, `agent/agents/`, `agent/skills/`, `agent/prompts/`, or behavioral rules that depend on harness mechanics.

## Overview

pi is a coding-agent CLI with three modes (interactive, `-p` print, `--mode json` event stream) and an extension system that lets TypeScript modules register tools, intercept events, customize UI, and inject state. Our `pi_config` repo uses pi as an orchestration substrate: a vendored `subagent` extension fans out to read-only specialist agents in isolated subprocesses, governed by AGENTS.md.

The harness is **versioned and moving**. Behaviors documented in pi's `docs/*.md` are mostly stable; behaviors inferred from `dist/` are not — assume they can drift between minor releases. When the question is "does pi do X?", first-party sources rank: `docs/` > `examples/extensions/` (working code) > `dist/*.js` (compiled, may be inlined). Our vendored snapshot pins a specific upstream version; the version recorded in `agent/extensions/subagent/README.md` is the source of truth for what behaviors we depend on.

The project (`earendil-works/pi-mono`, distributed as `@earendil-works/pi-coding-agent`) is **Active**: rapid release cadence (multiple minor versions per month), single-vendor, npm-distributed. Risk: Low for stable APIs documented in `docs/`; Medium for behaviors only visible in `dist/`. Always confirm against the currently-installed pi version before recommending changes.

## First-party sources on disk

The installed pi package is the authoritative reference. On a typical install:

```text
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/
├── README.md                # Overview + design principles
├── CHANGELOG.md             # Version history; consult before snapshot bumps
├── package.json             # Version, exports, scripts
├── docs/                    # Authoritative docs (extensions, skills, json, etc.)
├── examples/extensions/     # Working reference implementations
└── dist/                    # Compiled JS — last-resort source-of-truth
```

Resolve the install location dynamically before grepping: `node -e 'console.log(require.resolve("@earendil-works/pi-coding-agent/package.json"))'` (the path above is macOS Homebrew; Linux/npm-prefix installs differ). The path differs across machines; the layout doesn't.

## Reference Index

Detailed material lives in `references/`. Load only the file that matches the question — progressive disclosure. The JSON event stream contract (`references/cli-and-modes.md`) is the single most important reference for our `subagent` extension because the child-subprocess output is parsed line-by-line as JSON events.

| If the question involves… | Read |
|---|---|
| pi CLI flags (`-p`, `--mode json`, `--tools`, `--model`, `--no-session`, `-e`, `--skill`, `--prompt-template`), env vars (`PI_CODING_AGENT_DIR`, `PI_OFFLINE`, etc.), the JSON event stream event types and shape, exit codes, signal handling | [`references/cli-and-modes.md`](references/cli-and-modes.md) |
| `pi.registerTool`, the full event catalog (`tool_call`, `tool_result`, `input`, `before_agent_start`, lifecycle), `ExtensionContext`/`ctx`, `pi.sendMessage` and steering modes, `pi.events` bus, `pi.registerCommand`, `pi.registerProvider`, async factory functions | [`references/extension-api.md`](references/extension-api.md) |
| Agent wrapper frontmatter contract, skill `SKILL.md` frontmatter (`name`, `description`, `disable-model-invocation`), discovery precedence (`.pi/` project vs `~/.pi/agent/` global), `<available_skills>` auto-trigger, `/skill:name` explicit load, prompt-template authoring (`/review`-style), argument syntax | [`references/agent-and-skill-authoring.md`](references/agent-and-skill-authoring.md) |
| `~/.pi/agent/settings.json` and `.pi/settings.json`, precedence rules, model/provider/thinking-budget keys, `compaction.*`, `retry.*`, resource keys (`extensions`, `skills`, `prompts`, `packages`), session-dir resolution | [`references/settings-and-config.md`](references/settings-and-config.md) |
| Our vendored `subagent` extension — anatomy of `index.ts` and `agents.ts`, the one active local patch (`tool_execution_*` UI refresh), dropped-patch history, extension points for migrations, spawn argv shape | [`references/subagent-internals.md`](references/subagent-internals.md) |
| Bumping the vendored snapshot to a newer upstream pi version — diff procedure, patch re-application, CHANGELOG review, behaviors that have historically drifted | [`references/versioning-and-upstream.md`](references/versioning-and-upstream.md) |

## Agent Boundaries

| Domain | Delegate to | When |
| --- | --- | --- |
| TypeScript code review of changes to `agent/extensions/subagent/*.ts` | `code-review-expert` | After drafting an implementation; orchestrator runs `/review` |
| Security review of new tool capabilities, blast-radius questions, capability grants | `security-review-expert` | When adding a new tool or relaxing an allowlist |
| Shell-script hardening of `setup.sh`, install flow, pre-commit hooks | `shell-expert` | Bash/POSIX questions about the installer |
| Documentation rewrites of `agent/AGENTS.md`, `adrs/`, README, or rule files | `docs-expert` | Style/structure passes; this skill stays out of doc rewriting |
| Workflow PR/release process for the `pi_config` repo itself | `gitflow-expert` | Branching, PR opening, merge strategy |

This skill **does not** cover: writing pi extensions from scratch as a tutorial (point to `docs/extensions.md` and `examples/extensions/` directly), debugging the LLM's reasoning, or general TypeScript style.

## Pitfalls and gotchas

- **Doc-vs-runtime event-name drift.** `docs/json.md` and `docs/extensions.md` are usually authoritative, but specific event field names have shifted between releases (the upstream `tool_result_end` handler in our vendored extension remains dead against pi 0.78.0 because pi emits `tool_execution_start`/`tool_execution_end` — patched in pi_config #46; see `references/subagent-internals.md`). When parsing the JSON event stream, verify event names against `dist/core/agent-session.js` in the *currently installed* pi.
- **`-p` mode is single-shot.** Subagents spawned via `pi --mode json -p --no-session` consume one prompt and exit. There is no documented stdin steering channel during a `-p` run. In-process steering (`pi.sendMessage({ deliverAs: "steer" })`) only works inside the same pi process — not across the subprocess boundary.
- **Frontmatter is whitelisted, not free-form.** Our `agent/extensions/subagent/agents.ts` reads only `name`, `description`, `tools`, `model`. Adding new frontmatter keys (e.g. `thinking`, `max_turns`) requires extending the parser *and* the subprocess argv in `index.ts`. Pi's own skill loader has a different whitelist (per `docs/skills.md`); the two are independent.
- **Skill `name` need not match the directory.** Pi relaxes the Agent Skills spec here. Don't assume parent-dir-name equals skill-name in code that walks the skills tree.
- **Skill `description` ≤ 1024 chars** — exceeding this is a hard failure (skill won't load). `name` ≤ 64 chars, lowercase + digits + hyphens only.
- **`disable-model-invocation: true`** hides a skill from `<available_skills>` (no auto-trigger). Users invoke it via `/skill:name`, or the matching agent wrapper loads it explicitly via `read` inside the spawned subprocess. All 20 wrapper-paired skills in this repo set this flag — it forces routing through the `subagent` tool and trims the parent system prompt. The three review specialists are *additionally* gated by opus pinning and a read-only tool allowlist. See `agent/AGENTS.md`.
- **Vendored ≠ tracked.** Bumping pi (`npm update -g @earendil-works/pi-coding-agent`) does not update our vendored copy at `agent/extensions/subagent/`. That copy is pinned to a snapshot version recorded in its README; bumping is an explicit operation governed by `references/versioning-and-upstream.md`.
