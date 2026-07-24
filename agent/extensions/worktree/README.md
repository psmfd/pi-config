# worktree

Per-session git worktree isolation with crash-durable WIP snapshots (ADR-0120,
#859). Multiple concurrent pi
orchestrator sessions can work the same repository without write collisions,
and sudden session death (crash, SIGKILL, power loss) loses at most one turn /
one snapshot-timer interval of work.

Multi-orchestrator context: #96
names git worktrees as the coordination substrate; the rejected upstream
helper scripts are #24 (its
flip-trigger — pi-native worktree events — is still unfired as of pi v0.81.1,
so this extension builds isolation entirely on `session_start` /
`tool_call` / `turn_end` / filesystem conventions).

## Why the session stays in the primary checkout

pi cannot change a session's cwd: `ctx.cwd` is read-only, `switchSession()` /
`fork()` expose no cwd override, and the CLI has no `--cwd` flag. So the
session nominally sits in the primary checkout and its **mutations are
steered** into a per-session worktree instead.

## Mechanism

| Phase | What happens |
|---|---|
| Arm (`session_start`) | cwd inside a git repo, primary checkout (not a linked worktree), `enabled` — else inert. Re-attaches this sid's own worktree across resume/restart; reconciles orphans (below). |
| Trigger (first `write`/`edit` targeting the repo) | Creates `<repo>/.worktrees/<sid>/` via `git worktree add -b feat/wt-<sid> … <base>` (base: `baseRef` setting → `origin/dev` → `origin/main` → `origin/HEAD` → `HEAD`), locks it with a `session:<sid> pid:<pid> host:<h> started:<iso>` reason (the liveness record), appends `/.worktrees/` to `<common-dir>/info/exclude`, hydrates (`linkFiles` symlinks + `postCreate`, both trust-gated), writes the manifest. Bash-only mutation workflows do not trigger (v1 accepted gap, #861). |
| Enforce (`tool_call`) | `write`/`edit` → primary paths **denied** with a redirect reason naming the worktree target; exemption globs (default `NEXT_SESSION*.md`, `.review/**`) keep scratch/handoff files writable in primary. `read`/`grep`/`find`/`ls` → primary paths **rewritten** into the worktree (prefer the worktree copy; keep primary only for files that exist there and not in the worktree). `bash` → command wrapped `cd <wt> && ( … )` (in-place `tool_call.input` mutation — documented API; first mutation use in this repo, ADR-0120). `subagent` → `cwd` defaulted to the worktree (single/steps/tasks); children then disarm because a linked worktree never re-isolates. |
| Snapshot (`turn_end` + timer) | Dirty tree → temp-index commit pinned to `refs/pi-wip/<sid>` (`read-tree HEAD` → `add -A` → `write-tree` → `commit-tree` under `GIT_INDEX_FILE`). Captures tracked edits AND untracked files; never touches the real index; runs no hooks; skips ref churn on identical trees. Default timer fallback 5 min (`snapshotIntervalMs`). Also on clean `session_shutdown`. |
| Recover (`session_start` reconciler) | Cross-references worktree lock reasons × manifests × `refs/pi-wip/*`; a dead-pid record is surfaced as an orphan (`ctx.ui.notify`) — **never auto-adopted**. `/worktree resume <sid>` re-attaches (re-creating the directory from the branch and restoring the WIP snapshot when it was reaped). |
| Reap (`/worktree done` / `reap`) | Only when the tree is clean **and** `gh pr view <branch>` reports `MERGED` (squash merges defeat `git branch --merged` ancestor checks — never used). Sequence: unlock → `worktree remove` → `branch -D` → delete `refs/pi-wip/<sid>` → delete manifest. |

## Commands

`/worktree [status|resume <sid>|branch <type>/<kebab-name>|done|reap]`

## Settings

`extensionSettings.worktree.*` (user layer `~/.pi/agent/settings.json`):
`enabled` (default true — deterministic-when-installed), `reportOnly`
(observe-only: no creation, no deny, no mutation), `baseRef`,
`snapshotIntervalMs` (floor 15 s), `writeExemptions`.

Project layer (`<cwd>/.pi/settings.json`, applied **only when the project is
trusted** — ADR-0019 threat model): `baseRef`, `writeExemptions`, `postCreate`
(command run in the fresh worktree, e.g. dependency hydration), `linkFiles`
(repo-relative files symlinked primary → worktree for operator-identity state;
absolute paths and `..` traversal are filtered). `enabled`/`reportOnly` are
deliberately user-layer only — a hostile repo must not switch isolation off.

Env override: `PI_SKIP_WORKTREE=1` (extension loads but registers nothing).

## Durability model

`refs/pi-wip/<sid>` lives in the shared object store — it survives worktree
deletion and every process death mode, because pi fires **no event on
ungraceful death** (`session_shutdown` is skipped on uncaughtException and
terminal-EIO exits). Loss bound: one turn or one timer interval. The ref
namespace is local-only by convention; nothing in this extension configures a
push refspec for it. Snapshot commits are plumbing: the pre-commit
secrets-guard does not run on them (accepted for never-pushed WIP refs; real
commits on the topic branch still run hooks normally).

## State

- Per-session manifest: `~/.pi/agent/extensions/worktree/sessions/<sid>.json`
  (atomic writes; an index only — git is the source of truth).
- Git: the worktree itself, its lock reason, and `refs/pi-wip/<sid>`.

## Refusal policy (per-rule)

| Rule | Policy | Rationale |
|---|---|---|
| `write`/`edit` targeting the primary checkout | Continue-eligible | The `reason:` names the exact worktree path to re-issue against — one retry with the mapped absolute path always succeeds. |
| `write`/`edit` targeting another session's `.worktrees/<other-sid>/` | **Hard refusal** | That tree belongs to a live or recoverable session; writing into it recreates the collision this extension exists to prevent. Escalate to the user if cross-session file exchange is genuinely needed (use `.review/` handoff instead). |

All other steering (bash wrap, read rewrite, subagent cwd) mutates inputs
without blocking, and is therefore not a refusal surface. **Reads of another
session's worktree are deliberately permitted** — sessions cooperate under
the same operator, and read visibility is part of the "isolation, not a
security boundary" posture; only writes into a foreign worktree are refused.

## Failure posture

FAIL-OPEN with a visible warning: worktree creation failure disables the
extension for the session and work continues unisolated in the primary
checkout. This is collision isolation for cooperating sessions, not a
security boundary — the guard trio still gates every call. Accepted gaps:
absolute paths inside bash command strings escape the cd-wrap (same class as
bash-destructive-guard's residual gaps); bash-only mutation workflows do not
trigger creation (#861).

## Tests

`scripts/test-worktree.sh` — seven `node:test` suites (glob, enforcement
classification, settings/trust gating, manifest atomicity, reconciler logic,
git lifecycle + snapshot/restore round-trips against real temp repositories,
and stub-harness end-to-end flows for the index wiring).
