# Subagent extension internals

Authoritative source: the vendored extension itself at `agent/extensions/subagent/` (1,135 lines across `index.ts` and `agents.ts`) and `agent/extensions/subagent/README.md` for patch provenance. This reference is the map of what the extension does, what we've patched, and what footguns exist.

## Provenance

Vendored from `@earendil-works/pi-coding-agent@0.78.0` `examples/extensions/subagent/`. The pinned upstream version lives in `agent/extensions/subagent/README.md`. One local patch diverges from upstream HEAD: patch #3 (`tool_execution_*` UI refresh), tracked in pi_config issue #46. Patches #1 (full per-task output) and #2 (failed-task diagnostics) were dropped at the 0.75.4 re-audit after upstream adopted them. See `agent/extensions/subagent/README.md` for the patch table.

## File layout

```text
agent/extensions/subagent/
├── index.ts          # 1009 lines — tool registration, modes, subprocess mgmt, rendering
├── agents.ts         # 126 lines — agent discovery + frontmatter parsing
└── README.md         # Provenance + patch table
```

## `agents.ts` — agent discovery

Single responsibility: walk `~/.pi/agent/agents/` and `.pi/agents/` (nearest ancestor in cwd chain), parse frontmatter from each `*.md`, return an `AgentConfig[]`.

### `AgentConfig` shape (lines 11-20)

```typescript
interface AgentConfig {
  name: string;            // From frontmatter `name:`
  description: string;     // From frontmatter `description:`
  tools?: string[];        // From frontmatter `tools:` (comma-split)
  model?: string;          // From frontmatter `model:`
  systemPrompt: string;    // The .md body after frontmatter
  source: "user" | "project";
  filePath: string;
}
```

### Frontmatter contract (lines 54-71)

Only four keys read: `name`, `description`, `tools`, `model`. **All other frontmatter keys are silently ignored.** This is the single biggest constraint on migrating tintinweb-style features — adding any new agent-level config requires extending this parser *and* the spawn argv in `index.ts`.

### Discovery walk (lines 87-117)

`findNearestProjectAgentsDir(cwd)` walks up from `cwd` looking for `<dir>/.pi/agents`, stopping at filesystem root. **Note the path: `.pi/agents`, not `.pi/agent/agents`.** Project-level discovery uses a different layout from the global location.

`discoverAgents(cwd, scope)` builds a `Map<name, AgentConfig>`:

| `scope` | Behavior |
|---|---|
| `"user"` (default) | Only `~/.pi/agent/agents/`. |
| `"project"` | Only nearest `.pi/agents/`. |
| `"both"` | Both, with **project entries overriding user entries** on `name` collision. |

## `index.ts` — tool registration and execution

### Tool schema (lines 416-429)

The `subagent` tool accepts a union of three modes via top-level params:

| Param | Mode signal |
|---|---|
| `agent` + `task` | Single |
| `tasks: [{ agent, task, cwd? }, ...]` | Parallel |
| `chain: [{ agent, task, cwd? }, ...]` | Chain (sequential with `{previous}` placeholder) |

Plus `agentScope` (`"user"` / `"project"` / `"both"`, default `"user"`) and `confirmProjectAgents` (default `true` — prompts when running project agents, no-op in headless modes via `ctx.hasUI` check).

Validation (`index.ts:452-465`) requires **exactly one** mode. Multi-mode or zero-mode invocations return a usage hint listing available agents.

### Subprocess invocation (lines 261-281, `runSingleAgent`)

Argv assembly:

```typescript
const args = ["--mode", "json", "-p", "--no-session"];
if (agent.model) args.push("--model", agent.model);
if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
// Prompt body is written to a 0o600 temp file (see writePromptToTempFile at
// index.ts:210); only the path enters argv. This avoids leaking prompt content
// to `ps` / argv inspection and keeps argv length bounded.
args.push("--append-system-prompt", tmpPromptPath);
args.push(`Task: ${task}`);                         // user task as positional prompt
```

The prompt-temp-file path is unlinked on `proc.exit` (`index.ts:394-396`) regardless of exit code.

Spawn config:

- `cwd`: explicit `cwd` param > tool-call `cwd` > orchestrator's `ctx.cwd`
- `shell: false` — direct exec, no shell expansion
- `stdio: ["ignore", "pipe", "pipe"]` — no stdin, capture stdout (JSON events) and stderr (diagnostics)

`getPiInvocation(args)` (helper) resolves the pi binary path — used because we can't always assume `pi` is in PATH for child invocations.

### Event stream parser

Per-line `JSON.parse` from stdout. Two event types are handled:

```typescript
if (event.type === "message_end" && event.message) {
  // Accumulate messages, count turns, sum usage, capture stopReason/errorMessage
}
if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
  emitUpdate();  // Per-tool-call UI refresh; no message accumulation
}
```

**Historical note:** upstream's branch listened for `tool_result_end` with `event.message`, but current pi emits `tool_execution_start` / `tool_execution_end` (no `message` field). Our one active local patch (pi_config #46; see `agent/extensions/subagent/README.md`) replaces the dead branch with the corrected event names and triggers UI refresh on both edges without polluting `currentResult.messages`.

### Per-message accumulation (lines 322-343)

For each `message_end` of an assistant role:

