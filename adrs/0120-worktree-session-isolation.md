---
status: Accepted
date: 2026-07-22
---

# ADR-0120: per-session git worktree isolation with crash-durable WIP snapshots

**Status:** Accepted
**Date:** 2026-07-22
**Related:** #859 (this extension), #96 (multi-orchestrator coordination topology — names worktrees as the substrate), #24 (rejected upstream worktree helper scripts; its flip-trigger T3 — pi-native worktree events — remains unfired at pi v0.81.1), #861 (bash-trigger follow-up), #862 (orphaned-subagent harness gap found during this research), [ADR-0005](0005-tool-call-journal-and-restore.md) (deprecated journal — the only prior durability design; deliberately **not** revived, different problem), [ADR-0008](0008-tier-3-as-sole-intra-session-inter-agent-channel.md) (`.review/` cross-session readability the exemption globs preserve), [ADR-0019](0019-compaction-optimizer-extension.md) (settings namespace + project-layer trust boundary), [ADR-0073](0073-token-meter-extension.md) (per-session state files precedent), ADR-0097/ADR-0118 (subagent spawn seams the cwd-defaulting rides on).

## Context and Problem Statement

Multiple pi orchestrator sessions routinely run against the same repository concurrently (CLAUDE.md documents the collision-avoidance folklore: check open PRs before claiming ADR numbers or editing shared manifests). Session *history* is already isolated — one JSONL per session — but every session's `write`/`edit`/`bash` lands in the **same working tree**: file stomping, `index.lock` contention, branch state races. Separately, uncommitted work dies with the session: pi fires no event on ungraceful death (`session_shutdown` is explicitly skipped on uncaughtException and terminal-EIO paths; SIGKILL/OOM run nothing), so a crash loses everything since the last real commit.

Two hard constraints shape any solution:

1. **pi cannot change a session's cwd.** `ExtensionContext.cwd` is read-only, `switchSession()`/`newSession()`/`fork()` expose no cwd parameter (the internal runtime's `cwdOverride` is not public), and the CLI has no `--cwd` flag. Isolation cannot mean "move the session" — it must mean "steer the session's mutations."
2. **No crash hook exists.** Durability must be proactive on-disk state, reconciled at the *next* `session_start`.

## Considered Options

### Isolation mechanism

