# Versioning and upstream snapshot bumps

Authoritative sources: `agent/extensions/subagent/README.md` (current snapshot version + patch table), `adrs/0001-subagent-orchestration-substrate.md` (rationale for vendoring), and the installed pi `CHANGELOG.md` (release-by-release diffs). This reference is the procedure for safely bumping our vendored snapshot to a newer upstream pi version.

## Why we vendor

Per [ADR-0001](../../../../adrs/0001-subagent-orchestration-substrate.md): the upstream `examples/extensions/subagent/` ships as documentation, not a stability-promised API. Two issues motivated vendoring:

1. **Patch surface.** We carry the documented #3–#14 patch set covering UI events, model policy, canonical availability, environment/guard enforcement, expertise wiring, shadow gating, and rendering. The authoritative inventory and signatures are `agent/extensions/subagent/README.md` plus `PATCH_MANIFEST.json`. Patches #1 (full per-task output) and #2 (failed-task diagnostics) were dropped after upstream adoption.
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

The active patch surface is the complete #3–#14 inventory in the subagent
README and `PATCH_MANIFEST.json`: UI refresh, model pin/fallback/liveness,
expertise/env/guard policy, effective-model rendering, matrix/local/tier policy,
shadow gating, strict child environments, and the canonical snapshot. Audit
every recorded signature; do not reduce the diff mentally to the event patch.

Historical patch zones for parallel-mode full output and failed-task diagnostics were dropped after upstream adopted those behaviors. Still smoke-test them during a bump, but do not treat them as active downstream diffs unless a future audit shows regression.

### 4. Verify event names against current pi

Before committing, re-verify any event names our parser depends on against the new pi's `dist/core/agent-session.js`:

```bash
grep -n "tool_execution_\|message_end\|tool_result" \
  $(npm prefix -g 2>/dev/null)/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
```

Known historical drift: upstream's `tool_result_end` handler is dead against
the current runtime, which emits `tool_execution_start`,
`tool_execution_update`, and `tool_execution_end`. Local patch #3 consumes all
three without polluting message accumulation. On future bumps, re-verify them.

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

In `agent/extensions/subagent/README.md` and `PATCH_MANIFEST.json`:

- Update the upstream pairing/audit note.
- Reconcile every patch row with the new source.
- Remove rows that upstream made unnecessary and record why.
- Add rows for any deliberate new downstream behavior.
- Regenerate and validate manifest signatures with the repository drift script.

### 7. Update ADR-0001 only if substrate semantics changed

ADR-0001 documents *why* we vendor. Bumps don't change the why. Update only if:

- We drop a patch (substrate now upstream-compatible — note in ADR but keep vendoring rationale).
- We add a new patch category (extend the documented surface).
- Upstream introduces a feature that obsoletes our approach (re-evaluate vendoring).

### 8. Commit format (per Conventional Commits)

```text
chore(subagent): bump vendored snapshot to pi X.Y.Z

- Re-applied recorded patches #3-#14 against the new snapshot
- Confirmed patches #1/#2 remain upstream-adopted
- Updated patch table and regenerated PATCH_MANIFEST.json
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
| Event name for per-tool-call result | Upstream example retains `tool_result_end`; current runtime emits `tool_execution_start`/`tool_execution_update`/`tool_execution_end`, consumed by local patch #3. | Diff JSON-mode stdout against the parser's event-name switch and run the spawn integration test. |
| 100-char preview truncation in parallel mode | Upstream behavior pre-0.74.0; patch #1 fixed this downstream until upstream adopted the behavior before the 0.75.4 re-audit. | Run `/review` and confirm full text reaches model, not just preview |
| `getFinalOutput` shape | Stable through 0.74.x. Helper used in all three modes' summary paths. | Verify return type matches `messages[].content[].text` extraction |

## When NOT to bump

Skip the snapshot bump when:

- The bump-window contains no `subagent`/`agent-session`/extension-API entries in CHANGELOG.
- We're mid-feature in our own substrate work — finish the feature, land it, *then* bump.
- The new pi version introduces a feature we want to consume via a different mechanism (e.g. a new official subagent API that obsoletes our vendoring approach — that's an ADR-update event, not a bump).

The pi CLI itself can be updated freely (`npm update -g @earendil-works/pi-coding-agent`) independent of the snapshot bump — the orchestrator runs against the installed pi, but our extension runs from the symlinked vendored copy. CLI bump and snapshot bump are decoupled by design.

## Future: upstream contribution path

When any carried behavior merges upstream:

1. Bump to a snapshot containing the merge.
2. Drop only the redundant patch row and reconcile dependent rows.
3. Regenerate `PATCH_MANIFEST.json` and update the backing issue.
4. Re-evaluate ADR-0001 only if the total remaining patch/audit boundary changes
   enough to alter the vendoring decision.

A merge of #46's event behavior would remove patch #3, not patches #4–#14.
Vendoring without patches would still be defensible for audit-in-tree reasons,
but that is not the current state.