| Captured | Source |
|---|---|
| `messages[]` | Full message pushed |
| `usage.turns++` | Incremented per assistant message |
| `usage.input/output/cacheRead/cacheWrite` | Summed from `msg.usage` |
| `usage.cost` | Summed from `msg.usage.cost.total` |
| `usage.contextTokens` | Latest `msg.usage.totalTokens` (running total) |
| `model` | First non-null `msg.model` |
| `stopReason` | Latest `msg.stopReason` |
| `errorMessage` | Latest `msg.errorMessage` |

### Abort handling

`signal.aborted` from the orchestrator's tool call propagates: when fired, `proc.kill()` sends SIGTERM and `wasAborted = true`. The final result reflects `stopReason: "aborted"` in the parent's view of the run.

## Mode-specific execution

### Single mode (lines 661-687)

Calls `runSingleAgent`, then:

- On success: returns `{ content: [{ type: "text", text: getFinalOutput(result.messages) }] }`.
- On failure: returns `isError: true` with fallback diagnostic (`errorMessage` → `stderr` → `getFinalOutput` → `"(no output)"`).

### Parallel mode (lines 590-651)

Spawns all `tasks` concurrently via `Promise.all`. Per-task update callbacks merge into a shared `allResults[]` indexed by position; `emitParallelUpdate()` flushes the merged view to the TUI.

**Historical parallel-mode patch zone:** patches #1 and #2 used to live here. Upstream now returns full per-task output up to the per-task cap and preserves failed-task diagnostics, so those downstream patches were dropped at the 0.75.4 re-audit. Keep this section in mind when auditing regressions in parallel-mode output, but it is no longer an active local patch zone.

Currently no documented per-task concurrency cap in code — `Promise.all` runs all tasks at once. The 8-task / 4-concurrent cap referenced in `AGENTS.md` is enforced by the orchestrator's discipline, not by code.

### Chain mode (lines 503-578)

Sequential. Each step's task string has `{previous}` placeholders replaced with the previous step's final output before invocation. Aborts the chain on the first failure. Per-step results stream live as they complete.

## Rendering

`renderCall(args, theme, ctx)` (lines 696-810) — pre-execution tool call rendering. Shows mode, scope, and a preview of up to 3 agents/tasks/steps.

`renderResult(result, options, theme, ctx)` (lines 811-1006) — post/streaming result rendering with two view states (`collapsed` and `expanded`):

- **Collapsed** (default): one-line per agent with usage stats (turns, tokens, duration, cost).
- **Expanded** (Ctrl+O): full per-task transcript with tool-call previews and final output rendered as markdown.

The collapsed/expanded split is where the historical upstream truncation defect originated — full output was emitted only to `details` (visible in expanded view) but not to the `content` returned to the model. Upstream adopted that fix before the 0.75.4 re-audit, so the current vendored copy preserves full `content` output without a downstream patch.

## Constants and caps (in-code, not configurable)

| Constant | Value | Location | Effect |
|---|---|---|---|
| `PER_TASK_OUTPUT_CAP` | 50,000 bytes | `index.ts:633` | Per-task output cap in parallel-mode summary returned to the model |
| (no explicit concurrency cap) | — | — | Parallel `Promise.all` — all tasks dispatched simultaneously |
| `--no-session` | — | `index.ts:265` | Children never write session files |

## Defects and known issues

| Issue | Location | Severity | Notes |
|---|---|---|---|
| ~~Stale event name `tool_result_end`~~ | ~~`index.ts:344`~~ | **Fixed** (pi_config #46 patch) | Replaced with `tool_execution_start` / `tool_execution_end` — UI now refreshes per tool call. Listed here for historical context. |
| No per-task concurrency cap in code | `index.ts` parallel mode | Low | Discipline-enforced via AGENTS.md (8/4). Production rate-limit issues would surface here first. |
| Project-agents path is `.pi/agents` not `.pi/agent/agents` | `agents.ts:87` | Documentation, not bug | Different from global path; intentional but easy to miss. |
| Frontmatter parser silently ignores unknown keys | `agents.ts:54-71` | Design — by intent | Means new fields like `thinking`, `max_turns`, `extensions` need parser-side and argv-side changes together. |

## Extension points (for future migrations)

If we want to migrate tintinweb capabilities, the touch points are:

| Feature | `agents.ts` change | `index.ts` change | Other |
|---|---|---|---|
| `thinking:` frontmatter | Add to parse + `AgentConfig` | Add `--thinking <level>` to argv assembly (`runSingleAgent`) | None |
| `extensions: false` | Add to parse + `AgentConfig` | Add `--no-extensions` to argv | None |
| `max_turns` (hard) | Add to parse + `AgentConfig` | Count `message_end` (assistant) events; `proc.kill("SIGTERM")` at threshold | Result needs new `stopReason` value like `"max_turns"` |
| `max_turns` (graceful) | Same | Same counting; instead of SIGTERM, write a steer message — but **`-p` mode has no documented stdin steering**. Likely needs an in-child extension that watches counts via its own event subscription. | Significant — see [`extension-api.md`](extension-api.md#pisendmessagemessage-options--programmatic-steering) |
| `skills:` preload list | Add to parse + `AgentConfig` | Resolve names to paths; emit `--skill <path>` per item | Skill discovery code in `agents.ts` would need a counterpart for skill paths |
| Worktree isolation | Add to parse + `AgentConfig` | Pre-spawn: `git worktree add`; post-completion: commit or remove; pass new path as `cwd` | Significant — pairs with hook integration |
| Background queue | Major | Major — needs registry, status polling tool, completion injection | Effectively a rewrite of the parallel-mode model |

The first three rows are small and additive — recommended path in the prior migration analysis. The last three are substantial.