1. **Worktree + tool-call steering (chosen).** Lazy per-session `git worktree` at `<repo>/.worktrees/<sid>/`; `write`/`edit` outside it denied with a redirect reason (guard house style); read-like paths rewritten into it; `bash` wrapped `cd <wt> && ( … )` via the documented in-place `tool_call.input` mutation; `subagent` calls get `cwd` defaulted (subagents already accept per-call cwd — they are separate processes).
2. **Advisory only (context injection, no enforcement).** Rejected: relies on model compliance; a single forgotten absolute path recreates the collision. Kept as a component (activation notice), not the mechanism.
3. **Wrapper script (`piw`: create worktree, cd, exec pi).** Deterministic but outside the extension system: no durability engine, no reconciler, no per-tool steering, and every operator must remember to use it. Rejected as primary; still compatible (a session launched inside a worktree disarms).
4. **Upstream feature request (native worktree/cwd support).** The right long-term seam (issue #24's flip-trigger), but unfired for 14 months; not a substitute for working isolation now.

### Worktree location

1. **`<repo>/.worktrees/<sid>/` in-repo, gitignored (chosen).** Decisive argument: bash-destructive-guard's safe paths are `/tmp` + *cwd and beneath* — an in-repo worktree is automatically destructive-safe, where a cache-dir worktree would make the sibling guard deny `rm`/`mv` inside the session's own workspace. Also shorter paths and discoverability. The extension appends `/.worktrees/` to `<common-dir>/info/exclude` (local-only) so repos we do not own need no committed change; pi_config commits the `.gitignore` entry for visibility.
2. `~/.cache/pi-worktrees/<repo>/<sid>/` — cleanest tree separation, but fights bash-destructive-guard (option 3 below was rejected as the cure) and adds a per-operator safe-paths configuration step. Rejected.
3. Have this extension widen bash-destructive-guard's safe list dynamically — rejected outright: cross-extension coupling outside `shared/` (ADR-0065/0088).

### Durability mechanism

1. **Temp-index `commit-tree` snapshots to `refs/pi-wip/<sid>` (chosen).** `read-tree HEAD → add -A → write-tree → commit-tree` under `GIT_INDEX_FILE`: captures tracked edits **and untracked files** (every newly written source file), never touches the real index, runs no hooks, lives in the shared object store (survives worktree deletion and any death mode), one ref per session (no shared-pointer races), tree-identity check prevents ref churn.
2. `git stash create` + `update-ref` — the near-miss: hook-free and race-free, but `stash create` **cannot capture untracked files**, which is most of what a coding session produces. Rejected on that hole.
3. WIP commits on the visible branch — runs the pre-commit secrets-guard on every snapshot (latency + mid-turn false-block risk) and pollutes pre-squash history. Rejected.
4. Plain `git stash` — `refs/stash` is a single shared pointer; concurrent sessions race on it. Rejected.
5. Reflog only — records ref updates, not uncommitted state; no protection at all for never-committed edits. Rejected.

### Trigger

1. **Lazy: first `write`/`edit` targeting the repo (chosen).** Deterministic (pure function of tool traffic), zero cost for read-only sessions. Bash-only mutation workflows do not trigger — accepted v1 gap tracked as #861 (a conservative mutating-bash classifier over `shared/shell-lex.ts` is the follow-up).
2. Eager at `session_start` for any git repo — simpler but pays worktree cost for every Q&A/review session. Rejected as default (one-line settings change away).
3. auto-router's task classifier — per-turn, LLM-cost-bearing, explicitly measurement-only, and not exposed on the EventBus. Rejected: the trigger must be deterministic and free.

## Decision Outcome

The `worktree` extension (first-party, not mirrored in v1 — #860) implements isolation-by-steering with options 1/1/1/1 above. Key mechanics:

- **Ownership & liveness:** `git worktree lock --reason "session:<sid> pid:<pid> host:<h> started:<iso>"` held for the session's life; git's same-branch-twice refusal is a free secondary mutex. The lock reason is the liveness record: the `session_start` reconciler cross-references lock reasons × per-session manifests (`~/.pi/agent/extensions/worktree/sessions/<sid>.json`, atomic per-session files — a shared blob would be a read-modify-write race between the very sessions being isolated) × `refs/pi-wip/*`, `kill -0`-probes recorded pids, and **surfaces** dead-pid orphans. Adoption is manual (`/worktree resume <sid>`); a session auto-re-attaches only its *own* sid.
- **Reaping** is gated on clean tree + `gh pr view` reporting `MERGED` — never `git branch --merged`, which squash merges defeat permanently.
- **Enforcement details:** exemption globs (default `NEXT_SESSION*.md`, `.review/**`) keep scratch and ADR-0008 handoff artifacts writable in primary; writes into *another* session's worktree are a hard refusal; read-path rewriting prefers the worktree copy so the session never reads stale primary content it shadowed. The bash cd-wrap is this repo's first use of the documented `tool_call.input` mutation capability (the guard trio is deny-only); `reportOnly` provides an observe-only rollout mode.
- **Trust boundary:** project-layer settings (`postCreate`, `linkFiles`, `baseRef`, `writeExemptions`) apply only when `ctx.isProjectTrusted()`; `linkFiles` filters absolute/`..` paths; `enabled`/`reportOnly` are user-layer only.
- **Failure posture: fail-open with visible warning.** This is collision isolation for cooperating sessions, not a security boundary; a broken git environment must not brick the session, and the guard trio still gates every call.

For pi_config itself this changes one workflow property: `~/.pi` symlinks to the primary checkout, so config edits become live at merge (primary checkout pull) rather than on save — accepted as a correctness improvement (a mid-flight session's half-finished edit no longer perturbs concurrent sessions).

## Consequences

- **Positive:** concurrent sessions get collision-free workspaces with a crash-loss bound of one turn / one timer interval; recovery after any death mode is enumerable (`/worktree status`) and one command (`/worktree resume`); the informal "check open PRs first" folklore gets a mechanical layer for working-tree state.
- **Neutral:** merge-time collisions (shared manifests, ADR numbers, same-remote-branch pushes) are explicitly out of scope — worktrees serialize nothing at the PR level. The first primary write costs one denied round-trip while the worktree is created.
- **Accepted:** WIP snapshot commits are plumbing and bypass the pre-commit secrets-guard (local-only, never-pushed refs; real commits still run hooks); absolute paths inside bash strings escape the cd-wrap; bash-only sessions do not trigger (#861); `refs/pi-wip/*` cleanliness depends on reaping discipline (`/worktree reap`).
