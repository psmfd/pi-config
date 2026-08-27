# bash-confinement

The **policy** half of Phase 2a bash-tool write confinement
([ADR-0146](../../../adrs/0146-bash-tool-write-confinement.md), #1046). The
mechanism is the vendored `landlock-run` launcher behind the composed
`pi-bash-sandbox` shellPath wrapper; this extension decides *whether* to arm
it on the current host and exports the env contract the wrapper reads.

Linux-only in effect — Landlock is a Linux LSM. On macOS/Windows the
extension emits a one-time inert notice and exports nothing (confinement on
those hosts is the Seatbelt leg, #707).

## What it does

The environment contract is session-scoped. Every `session_start` first revokes
`PI_BASH_CONFINE` and `PI_CONFINE_GRANTS_RW` before resolving policy, and
`session_shutdown` revokes them again. Replacement flows (`/new`, `/resume`,
`/fork`, and `/reload`) therefore cannot inherit stale mode or grant values.

At `session_start`:

1. Reads the rollout mode from the USER settings layer (below).
2. On Linux, runs `landlock-run --probe` (tri-state: `full` / `partial` /
   `unusable` — the probe is the authority, never the kernel version).
3. Exports the session policy into `process.env` (inherited by the shellPath
   wrapper pi spawns for each bash-tool call):
   - `PI_BASH_CONFINE=enforce` when `auto` or `enforce` receives a `full` probe.
   - `PI_BASH_CONFINE=refuse` when strict `enforce` receives a `partial` or
     `unusable` probe; the wrapper exits 125 before running bash.
   - `PI_CONFINE_GRANTS_RW` only while enforcement is armed — colon-separated
     extra rw grants: the executed-cache dirs ordinary dev work writes
     (`~/.cache/pi_config`, `~/.npm`) plus any per-host lines from
     `~/.config/pi/bash-confinement-grants.conf`.
   The **worktree** extension separately exports `PI_SESSION_WORKTREE` and
   `PI_CONFINE_SESSION` when it activates a session worktree — the primary
   write grant. This extension never owns the worktree path.
4. Emits a transcript-visible notice: armed (info), advisory (warning), or
   strict refusal (warning).

It **only takes effect** when the operator has wired
`"shellPath": "~/.local/bin/pi-bash-sandbox"` in `~/.pi/agent/settings.json`
— the extension cannot read `shellPath` from inside pi, so the armed notice
states this requirement rather than asserting confinement is live.

## Enabling / disabling

`extensionSettings.bashConfinement.mode` in `~/.pi/agent/settings.json`
(USER layer only — a project layer cannot weaken confinement, the same trust
boundary the guard trio and token-meter use):

| mode | behavior |
| --- | --- |
| `auto` (default) | enforce when the probe reports `full`; loud advisory (warn, no enforcement) otherwise |
| `enforce` | strict: enforce on `full`; publish the wrapper's exit-125 refusal state on `partial`/`unusable` |
| `advisory` | never enforce; emit the standing advisory warning each session |
| `off` | fully inert (also `{"enabled": false}`) |

Even at `auto`/`enforce`, neither enforcement nor strict refusal reaches bash
until `shellPath` points at the wrapper. The armed and refusal notices state
that operator wiring requirement rather than asserting the wrapper is active.

## Refusal policy (per-rule)

This extension registers no tools and blocks no tool calls — it is a
policy/observability extension, not a pre-flight guard. The actual refusal
happens in the wrapper (`scripts/pi-bash-sandbox.sh`), not here:

- **Enforce + no worktree yet** → the wrapper refuses (exit 125 + a
  `landlock-run:` stderr marker). Correct: bash before any worktree exists
  has no write grant.
- **Enforce + launcher missing** → wrapper refuses (exit 125 + marker).
- **Enforce + probe not `full`** → the extension publishes `refuse`; the
  wrapper exits 125 with a marker before running bash.
- **A denied write** → `landlock-run` returns `EACCES`, surfaced as an
  ordinary "Permission denied" line in the bash-tool output.

Override (operator only, [ADR-0146](../../../adrs/0146-bash-tool-write-confinement.md) D6):
`SKIP_BASH_CONFINEMENT=1` in the wrapper's own process environment — never
readable from the wrapped command string or any repo/worktree file a session
can write. Per-host extra grants: `~/.config/pi/bash-confinement-grants.conf`
(real home, outside every grant).

## Context Experience (#1031)

- **What the model sees**: nothing in its context. This extension writes no
  injected block and mutates no tool call. Its only model-visible effect is
  indirect — a denied bash write appears as a normal `EACCES` line in that
  tool's own output, exactly as any permission error would.
- **When it fires**: `session_start` (revoke, probe, env export, and at most one
  `ctx.ui.notify`) plus `session_shutdown` (revoke only). The notify is
  operator-facing UI, not model context.
- **Token effect**: zero standing tokens. No system-prompt or context
  contribution.
- **Cache effect**: none — no context mutation, so the provider's cached
  prefix is untouched.

## Files

- `index.ts` — the policy extension (this dir).
- `scripts/pi-bash-sandbox.sh` — the composed wrapper it drives (repo root).
- `agent/vendor/landlock-run/` — the vendored launcher pin.
- `scripts/test-landlock-canary.sh` — the Linux enforcement canaries.

## Tests

- `scripts/test-bash-confinement.sh` — unit tests for mode resolution, probe
  handling, session lifecycle revocation, env export, and the non-Linux inert
  path (mocked launcher + settings; no kernel dependency).
- `scripts/test-landlock-canary.sh` — real enforcement on a Landlock kernel
  (the mechanism side; Linux-only self-skip).
