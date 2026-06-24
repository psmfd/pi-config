# pi CLI and modes

Authoritative source: `docs/usage.md`, `docs/json.md`, `docs/rpc.md` in the installed pi package. This reference summarizes the parts that matter for orchestration substrate work — flags our `subagent` extension passes to child subprocesses, the JSON event stream shape it parses, and signal/exit semantics.

## Modes

| Flag | Meaning | Used by us? |
|---|---|---|
| (default) | Interactive TUI | Operator use |
| `-p`, `--print` | Read prompt, run to completion, print final response, exit. Single-shot. | **Yes** — every subagent invocation |
| `--mode json` | Emit all session events as JSON-Lines to stdout. Final response is one event among many. | **Yes** — paired with `-p` for child subprocesses |
| `--mode rpc` | Bidirectional stdio JSON-RPC. See `docs/rpc.md`. | No |
| `--export <in> [out]` | Export a session to HTML | No |

`-p` and `--mode json` compose: `pi --mode json -p "prompt"` emits the JSON event stream for a single non-interactive run, then exits. This is the exact invocation our `subagent` extension uses (`agent/extensions/subagent/index.ts:265` — `["--mode", "json", "-p", "--no-session"]`).

In `-p` mode pi also reads piped stdin and merges it into the initial prompt. Our extension does not pipe stdin (subprocess opens with `stdio: ["ignore", "pipe", "pipe"]`), so the entire prompt must be on argv.

## Flags relevant to subagent invocation

| Flag | Argument | Used by us | Notes |
|---|---|---|---|
| `--model` | `provider/id` or pattern with optional `:<thinking>` (e.g. `sonnet:high`) | Optional, per-agent | If unset, child inherits pi's resolved default model. |
| `--thinking` | `off`/`minimal`/`low`/`medium`/`high`/`xhigh` | **Not yet** — candidate for migration | Clamped to model capabilities; non-reasoning models always use `off`. |
| `--tools`, `-t` | comma-separated allowlist of built-in + extension + custom tool names | Yes, when `tools:` frontmatter is set | Built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. |
| `--no-builtin-tools`, `-nbt` | (none) | No | Keeps extension/custom tools, disables built-ins |
| `--no-tools`, `-nt` | (none) | No | Disables everything |
| `--no-session` | (none) | **Yes** — every invocation | Ephemeral; no `~/.pi/agent/sessions/<...>.jsonl` written for the child run. Avoids polluting session storage with subagent runs. |
| `--no-extensions` | (none) | No | Children currently inherit all extensions. |
| `--no-skills` | (none) | No | Children inherit skills. Explicit `--skill <path>` still loads even with `--no-skills`. |
| `--no-prompt-templates` | (none) | No | |
| `--no-context-files`, `-nc` | (none) | No | Disables `AGENTS.md` and `CLAUDE.md` discovery. |
| `--system-prompt <text>` | string | Effectively yes (via prompt body) | Replaces the default prompt; context files and skills still appended. |
| `--append-system-prompt <text>` | string | No | |
| `-e`, `--extension <source>` | path / npm / git ref | No | Repeatable. |
| `--skill <path>` | path | No | Repeatable; bypasses `--no-skills`. |
| `--list-models [search]` | optional pattern | No | Useful when verifying model availability before changing an agent. |
| `--verbose` | (none) | No | Forces verbose startup; noisy in JSON mode. |

Subagent argv assembled by `index.ts:265-281`:

```text
pi --mode json -p --no-session
   [--model <model>]
   [--tools <csv>]
   --system-prompt <agent-body-from-md-file>
   <task-string>
```

The agent's `.md` body becomes `--system-prompt`. The user's task is the positional prompt.

## Environment variables

| Variable | Purpose |
|---|---|
| `PI_CODING_AGENT_DIR` | Override `~/.pi/agent` for agents/skills/extensions/prompts/themes/settings discovery. Our `setup.sh` does **not** set this — we symlink into the default location. |
| `PI_CODING_AGENT_SESSION_DIR` | Override `~/.pi/agent/sessions/`. Beaten by `--session-dir`. |
| `PI_PACKAGE_DIR` | Override package install location (Nix/Guix). |
| `PI_OFFLINE` | Disable all startup network ops (update check, package update check, telemetry). |
| `PI_SKIP_VERSION_CHECK` | Skip just the pi version check (`pi.dev/api/latest-version`). |
| `PI_TELEMETRY` | `1`/`0` override for install/update telemetry. |
| `PI_CACHE_RETENTION=long` | Extended prompt cache where supported. |
| `VISUAL`, `EDITOR` | Editor for Ctrl+G. |

