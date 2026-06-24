# pi Extension API

Authoritative source: `docs/extensions.md` in the installed pi package (≈2,600 lines). This reference summarizes the API surface our `subagent` extension uses and the surfaces we'd touch when migrating tintinweb-style features (`thinking`, `max_turns`, graceful steering, etc.) into our vendored substrate.

## Extension shape

A pi extension is a TypeScript module with a default-exported factory:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Subscribe to events
  pi.on("session_start", async (event, ctx) => { /* ... */ });

  // Register tools/commands/shortcuts
  pi.registerTool({ /* ... */ });
  pi.registerCommand("name", { /* ... */ });
}
```

The factory may be `async` — pi awaits it before `session_start` fires. Use async factories for one-time startup work (remote model discovery, etc.). Our `subagent` extension is synchronous.

Loaded via [jiti](https://github.com/unjs/jiti), so TypeScript runs without compilation. Imports allowed: `@earendil-works/pi-coding-agent`, `typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, plus any npm dep in a sibling `package.json`, plus `node:*` built-ins.

## Discovery locations

| Location | Scope | Auto-reload via `/reload` |
|---|---|---|
| `~/.pi/agent/extensions/*.ts` | Global | Yes |
| `~/.pi/agent/extensions/<name>/index.ts` | Global (directory style) | Yes — **our `subagent` lives here** |
| `.pi/extensions/*.ts` | Project | Yes |
| `.pi/extensions/<name>/index.ts` | Project | Yes |
| `pi -e <path>` | Ad-hoc | No |
| `settings.json` `packages[]` (npm/git) | Per-source | Yes |
| `settings.json` `extensions[]` (paths) | Per-source | Yes |

Our `setup.sh` symlinks `agent/extensions/subagent/` into `~/.pi/agent/extensions/subagent/`. The directory must contain `index.ts` as the entry point.

## `pi.registerTool(definition)`

The single most important API for us — this is how our `subagent` tool gets exposed to the orchestrator LLM.

```typescript
pi.registerTool({
  name: "subagent",            // LLM-visible name
  label: "Subagent",           // UI label
  description: "...",          // Goes into the tool spec the LLM sees
  promptSnippet?: string,      // One-line entry in system-prompt "Available tools"
  promptGuidelines?: string[], // Bullets appended to "Guidelines" section
  parameters: Type.Object({    // TypeBox schema
    agent: Type.Optional(Type.String({ description: "..." })),
    // ...
  }),
  prepareArguments?(args): args, // Optional compatibility shim, runs pre-validation
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // signal: AbortSignal — propagates user cancel
    // onUpdate({ content: [...] }): stream progress to TUI
    // ctx: ExtensionContext — ui, cwd, modelRegistry, sessionManager, etc.
    return {
      content: [{ type: "text", text: "..." }],
      details: { /* arbitrary */ },
    };
  },
  renderCall?(args, theme, context),    // Optional custom TUI rendering of the tool call
  renderResult?(result, options, theme, context), // Optional custom result rendering
});
```

Subtleties from `docs/extensions.md`:

- `promptGuidelines` bullets are appended **flat** to the Guidelines section with no tool-name prefix. Each bullet must name the tool explicitly ("Use my_tool when…" not "Use this tool when…") — the LLM can't tell which tool "this" means.
- Tools can be registered at extension load OR inside event handlers. `pi.getAllTools()` reflects them immediately.
- `pi.setActiveTools(names)` toggles the active allowlist at runtime — useful for permission gates.
- `sourceInfo.source` on a tool: `"builtin"`, `"sdk"`, or extension-source metadata. Filter to detect built-ins.

Our `subagent` extension registers exactly one tool; see `index.ts:432-433`.

## Event catalog

Subscribe via `pi.on(eventName, async (event, ctx) => { ... })`. Most events are observational; a subset are interceptable.

### Lifecycle

