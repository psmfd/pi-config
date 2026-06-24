# ADR-0005: Tool-call journal and `restore` tool — file rollback for write/edit/destructive-bash operations

**Status:** Proposed
**Date:** 2026-05-19
**Companion to:** [ADR-0001](0001-subagent-orchestration-substrate.md), [ADR-0002](0002-agent-to-agent-channel.md)
**Tracking issue:** [#69](https://github.com/TheSemicolon/pi_config/issues/69) (Phase C deferred-capability)

> **Note on numbering.** The #69 issue body and prior comments reserved `adrs/0003-tool-call-journal-and-restore.md`. Slot 0003 was subsequently taken by [`0003-expand-disable-model-invocation-to-all-wrapper-paired-skills.md`](0003-expand-disable-model-invocation-to-all-wrapper-paired-skills.md). Per ADR immutability, this rollback-capability ADR is renumbered to **0005** (0004 is `consensus-by-replication`).

## Context and Problem Statement

The original #69 brief framed "damage control" as undo/rollback. Triage established that the upstream `damage-control.ts` is a **pre-flight blocker**, not a rollback mechanism — it refuses tool calls before they happen, and once an operation lands there is no upstream pattern to revert it. Our existing pair (`agent/extensions/secrets-guard/` + `agent/extensions/bash-destructive-guard/`) shares that pre-flight shape and likewise offers no recovery path.

Today, when an agent makes a damaging change that passes the guards — wrong file edited, correct file edited wrong, intended-but-undesired delete — the recovery path is whatever the host environment provides: `git restore`, editor undo, backup. This is workable for repos under VCS but offers no machine-readable record of *what the agent did*, in what order, and with what payloads. The recovery story degrades sharply for:

- Files outside VCS (config under `~/`, generated artifacts, fixtures).
- Multi-file changes where partial rollback is wanted.
- Destructive `bash` operations whose effect was a deletion the VCS never observed (untracked file `rm`).
- Post-hoc investigation of what an agent attempted vs what it actually executed.

Pi's extension API exposes the events needed to build a proper journal:

- `pi.on("tool_call", ...)` — fires before tool execution; observable for `write`, `edit`, and `bash`. The handler can synchronously read the file about to be mutated and capture a pre-image snapshot.
- `pi.on("tool_result", ...)` — fires after tool execution; observable for the same surface. The handler can record the post-image and commit the journal entry (or roll back the snapshot if the tool reported failure).
- `pi.registerTool("restore", ...)` — registers a new user-facing tool. The handler can replay journal entries in reverse, gated by `ctx.ui.confirm` for destructive replay.

The capability is implementable on top of these primitives. The question is whether — and on what design contract — to build it.

## Considered Options

- **Option A** — **Per-session journal + `restore` tool, opt-in via setting.** New extension `agent/extensions/tool-journal/` (~400–600 LOC). Per-session journal under `${XDG_STATE_HOME}/pi/tool-journal/<session>/`. Pre-image snapshot on every `write`/`edit`/destructive-`bash` `tool_call`; post-image commit on `tool_result`. `restore` tool with three modes: `restore last`, `restore <entry-id>`, `restore --since <checkpoint>`. Default-off via setting `tool_journal.enabled` to avoid I/O overhead in normal sessions; pi `--journal` flag flips it for sessions where the operator wants the safety net.
- **Option B** — **Always-on journal, no `restore` tool.** Record-only. Recovery is operator-driven: read the journal, manually replay or revert. Lower implementation surface (~150 LOC); zero new tool surface; serves the "what did the agent actually do?" investigation case but not the recovery-during-session case.
- **Option C** — **`restore` tool only, journal piggybacks on VCS.** Skip the explicit journal. The `restore` tool wraps `git restore` / `git checkout` with an agent-friendly interface. Covers the common case for free; ignores the untracked-file, outside-VCS, and bash-destructive cases that motivated the work.
- **Option D** — **Decline.** Continue to rely on VCS, editor undo, and operator vigilance. Accept the gaps for outside-VCS files and untracked deletions.

## Decision Outcome

**Deferred pending design work.** This ADR is published as **Proposed** to record the intent and the design constraints — not to choose between A/B/C/D. Promotion to Accepted requires the open questions below to be resolved with explicit answers, a threat model dispatched against the chosen option, and a `security-review-expert` pass.

The most likely chosen option is **A** (the full journal + tool), based on the gap analysis above. Options B and C cover proper subsets of the use case; Option D is the status quo we are trying to improve. But the implementation surface is large enough that the open questions need closure before committing.

### Open questions for promotion

1. **Per-session vs per-task journal scoping.** A parallel-batch fan-out spawns N subagents that may each touch overlapping files. A flat per-session journal makes "rewind the failed task only" hard. Per-task scoping resolves this but requires the journal to know about task IDs, which crosses the subagent-extension boundary. Resolution depends on whether the journal is parent-only (sees no child mutations) or per-process (each subagent gets its own journal, the parent aggregates).
2. **Retention.** Default proposed: 7 days, configurable via setting (mirrors ADR-0002 § Open Questions §2 for consistency). Open whether the journal is auto-pruned on session-end success (no errors, no warnings in summary) to reduce disk pressure for happy-path sessions.
3. **Interaction with VCS.** When the file under journal is also tracked by `git`, the journal's pre-image and `git`'s pristine copy are partially redundant. Open whether the journal stores diffs against the VCS pristine (smaller, requires VCS available at restore time) or full pre-images (larger, fully self-contained). Likely full pre-images for the simplicity and cross-VCS portability; revisit if disk pressure is observed.
4. **Ordering semantics for parallel rollback.** If child A wrote file `X` at t=5 and child B wrote file `Y` at t=6, and the operator wants to rewind child B only, restoring `Y`'s pre-image is correct iff no later operation also touched `Y`. The journal needs a per-file linearization and the `restore` tool needs to refuse cross-cutting rewinds with a clear error.
5. **`restore` tool authorization.** The tool itself mutates files. It MUST require `ctx.ui.confirm` for any rollback (interactive sessions) and MUST refuse to execute in non-interactive sessions (`pi -p`). Default proposed for v1: **read-only against the journal in non-interactive mode** — can list entries, cannot replay. No `--allow-noninteractive-restore` flag in v1; introducing one would reintroduce the journal-poisoning surface the Tradeoffs section identifies as the highest-risk path. Any deviation from this default at promotion requires explicit justification and a `security-review-expert` sign-off against the relaxed policy.
6. **Subprocess boundary.** Per ADR-0002 § Context, `pi.sendMessage(deliverAs:"followUp")` is in-process only in pi 0.74.x; the same in-process limitation applies to `pi.on` / `pi.registerTool`. A journal extension loaded only in the parent will not observe child tool events. Resolution options: (a) load the extension in every spawned `pi -p` subprocess via the existing extension-loading path, with per-subprocess journals the parent aggregates after task completion; (b) defer cross-process journaling to a v2.
7. **Filesystem layout overlap with ADR-0002.** ADR-0002 reserves `${XDG_RUNTIME_DIR}/pi-coms-<uid>/<session>/` (Linux) / `~/Library/Application Support/pi/coms/<session>/` (macOS) for the coms bus, and `${XDG_STATE_HOME}/pi/coms-audit/<session>.jsonl` for the audit log. This ADR proposes `${XDG_STATE_HOME}/pi/tool-journal/<session>/` on Linux and the equivalent `~/Library/Application Support/pi/tool-journal/<session>/` on macOS. Windows is unsupported in v1, matching ADR-0002. The two should align on naming conventions (kebab-case directory names; session scoping; 0600 mode; per-platform paths) but otherwise remain independent.

### Out of scope for v1

- Cross-session rollback (e.g. "undo what session X did three days ago"). The journal is per-session; cross-session restore would require a separate aggregation layer.
- Network-mounted journal storage (off-host attestation). Local-only storage; same forensic-grade vs attestation-grade caveat as the coms audit log.
- Rollback of operations performed *outside* pi (manual `rm`, external editor saves). The journal observes only `tool_call` events; out-of-band changes are invisible.
- Bidirectional journaling — recording reads as well as writes. Reads are higher-volume and lower-value for rollback; deferred unless a concrete use case emerges.

### Tradeoffs (Option A, the most likely choice)

- Good: Closes the recovery gap for outside-VCS files, untracked deletions, and partial multi-file rewinds.
- Good: Machine-readable record of every mutation enables post-session investigation independent of VCS.
- Good: Builds on existing pi primitives; no upstream changes required.
- Good: Aligns with ADR-0002 audit-log conventions (filesystem-only, hash-chained, mode 0600).
- Bad: I/O on every mutation; default-off mitigates but motivated operators paying the cost want it always-on for important sessions.
- Bad: Disk usage scales with mutation volume. Retention setting is mandatory; needs operator visibility.
- Bad: Per-task scoping requires crossing the subagent-extension boundary (subagent extension needs to advertise task IDs to the journal extension). This is the largest implementation risk.
- Bad: `restore` tool itself is a new attack surface — a compromised model that holds the tool can roll forward into a journal-poisoning attack. Mitigated by interactive-confirm gating and refusal-by-default in non-interactive mode.

## More Information

### Implementation sequencing (post-promotion)

- **Phase 1 — ADR finalization.** Resolve the seven open questions above; update this ADR with explicit answers; promote to Accepted via PR.
- **Phase 2 — Extension skeleton.** New `agent/extensions/tool-journal/index.ts` implementing the chosen scoping (per-session or per-task). Pre-image capture + post-image commit. No `restore` tool yet — record-only deployment first to validate journal correctness against real workloads.
- **Phase 3 — `restore` tool.** Add the user-facing tool with `ctx.ui.confirm` gating. Initial mode set: `restore last`. Add `restore <entry-id>` and `restore --since <checkpoint>` in follow-ups once `restore last` has settled.
- **Phase 4 — Documentation.** New `agent/rules/tool-journal.md` if any contributor-facing convention emerges (e.g. "tag manual checkpoints with `# CHECKPOINT: <name>`"). Update `agent/extensions/README.md` index.
- **Phase 5 — Pre-merge review gate.** `security-review-expert` against the implementation diff; `checkmarx-expert` against the filesystem-handling and JSON-parsing surface. Both must be PASS or PASS_WITH_WARNINGS for merge.

### Cross-references

- Tracking issue: [pi_config #69](https://github.com/TheSemicolon/pi_config/issues/69) — extension triage; this ADR closes the "real rollback" net-new-capability gap surfaced in the triage report.
- Sibling ADR: [`adrs/0002-agent-to-agent-channel.md`](0002-agent-to-agent-channel.md) — coms bus. Independent of this ADR but shares filesystem-layout and audit-log conventions; the two should align on naming if both land.
- Adjacent issue: [#23](https://github.com/TheSemicolon/pi_config/issues/23) — Stop-hook spike. The `tool_result` middleware surface relevant here also affects the Stop-hook design.
- Companion notes entry: [`notes/upstream-deferred.md`](../notes/upstream-deferred.md) § "File journal + `restore` tool".
