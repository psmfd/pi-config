# Settings and configuration

Authoritative source: `docs/settings.md` in the installed pi package. This reference summarizes the settings keys that affect orchestration behavior, the precedence rules, and the directory layout our `setup.sh` produces.

## Files and precedence

| Path | Scope | Written by |
|---|---|---|
| `~/.pi/agent/settings.json` | Global — all projects | Operator, `/settings` (limited keys) |
| `.pi/settings.json` | Project — current cwd | Operator, `/settings`, never the harness |

Project settings **override** global settings on any key present in both. Missing keys fall back to global, then to compiled-in defaults. Pi merges shallowly per top-level key (no deep merge inside objects — overrides are key-level replacements).

Paths inside `~/.pi/agent/settings.json` resolve relative to `~/.pi/agent`. Paths inside `.pi/settings.json` resolve relative to `.pi`. Absolute paths and `~` are supported.

## Directory layout produced by `setup.sh`

Our installer symlinks the repo's `agent/` contents into `~/.pi/agent/`:

```text
~/.pi/agent/
├── AGENTS.md                    → repo/agent/AGENTS.md (user-level orchestrator context)
├── settings.json                → repo/agent/settings.json
├── skills/<name>/SKILL.md       → repo/agent/skills/<name>/SKILL.md
├── agents/<name>.md             → repo/agent/agents/<name>.md
├── prompts/<name>.md            → repo/agent/prompts/<name>.md
├── rules/<name>.md              → repo/agent/rules/<name>.md
└── extensions/<name>/index.ts   → repo/agent/extensions/<name>/index.ts
```

Symlinks mean **edits in the repo take effect immediately** in any new pi session (or after `/reload` for extensions). No copy step.

Project overrides live in `<project>/.pi/` and are *not* managed by this repo.

## Settings keys relevant to orchestration

The full list is in `docs/settings.md`. The keys below are the ones that materially affect how subagents behave or that we'd potentially set per-project.

### Model and thinking

| Key | Type | Notes |
|---|---|---|
| `defaultProvider` | string | `"anthropic"`, `"openai"`, etc. |
| `defaultModel` | string | Model id used when no `--model` flag is passed |
| `defaultThinkingLevel` | `"off"`/`"minimal"`/`"low"`/`"medium"`/`"high"`/`"xhigh"` | Clamped to model capabilities |
| `hideThinkingBlock` | boolean | UI only |
| `thinkingBudgets` | `{ minimal, low, medium, high }: number` | Token budgets per level — affects cost when subagents use thinking |
| `enabledModels` | string[] | Patterns for Ctrl+P cycling, same format as `--models` |

If we add `thinking:` to agent frontmatter, the per-agent value will override `defaultThinkingLevel` for that subagent run (via `--thinking` on the child argv).

#### `--model` pattern footgun

`--model` accepts either an exact `provider/id` or a fuzzy pattern (with optional `:<thinking>` suffix). The matcher is loose — it ranges across multiple model families. Empirically on pi 0.78.1 with the `github-copilot` provider:

- `--list-models opus` → matches the four claude-opus-4.x entries **and** all three claude-sonnet-4.x entries (substring/character overlap, not strict prefix).
- `--list-models gpt-5` → matches every gpt-5.x entry **and** claude-haiku-4.5, claude-opus-4.5, claude-sonnet-4.5, gemini-2.5-pro, gemini-3.5-flash (the literal `5` matches the `.5` in version numbers).
- `--list-models "claude-opus:high"` → returns "No models matching" — the `:thinking` suffix is not a valid pattern token in `--list-models` (it is valid in `--model`).

**Implication:** for `defaultModel`, agent frontmatter `model:`, and any place where deterministic resolution matters, **use exact ids** (`claude-opus-4.7`, `gpt-5.4-mini`) — not bare family names. Patterns are an interactive-picker convenience, not a config-file primitive. ADR-0026 records this finding alongside the `models.json` decision.

#### Custom-provider overrides (`agent/models.json`)

Pi's `github-copilot` provider catalog is hardcoded per pi release (`docs/providers.md`: *"For each provider, pi knows all available models. The list is updated with every pi release."*). To add a Copilot model ahead of the next pi release, populate `agent/models.json` — pi reads it at `~/.pi/agent/models.json`, which our setup.sh symlinks from the repo. Merge-by-id semantics from `docs/models.md`:

- New ids are added alongside built-ins.
- Matching ids replace built-ins.
- JSONC comments and trailing commas are supported.

Hard prerequisites that `models.json` cannot bypass:

1. The model must be enabled in the operator's VS Code Copilot Chat picker (per `docs/providers.md`).
2. The model must be exposed to the operator's Copilot subscription tier server-side. Tier-gated exclusions (e.g. MAI-Code-1-Flash on enterprise as of 2026-06-07) cannot be unlocked locally regardless of `models.json` contents.

Full field schema for the per-model object: `docs/models.md` "Model Configuration" table. The on-disk reference at `/home/pdavis/.cache/pi_config/pi-v<ver>/pi/docs/models.md` is authoritative for the installed version. See ADR-0026 for the forward-fix decision.

### Compaction