| Event | Fires when | Interceptable |
|---|---|---|
| `session_start` | Session begins (`reason: "startup" \| "new" \| "resume" \| "fork"`) | No |
| `session_shutdown` | Session ends | No |
| `session_before_switch` | Before `/resume`/`/new` | **Cancellable** |
| `session_before_fork` | Before `/fork`/`/clone` | **Cancellable** |
| `session_before_compact` | Before `/compact` or auto-compaction | **Cancellable / customizable** |
| `session_compact` | After compaction completes | No |
| `session_before_tree` / `session_tree` | `/tree` navigation | First is cancellable |
| `resources_discover` | After `session_start` — extensions can contribute extra skill/prompt/theme paths | Returns paths |

### Agent turn

| Event | Fires when | Interceptable |
|---|---|---|
| `before_agent_start` | Just before each agent run begins | **Can inject message, modify system prompt** |
| `agent_start` / `agent_end` | Run starts / ends | No |
| `turn_start` / `turn_end` | Each LLM turn within a run | No |
| `message_start` / `message_update` / `message_end` | Message lifecycle | No |
| `context` | Before each turn — can modify the message array sent to provider | **Yes** |
| `before_provider_request` | About to call the model | **Can inspect or replace payload** |
| `after_provider_response` | Got HTTP response, before stream consume | Observational (status + headers) |

### Tool gate (in-process only — not in JSON stream)

| Event | Fires when | Interceptable |
|---|---|---|
| `tool_execution_start` | LLM is about to call a tool | No |
| `tool_call` | Tool input is finalized | **Can block** (`return { block: true, reason: "..." }`) |
| `tool_execution_update` | Streaming tool progress | No |
| `tool_result` | Tool returned, before added to context | **Can modify result** |
| `tool_execution_end` | Tool fully done | No |

Our `bash-destructive-guard` and `secrets-guard` extensions hook `tool_call` to block on dangerous inputs.

### User input

| Event | Notes |
|---|---|
| `input` | Fires after extension commands are checked but **before** skill (`/skill:name`) and template (`/template`) expansion. `event.source`: `"interactive"` / `"rpc"` / `"extension"`. Return `{ action: "transform", text, images }` to rewrite, or `{ action: "handled" }` to short-circuit. Transforms chain. |
| `user_bash` | `!` / `!!` user shell commands. Can replace bash operations or return result directly. |

### Model / thinking

| Event | Notes |
|---|---|
| `model_select` | Model changed via `/model` or Ctrl+P |
| `thinking_level_select` | Thinking level changed (settings, keybinding, or `pi.setThinkingLevel()`) |

### Processing order, summarized

```text
user input
  → extension commands (/cmd) checked
  → input event (transform/handle)
  → skill expansion (/skill:name)
  → template expansion (/template)
  → before_agent_start
  → agent_start
    → repeat: turn_start → context → before_provider_request
              → message_* → tool_execution_start → tool_call → tool_result
              → tool_execution_end → turn_end
  → agent_end
```

## `ExtensionContext` (`ctx`)

Passed to every handler and to `execute()`. Key fields:

