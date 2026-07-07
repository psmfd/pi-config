# Subagent Example

> **Vendored from pi 0.80.2** (source: `examples/extensions/subagent/` in the pi 0.80.2 release tarball); re-paired from pi 0.78.1 on 2026-07-07 (pi_config #396; prior audits: 0.78.1 pi_config #296, 0.75.4 pi_config #136). Trivial upstream deltas adopted (`CONFIG_DIR_NAME` / `getAgentDir()` usage in `agents.ts` and the tool description help strings). Patch #3 (`tool_execution_*` UI refresh) retained and **expanded** to also consume `tool_execution_update` — pi 0.80.2 still ships the dead `tool_result_end` branch in the example (unchanged since 0.78), and pi's runtime emits `tool_execution_{start,update,end}` + a separate `tool_result` middleware event per `pi/docs/rpc.md` § 855–898 and `pi/docs/extensions.md` § 596–615. Consuming `tool_execution_update` closes pi_config #46. Patches #4a–d (Copilot fallback rung, oMLX liveness probe, spawn-time pin gate, supporting imports) are our own ADR-0080/ADR-0081 policy layer and remain unchanged; they were previously undocumented in this table — corrected below. Patches #1 (full per-task output) and #2 (failed-task diagnostics) were dropped at the 0.75.4 re-audit (pi_config #136) when upstream adopted them per [earendil-works/pi#4710](https://github.com/earendil-works/pi/issues/4710).
>
> When updating, record the new source pi version here and in the commit message. See [ADR-0001](../../../adrs/0001-subagent-orchestration-substrate.md). The audit trap that let patches #4a–d go undocumented between 0.75.4 and 0.80.2 is tracked as pi_config #582 — read that before the next re-pair.

## Local patches

This vendored copy carries downstream patches that diverge from upstream `earendil-works/pi-mono` HEAD. When bumping the snapshot, re-apply or drop these patches based on whether they have been merged upstream. **Every patch below must be re-verified at each re-pair; adding a new local divergence to the vendored source requires appending a row here in the same PR AND regenerating `PATCH_MANIFEST.json` — `scripts/validate-subagent-drift.sh` (added under pi_config #582) fails `scripts/validate.sh` when either is missing.** See [`docs/vendor-updates.md`](../../../docs/vendor-updates.md) § Subagent extension for the full re-pair (Procedure B) and new-patch (Procedure A) workflows.

| # | Patch | Files | Rationale | Tracking |
|---|---|---|---|---|
| 3 | `tool_execution_*` UI refresh | `index.ts` (event-loop branch replacing dead `tool_result_end`) | Upstream 0.80.2's example still listens for `tool_result_end` with `event.message`, but pi's runtime does NOT emit that event — confirmed against `pi/docs/rpc.md` § 855–898 and `pi/docs/extensions.md` § 596–615, which document `tool_execution_start` / `tool_execution_update` / `tool_execution_end` (+ `tool_result` as a separate middleware event, not consumed here). We replace the dead branch with an `emitUpdate()` call on **all three** tool-execution edges so the orchestrator sees per-tool-call streaming progress during long child runs, without injecting synthetic messages into `currentResult.messages` (which would corrupt `getFinalOutput`). The `tool_execution_update` edge closes pi_config #46; surfacing the `partialResult` payload in the details table remains a future concern. | pi_config #46, expanded in pi_config #396; no upstream issue (upstream's example still points at a dead event) |
| 4a | Copilot fallback rung | `index.ts` (`DEFAULT_COPILOT_FALLBACK`, `readFallbackModelSetting`, `buildCopilotFallback`, `sanitizeFallbackModelId` import) | When a child agent's slash-qualified model pin (e.g. `omlx/coding-workhorse`) is unavailable at spawn time, substitute a cheapest-Copilot fallback rung (`github-copilot/gpt-5-mini` by default; operator-overridable via user-layer `extensionSettings.subagent.copilotFallbackModel`) before conceding to the session default. Reads USER-layer settings only — project-layer is deliberately not consulted (same trust boundary as token-meter per ADR-0073). | pi_config #519, #536, [ADR-0080](../../../adrs/0080-copilot-fallback-rung.md) |
| 4b | oMLX liveness probe | `index.ts` (`buildOmlxLiveness`, `filterDownOmlxIds`) | Probe the operator-local oMLX server once per tool call to narrow `availableModelIds` down to actually-serving IDs. Registered-but-down workhorse pins take the drop path and re-enter the fallback ladder (#519 → #536 → session default). Lazy: skipped entirely when no `omlx/*` id is registered. | pi_config #534, [ADR-0081](../../../adrs/0081-omlx-spawn-liveness-gate.md) |
| 4c | Spawn-time model-pin gate | `index.ts` (`resolveModelPin` call site, `CopilotFallback` type, `pinNote` field on `SingleResult`, `pin.modelArg`/`pin.note` argv handling, tool-result note surfacing) | Enforce that a slash-qualified pin only reaches child argv when its exact `provider/id` is credentialed; pi hard-exits a child whose `--model` names an unregistered provider. Dropped pins surface a note in the tool result naming which rung the child actually ran on. | pi_config #519, [ADR-0080](../../../adrs/0080-copilot-fallback-rung.md) |
| 4d | Support imports + separate `model-pin.ts` | `index.ts` (imports from `../shared/{copilot,omlx}-discovery.ts` and `./model-pin.ts`), `model-pin.ts`, `test/model-pin.test.ts` | Backing implementation for patches #4a–c. `model-pin.ts` is a purely-local sibling of the vendored source. Discovery helpers live under `agent/extensions/shared/` (foundation layer, ADR-0071). | (support surface for #4a–c) |

> Prior to the pi 0.80.2 re-pair, patches #4a–d were present in the vendored source but **not registered** in this table. This corrective inventory landed in pi_config #396; the mechanical check preventing recurrence — the diff-signature manifest at [`PATCH_MANIFEST.json`](./PATCH_MANIFEST.json) validated by [`scripts/validate-subagent-drift.sh`](../../../scripts/validate-subagent-drift.sh) — landed in pi_config #582.

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```text
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent

```text
Use scout to find all authentication code
```

### Parallel execution

```text
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow

```text
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts

```text
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):

- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):

- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:

- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting** (mimics built-in tools):

- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Model pins and the spawn-time gate (#519/#536, ADR-0076/ADR-0080):** a
slash-qualified `model:` pin (`provider/id`, e.g. `omlx/coding-workhorse`) is
passed to the child as `--model` only when that exact provider/id is
credentialed in the model registry (`model-pin.ts`). When it is not, the
ADR-0076 tier ladder is walked before conceding — three outcomes, each with an
honest `[note]` line naming the rung the child actually ran on:

1. **Pin resolves** → passed through, no note. For an `omlx/*` pin this also
   requires the oMLX server to be **live** (#534, ADR-0081): a spawn-time probe
   (`shared/omlx-discovery.ts`, resolved once per tool call) drops a
   registered-but-down workhorse pin so it takes outcome 2 or 3 below, with a
   note distinguishing "the oMLX server appears to be down" (restart the
   process) from "not available on this host" (registration/config). An
   inconclusive probe (timeout, 5xx) fails open — the pin is kept, never
   falsely dropped.
2. **Pin dropped, Copilot fallback resolves** (#536): a non-`github-copilot`
   dropped pin substitutes the Copilot fallback model when it is
   registry-present AND not excluded by the live tier filter
   (`shared/copilot-discovery.ts`, ADR-0035 — a registered Copilot model can
   still be subscription-gated). A dropped `github-copilot/*` pin never
   substitutes a sibling (the rung itself is dead).
3. **Neither resolves** → `--model` omitted; the child inherits the session
   default, and the note says why each rung was skipped (absent vs tier-gated).

This is deliberate: pi hard-exits a child whose `--model` names a provider
with no registered models, and pins like the local oMLX workhorse
(operator-local `models.json`) or a Copilot model (login-gated) do not resolve
on every host. Slash-less pins pass through ungated and resolve via pi's own
pattern matching. If the registry cannot be read, the gate fails open (the pin
is passed; the fallback rung is never consulted without registry data). The
live tier set is resolved once per tool call — never per child — and its
discovery cache is cleared each `session_start`.

**Settings:** the fallback target defaults to `github-copilot/gpt-5-mini` —
the cheapest picker-enabled Copilot chat model under AI-Credits billing
(ADR-0080 Q2); fan-out children are the quota-frugal rung, not the review
trio's quality rung. Override per operator in `~/.pi/agent/settings.json`:

```jsonc
{ "extensionSettings": { "subagent": { "copilotFallbackModel": "github-copilot/claude-haiku-4-5" } } }
```

Only the **user-layer** settings file is honored — a project's
`.pi/settings.json` cannot redirect fan-out spend (same trust boundary as
token-meter, ADR-0073). A value that is not a qualified `github-copilot/<id>`
string falls back to the built-in default.

**Locations:**

- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