| Key | Default | Notes |
|---|---|---|
| `compaction.enabled` | `true` | Auto-compaction on context-window pressure |
| `compaction.reserveTokens` | `16384` | Reserved for LLM response |
| `compaction.keepRecentTokens` | `20000` | Recent tokens kept verbatim, rest summarized |

Subagent children run with `--no-session` (ephemeral) but compaction can still fire mid-run on long tasks. If we add `max_turns` budgeting, compaction interaction needs thought: a compacted child may still produce a valid final answer even if it would otherwise hit the turn limit.

### Retry

| Key | Default | Notes |
|---|---|---|
| `retry.enabled` | `true` | Agent-level retry on transient errors |
| `retry.maxRetries` | `3` | Agent-level attempts (exponential backoff: 2s, 4s, 8s) |
| `retry.baseDelayMs` | `2000` | Backoff base |
| `retry.provider.timeoutMs` | SDK default | Per-request timeout |
| `retry.provider.maxRetries` | SDK default | Provider-level retries |
| `retry.provider.maxRetryDelayMs` | `60000` | Fail fast if provider asks for a longer delay (e.g. Google "5h quota reset") |

Retries are transparent to our `subagent` extension: a retrying child still emits one final `agent_end`. The retry events (`auto_retry_start`, `auto_retry_end`) appear in the JSON stream and could be surfaced as progress updates if we wanted to differentiate "slow" from "stuck".

### Message delivery

| Key | Default | Notes |
|---|---|---|
| `steeringMode` | `"one-at-a-time"` | How steering messages flush — affects `pi.sendMessage({ deliverAs: "steer" })` |
| `followUpMode` | `"one-at-a-time"` | Same for `"followUp"` |
| `transport` | `"sse"` | `"sse"` / `"websocket"` / `"auto"` for providers that support both |

Relevant if we implement graceful `max_turns` via self-steering inside the child.

### Sessions

| Key | Default | Notes |
|---|---|---|
| `sessionDir` | `~/.pi/agent/sessions` | Overridden by `--session-dir` (highest), then `PI_CODING_AGENT_SESSION_DIR` |

Children run with `--no-session` so this doesn't apply, but it matters for operator runs of `pi -r` to browse past sessions.

### Resources

| Key | Type | Notes |
|---|---|---|
| `packages` | array | npm/git packages to load resources from |
| `extensions` | string[] | Additional extension paths beyond auto-discovery |
| `skills` | string[] | Additional skill paths/dirs |
| `prompts` | string[] | Additional prompt-template paths/dirs |
| `themes` | string[] | Additional theme paths |

Useful if we want to load extensions from a different path during development without symlinking. Most of our config goes through `setup.sh` symlinks instead.

### Shell

| Key | Notes |
|---|---|
| `shellPath` | Custom shell binary (e.g. Cygwin on Windows) |
| `shellCommandPrefix` | Prefix injected before every bash command (e.g. `"shopt -s expand_aliases"`) |
| `npmCommand` | argv for npm operations — useful with mise/asdf/nvm |

### UI

| Key | Notes |
|---|---|
| `theme` | `"dark"` / `"light"` / custom |
| `quietStartup` | Hide startup header — quieter for headless / scripted use |
| `doubleEscapeAction` | `"tree"` / `"fork"` / `"none"` |

`quietStartup: true` is useful for child subagents to reduce stderr noise, but pi already suppresses most of this in `-p` mode.

## Environment variables that override settings

| Variable | Overrides |
|---|---|
| `PI_CODING_AGENT_DIR` | The entire `~/.pi/agent` location |
| `PI_CODING_AGENT_SESSION_DIR` | `sessionDir` (beaten by `--session-dir`) |
| `PI_PACKAGE_DIR` | Package install location |
| `PI_OFFLINE` | Disables all startup network ops |
| `PI_SKIP_VERSION_CHECK` | Disables just the pi version check |
| `PI_TELEMETRY` | Override install/update telemetry |
| `PI_CACHE_RETENTION=long` | Extended prompt cache where supported |

## CLI flags that override settings

Any `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, `--no-session`, `--no-tools`, `--no-builtin-tools` flag disables the corresponding settings discovery. Explicit `--extension`, `--skill`, `--prompt-template`, `--theme` flags load *in addition* to settings (and survive `--no-*` for their resource type).

## Precedence summary

For a setting `X`, value is resolved in order:

1. CLI flag (if applicable)
2. Environment variable (if applicable)
3. `.pi/settings.json` (project, when in a project cwd)
4. `~/.pi/agent/settings.json` (global)
5. Compiled-in default

For our subagent children, CLI flags constructed by `index.ts` win over the child's own settings discovery on the keys we set (`--model`, `--tools`, `--no-session`). Everything else falls through to the child's inherited settings.

## Settings keys that DON'T exist (common false assumptions)

These keep getting asked about — they're not real:

- No `subagent.*` settings — our extension has no settings keys; behavior is per-agent frontmatter
- No `maxConcurrent` or `queueSize` — we cap parallel mode at 8 tasks / 4 concurrent in `index.ts` constants
- No `defaultAgent` — every `subagent` call must name an agent
- No skill-disable list in settings — use `disable-model-invocation` in the skill's own frontmatter instead
