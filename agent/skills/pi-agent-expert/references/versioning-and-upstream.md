# Versioning and upstream snapshot bumps

Authoritative sources: `agent/extensions/subagent/README.md` (current snapshot version + patch table), `adrs/0001-subagent-orchestration-substrate.md` (rationale for vendoring), and the installed pi `CHANGELOG.md` (release-by-release diffs). This reference is the procedure for safely bumping our vendored snapshot to a newer upstream pi version.

## Why we vendor

Per [ADR-0001](../../../../adrs/0001-subagent-orchestration-substrate.md): the upstream `examples/extensions/subagent/` ships as documentation, not a stability-promised API. Two issues motivated vendoring:

1. **Patch surface.** We carry one local patch (`tool_execution_*` UI refresh — see [`subagent-internals.md`](subagent-internals.md#event-stream-parser)). Without vendoring, an `npm update` could silently revert it. Patches #1 (full per-task output) and #2 (failed-task diagnostics) were dropped at the 0.75.4 re-audit after upstream adopted them.
2. **Audit boundary.** The orchestration substrate must be inspectable in-tree. Reading `~/.pi/agent/extensions/subagent/index.ts` should match `git blame` history.

Vendoring is an explicit operation: bumping the snapshot is a deliberate commit, not a side effect of `npm update -g @earendil-works/pi-coding-agent`.

## Where the snapshot version is recorded

| Location | Format | Authority |
|---|---|---|
| `agent/extensions/subagent/README.md` first line | `> **Vendored from pi X.Y.Z** ...` | **Source of truth** |
| Most recent commit message touching the extension | `chore(subagent): bump vendored snapshot to pi X.Y.Z` | Audit trail |
| ADR-0001 | Rationale, not pinned version | Design |

Always cross-check `README.md` against the most recent bump commit when investigating upstream drift.

## Bump procedure

### 1. Identify the upstream source

The on-disk source for any installed pi version:

```bash
$(node -e 'console.log(require.resolve("@earendil-works/pi-coding-agent/package.json"))' | xargs dirname)/examples/extensions/subagent/
```

Files of interest: `index.ts`, `agents.ts`, `README.md` (upstream README is not our patch table — discard it on copy).

### 2. Read the CHANGELOG between snapshots

```text
$(...)/CHANGELOG.md
```

Scan the section from the version *after* our current snapshot up to the target version. Flag any entry mentioning:

- `subagent` (direct changes to the extension)
- `agent-session` / `extension api` (event-shape changes our parser depends on)
- Event-stream / JSON mode changes (event names, payload shapes)
- `pi.registerTool` / `pi.events` signature changes
- `parseFrontmatter` / agent-discovery helper changes

Anything matching these patterns is a candidate breakage.

### 3. Diff the upstream subagent files vs our vendored copy

Compare upstream `examples/extensions/subagent/{index.ts,agents.ts}` against `agent/extensions/subagent/{index.ts,agents.ts}`. Three categories of difference:

| Category | Action |
|---|---|
| Upstream gained code we don't have | **Pull it in** (it's the bump). |
| Our code that upstream lacks | **Verify each line is one of our documented patches.** If yes, port the patch onto the new upstream. If no, the line is undocumented drift — write it up before re-applying. |
| Upstream changed code we also changed | **Conflict zone.** Re-apply our patches against the new context. Update line numbers in the patch table. |

The active patch zone to focus on:

1. **Per-tool-call UI refresh** — upstream still carries a dead `tool_result_end` branch; our active patch listens for `tool_execution_start` / `tool_execution_end` and calls `emitUpdate()` without appending synthetic messages.

Historical patch zones for parallel-mode full output and failed-task diagnostics were dropped after upstream adopted those behaviors. Still smoke-test them during a bump, but do not treat them as active downstream diffs unless a future audit shows regression.

### 4. Verify event names against current pi

Before committing, re-verify any event names our parser depends on against the new pi's `dist/core/agent-session.js`:

```bash
grep -n "tool_execution_\|message_end\|tool_result" \
  $(npm prefix -g 2>/dev/null)/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
```

Known historical drift: the upstream `tool_result_end` handler at `index.ts:344` was dead against pi 0.74.x because pi now emits `tool_execution_start`/`tool_execution_end` instead. The parser silently underperformed (no per-tool-call UI refresh) rather than crashing — easy to miss without explicit verification. Fixed in pi_config #46. On future bumps, re-verify these event names haven't drifted again.

### 5. Smoke-test against the catalog

After the bump, run a representative slice of the agent catalog:

```bash
# Single-agent run (read-only specialist)
pi -p '/subagent agent: "tauri-expert", task: "Summarize Tauri 2 capability model"'

# Parallel fan-out (the patched mode)
pi -p '/review'   # Triggers code-review + security-review + linter in parallel
```

Verify:

- Per-task output is full (not 100-char truncated) in the parallel result returned to the model.
- Failed-task diagnostics show `stopReason` tagging when a child errors (force this by giving an agent an invalid `--model`).
- Streaming TUI updates appear per turn (`message_end` events).
- Per-tool-call UI refresh fires (the `tool_execution_*` patch listed in `agent/extensions/subagent/README.md` still works — confirm event names haven't drifted again).

### 6. Update the snapshot README and patch table

In `agent/extensions/subagent/README.md`:

- Update the first line: `> **Vendored from pi X.Y.Z** ...`
- Update each patch row's "Lines (post-patch)" column with new line numbers
- If upstream merged a patch, remove its row and note in the commit message which patch became unnecessary
- Add new patches if drift in step 3 required new local changes

### 7. Update ADR-0001 only if substrate semantics changed

ADR-0001 documents *why* we vendor. Bumps don't change the why. Update only if:

- We drop a patch (substrate now upstream-compatible — note in ADR but keep vendoring rationale).
- We add a new patch category (extend the documented surface).
- Upstream introduces a feature that obsoletes our approach (re-evaluate vendoring).

### 8. Commit format (per Conventional Commits)

```text
chore(subagent): bump vendored snapshot to pi X.Y.Z

- Re-applied "tool_execution_* UI refresh" patch (lines NNN-MMM)
- Confirmed patches #1/#2 remain upstream-adopted
- Updated patch table in agent/extensions/subagent/README.md
- No event-name drift detected against agent-session.js
- Smoke-tested /review and single-agent invocation
```

If a patch became unnecessary:

```text
chore(subagent): bump vendored snapshot to pi X.Y.Z, drop merged patch

- Upstream merged "tool_execution_* UI refresh" in pi X.Y.0 (pi-mono #NNN)
- Removed the local patch row from agent/extensions/subagent/README.md
- Updated pi_config issue #46 with merge confirmation
```

## Behaviors that have historically drifted

Maintain this list — add new entries as drift is observed. Each entry should answer: what changed, what break did it cause, how to detect.

| Behavior | Drift history | Detection |
|---|---|---|
| Event name for per-tool-call result | `tool_result_end` (upstream) → `tool_execution_start`/`tool_execution_end` somewhere before pi 0.74.0. Vendored `index.ts:344` carried the dead upstream name until pi_config #46. | Diff stdout of `pi --mode json -p "hello" 2>/dev/null` against the parser's event-name switch |
| 100-char preview truncation in parallel mode | Upstream behavior pre-0.74.0; patch #1 fixed this downstream until upstream adopted the behavior before the 0.75.4 re-audit. | Run `/review` and confirm full text reaches model, not just preview |
| `getFinalOutput` shape | Stable through 0.74.x. Helper used in all three modes' summary paths. | Verify return type matches `messages[].content[].text` extraction |

## When NOT to bump

Skip the snapshot bump when:

- The bump-window contains no `subagent`/`agent-session`/extension-API entries in CHANGELOG.
- We're mid-feature in our own substrate work — finish the feature, land it, *then* bump.
- The new pi version introduces a feature we want to consume via a different mechanism (e.g. a new official subagent API that obsoletes our vendoring approach — that's an ADR-update event, not a bump).

The pi CLI itself can be updated freely (`npm update -g @earendil-works/pi-coding-agent`) independent of the snapshot bump — the orchestrator runs against the installed pi, but our extension runs from the symlinked vendored copy. CLI bump and snapshot bump are decoupled by design.

## Future: upstream contribution path

The active carried patch is tracked in pi_config issue #46. If/when it merges upstream:

1. Bump the snapshot to a version that contains the merge.
2. Drop the merged row from the patch table.
3. Close or update pi_config #46.
4. Consider whether vendoring is still warranted with no remaining patch surface — discuss in an ADR-0001 amendment, not unilaterally.

Vendoring without patches is still defensible (audit-in-tree argument), but the cost-benefit shifts.