Pi inherits the full parent env when our extension spawns a child subprocess. Treat env as part of the blast radius.

## JSON event stream

Source of truth: `docs/json.md` for documented event types, `dist/core/agent-session.js` for the *current-version* event names emitted into the JSON stream.

The stream is JSON-Lines on stdout (one event per line, `\n`-terminated). The first line is a session header:

```json
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path"}
```

After that, events appear in temporal order until process exit. Our extension's parser (`index.ts:300-348`) splits on `\n` and `JSON.parse` each line, ignoring lines that fail to parse — defensive against partial-line buffering.

### Event categories (current pi version verified against installed `dist/`)

| Category | Events | Notes |
|---|---|---|
| Session | `session_start`, `session_shutdown`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_before_tree`, `session_tree` | Most don't fire in `-p` mode. |
| Agent lifecycle | `agent_start`, `agent_end` | `agent_end` carries final `messages` array. |
| Turn | `turn_start`, `turn_end` | `turn_end.message` is the assistant turn; `toolResults` is the tool results from that turn. |
| Message | `message_start`, `message_update`, `message_end` | `message_end` is what our extension keys on for usage accounting. |
| Tool execution (observational) | `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | Current event names (re-verified during the pi 0.78.0 re-audit). The upstream `subagent` extension still listens for the historical name `tool_result_end`; our vendored copy carries one active local patch to refresh the UI on the current event names (pi_config #46; see `agent/extensions/subagent/README.md`). |
| Tool gate (interceptable, in-process only) | `tool_call`, `tool_result` | Extension-side events; not present in the JSON stream. |
| Queue + retry + compaction | `queue_update`, `auto_retry_start`, `auto_retry_end`, `compaction_start`, `compaction_end` | Useful for debugging stuck child runs. |

When in doubt, run `pi --mode json -p "hello" 2>/dev/null | jq -c '.type'` against the installed pi to enumerate what actually appears. **The names in `docs/json.md` lag behind code occasionally — verify before depending on a specific name.**

### Message shape from `message_end`

`event.message` is an `AssistantMessage` (or `UserMessage`, etc.). Fields our subagent parser depends on:

| Field | Type | Used for |
|---|---|---|
| `role` | `"assistant"` / `"user"` / `"tool"` | Count assistant messages as turns |
| `model` | string | Capture model used (first non-null wins) |
| `usage` | `{ input, output, cacheRead, cacheWrite, totalTokens }` | Token accounting |
| `usage.cost.total` | number | Cost accumulation |
| `stopReason` | string | Surface in failed-task diagnostics (our patch) |
| `errorMessage` | string | Surface in failed-task diagnostics (our patch) |

Full type definitions: `packages/ai/src/types.ts` (linked from `docs/json.md`) — but they live in the source repo, not on disk. The compiled `.d.ts` files under `node_modules/@earendil-works/pi-coding-agent/dist/` are the on-disk authoritative shape.

## Exit codes and signals

- Normal completion: exit 0.
- LLM/tool error that aborts the run: exit non-zero with diagnostic on stderr. Our extension captures stderr separately and surfaces it in failed-task diagnostics.
- SIGTERM/SIGINT: pi traps and emits `session_shutdown` before exiting. Our extension propagates `signal.aborted` from the parent: when the orchestrator's tool call is aborted (`AbortSignal` fires), we send SIGTERM to the child via `proc.kill()`. The `wasAborted` flag distinguishes user-cancel from natural completion in the result.

## File arguments (`@file`)

Prefix files with `@` to include them in the message: `pi @prompt.md "Answer this"`. Supports images via `@screenshot.png`. We don't use this in the subagent path — we pass the full prompt as a single argv string — but operators use it when running pi directly.

## Mode behaviors that affect extensions

From `docs/extensions.md` → "Mode Behavior" (read it directly when authoring an extension): `ctx.hasUI` is `false` in `-p` and `--mode json`; dialog methods (`select`, `confirm`, `input`) are no-ops there. Extensions that prompt the user must handle headless mode explicitly. Our `subagent` extension does not prompt (it spawns children that themselves run in `-p`+JSON mode), so this is one-hop concern.