| Field | Use |
|---|---|
| `ctx.ui` | `notify`, `confirm`, `select`, `input`, `editor`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`, `custom` (full TUI components). |
| `ctx.hasUI` | `false` in `-p` and `--mode json`. Dialogs are no-ops in headless. |
| `ctx.cwd` | Current working directory. |
| `ctx.sessionManager` | Read-only session-state access. `getEntries()`, `getBranch()`, `getLeafId()`. |
| `ctx.modelRegistry` / `ctx.model` | Resolve models, access API keys. |
| `ctx.signal` | Current agent abort signal, or `undefined` when no turn is active. Use for `fetch(..., { signal })`. |
| `ctx.isIdle()` / `ctx.abort()` / `ctx.hasPendingMessages()` | Control flow. |
| `ctx.shutdown()` | Programmatic shutdown. |
| `ctx.getContextUsage()` | Returns `{ tokens, percent }` for the current branch. |
| `ctx.compact()` | Trigger compaction programmatically. |
| `ctx.getSystemPrompt()` | Read the resolved system prompt. |

Command handlers (`pi.registerCommand`) get an extended `ExtensionCommandContext` with session-manipulation methods: `newSession`, `fork`, `navigateTree`, `switchSession`, `reload`, `waitForIdle`. **Captured `ctx` becomes stale after `newSession`/`fork`/`switchSession`/`reload`** — pi invalidates it.

## `pi.sendMessage(message, options?)` — programmatic steering

The documented mechanism for injecting messages mid-run. Critical for any future graceful-shutdown work.

```typescript
pi.sendMessage({
  customType: "my-extension",
  content: "Wrap up immediately — provide your final answer now.",
  display: true,
  details: { /* ... */ },
}, {
  deliverAs: "steer",     // or "followUp" or "nextTurn"
  triggerTurn: true,      // if agent is idle, trigger an LLM response
});
```

`deliverAs` modes:

| Mode | Behavior |
|---|---|
| `"steer"` (default) | Queued while streaming. Delivered after the current assistant turn finishes executing its tool calls, **before the next LLM call**. This is what a "wrap up" signal would use. |
| `"followUp"` | Waits for the agent to finish entirely (no more tool calls). |
| `"nextTurn"` | Queued for the next user prompt. Does not interrupt or trigger anything. |

`pi.sendUserMessage(content, options?)` is similar but injects an **actual user message** (appears typed). Same `deliverAs` semantics; always triggers a turn.

**Critical for migration planning:** `pi.sendMessage` is **in-process only**. It steers the pi process the extension is loaded in. It does **not** cross subprocess boundaries — calling it from the orchestrator's `subagent` extension affects the orchestrator's own session, not the child subprocess. Steering a child subagent would require either (a) an extension loaded inside the child that watches turn counts and self-steers via `pi.sendMessage`, or (b) sending input on the child's stdin (not documented as supported in `-p` mode).

## `pi.events` — extension-to-extension bus

A separate event bus for extensions to coordinate without coupling:

```typescript
pi.events.on("my:event", (data) => { /* ... */ });
pi.events.emit("my:event", { /* ... */ });
```

Used by tintinweb's pi-subagents for `subagents:created/started/completed/failed/...` lifecycle events and `subagents:rpc:*` cross-extension RPC. Our `subagent` extension does not currently emit on this bus.

## Other API methods

| Method | Purpose |
|---|---|
| `pi.registerCommand(name, opts)` | Register `/name` slash command |
| `pi.registerShortcut(keybind, opts)` | Keybinding |
| `pi.registerFlag(name, opts)` | CLI flag accessible via `pi.getFlag(name)` |
| `pi.registerMessageRenderer(customType, renderer)` | Custom rendering for `customType` messages |
| `pi.registerProvider(name, config)` | Add/override a model provider |
| `pi.unregisterProvider(name)` | Remove a provider |
| `pi.appendEntry(customType, data?)` | Persist extension state (does NOT participate in LLM context) |
| `pi.setSessionName(name)` / `pi.getSessionName()` | Session display name |
| `pi.setLabel(entryId, label)` | Label an entry |
| `pi.exec(command, args, options?)` | Shell exec helper |
| `pi.getActiveTools()` / `pi.getAllTools()` / `pi.setActiveTools(names)` | Tool allowlist mgmt |
| `pi.setModel(model)` | Returns `false` if no API key |
| `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)` | Thinking mgmt |

## Custom UI

Three escalating tiers — read `docs/extensions.md` § "Custom UI" and `docs/tui.md` for the full surface:

1. **Fire-and-forget** — `ctx.ui.notify`, `ctx.ui.setStatus`, `ctx.ui.setWidget`, `ctx.ui.setTitle`.
2. **Dialogs** — `ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.input`, `ctx.ui.editor`. Block until user responds. No-ops in `-p`/JSON.
3. **Full TUI components** — `ctx.ui.custom(...)` with `@earendil-works/pi-tui` primitives (Text, Box, layout). Used for things like `/agents` interactive menus.

Our `subagent` extension uses `onUpdate({ content })` to stream progress per task, and custom `renderCall` / `renderResult` to format the per-task live view (`index.ts:740-1006`).

## Mode behaviors

| Mode | `ctx.hasUI` | Dialogs | Notify/Status/Widget |
|---|---|---|---|
| Interactive | `true` | Work | Render in TUI |
| `-p` print | `false` | No-op | No-op |
| `--mode json` | `false` | No-op | No-op |
| `--mode rpc` | `true` | Work via RPC sub-protocol | Emit RPC events to client |

Extensions used by child subagents must not depend on dialogs (children always run headless).
