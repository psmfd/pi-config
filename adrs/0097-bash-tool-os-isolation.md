---
status: Accepted
date: 2026-07-12
---

# ADR-0097: OS-level isolation for pi's bash tool — phased $HOME-scoping → filesystem sandbox → egress

**Status:** Accepted
**Date:** 2026-07-12
**Related:** [ADR-0072](0072-guardfall-shell-injection-hardening.md) (bash-destructive-guard threat model this extends below the shell), [ADR-0091] (report-only guard profile), #507 (this arc), #707 (Phase 2), #708 (Phase 3), #709 (outbound-payload secrets scan), #508 (operational-filter vs security-guarantee framing)

## Context and Problem Statement

pi's string-inspection guards (`bash-destructive-guard`, `secrets-guard`) are
provably unsound against file-content indirection: `make test` where the
Makefile recipe runs `rm -rf "$HOME/.aws/credentials"` — the destructive verb
never appears in the string the bash tool receives (`make test`). ADR-0072
already documents this as the GuardFall class and names the fix as living
**below the shell**. pi's own `docs/security.md` states pi has no built-in
sandbox and that the bash tool runs with the process's full permissions.

The sound boundary is OS-level isolation of how pi spawns bash — a
launcher/wrapper concern, explicitly not a pi source fork and not a `tool_call`
extension (a `tool_call` hook only sees the same string the guards do).

## Decision Drivers

- pi exposes the exact hook needed: the documented `shellPath` setting replaces
  the binary the bash tool invokes (`packages/coding-agent/src/utils/shell.ts`
  resolves it and spawns `<shellPath> -c <command>`). No fork required — a
  wrapper script in that slot confines every bash-tool child.
- Isolation must be **incrementally adoptable** and per-platform (macOS dev
  hosts + Debian 13 servers), because the strongest mechanisms differ by OS and
  the cheapest layer is not sound on its own.
- Honesty over theater: each layer must state precisely what it does and does
  NOT defend against. #508 exists because this distinction has been
  under-recorded before.

## Considered Options

1. **Whole-pi containerization** (pi's own `docs/containerization.md` "Plain
   Docker" pattern) — strongest and simplest boundary, confines `read`/`write`/
   `edit`/`grep` too, but provider API keys enter the container and host-picked
   git/gh/ssh config is lost unless deliberately mounted. Recorded as the
   alternative for users who want maximal isolation; not the default because
   #507 asks specifically for wrapping bash spawn on the host.
2. **`tool_call` extension** — rejected: sees only the command string, the
   exact unsound surface this arc escapes.
3. **`shellPath` wrapper, phased (chosen).**

## Decision Outcome

A `shellPath`-wired wrapper, delivered in three phases of increasing soundness
and cost. **This ADR delivers Phase 1 and commits to the Phase 2/3 design;
Phases 2 and 3 are tracked as #707/#708 and land under their own reviewed PRs.**

### Scope boundary (applies to all phases)

A `shellPath` wrapper confines **only the bash tool's child process tree**.
pi's `read`/`write`/`edit`/`grep`/`find`/`ls` built-ins continue to run on the
host with full permissions (pi's `docs/security.md`). This is correct for the
GuardFall threat model — the class is "the shell executes attacker-authored
file content" — but it must be stated plainly: this is "bash-tool executions
are isolated," not "pi is sandboxed." A user wanting the built-ins confined too
uses Option 1 (whole-pi containerization).

### Phase 1 — $HOME-scoping wrapper (this ADR)

`scripts/pi-bash-sandbox.sh`, installed by `setup.sh` as
`~/.local/bin/pi-bash-sandbox` (symlink to the live repo file). Redirects
`HOME` and the XDG dirs to a per-session scratch tree; seeds the scratch
`.gitconfig` with the operator's global `user.name`/`user.email` only (never
`credential.helper`/`url.insteadOf`, which would reintroduce token exfil).

**Opt-in, not default.** Redirecting `$HOME` breaks the agent's `gh`/`git`/
`npm` auth that lives under the real home (keychain, `~/.config/gh`, credential
helpers). Enabling is a deliberate per-host choice:
`"shellPath": "~/.local/bin/pi-bash-sandbox"` in `~/.pi/agent/settings.json`.
Working-repo commits keep their identity from the repo's own `.git/config`
(unaffected by `$HOME`); only `--global`-sourced identity is scoped out and is
what the seed restores.

**What Phase 1 is:** hygiene. It reduces ACCIDENTAL credential exposure from
well-behaved tools defaulting to `$HOME`-relative paths, and keeps ordinary
`git`/`npm` invocations off the operator's real home state.

**What Phase 1 is NOT (load-bearing — do not let it read as the fix):** a sound
defense against the deliberate-adversary Makefile-exfil scenario in #507's own
problem statement. `$HOME` is only an environment variable; redirecting it
changes what path-building *tools* resolve and does nothing to the filesystem.
An attacker hardcoding the real absolute path (`rm -rf "/Users/you/.aws/…"`) is
completely unaffected — the real file still sits at that real path. Soundness
begins at Phase 2. Phase 1 also does not scrub env-carried ambient credentials
(`SSH_AUTH_SOCK`, `GH_TOKEN`) — those still cross, by design, so the agent's
legitimate git/gh work keeps functioning.

### Phase 2 — filesystem sandbox (#707)

The sound boundary: make credential paths unreachable in the child's view, not
merely mis-resolved. Debian 13: `bwrap` (works stock — Debian, unlike Ubuntu
23.10+, does not restrict unprivileged userns by default). macOS: `sandbox-exec`
/ Seatbelt SBPL (deprecated CLI, functionally alive; Codex CLI ships it). Must
scope **reads**, not just writes — reading `~/.aws/credentials` IS the exfil.
Per-platform coverage is asymmetric and the follow-up ADR must state it (macOS
filesystem sandbox may lag). Same `shellPath` hook.

### Phase 3 — egress allowlist (#708)

Bounds the exfil half. Debian: nftables `meta skuid` / `socket cgroupv2`, or
systemd `IPAddressAllow=` (root-free in `--user` scope on cgroup v2). macOS: PF
`user=` anchor under a dedicated account — highest-friction leg; no clean
per-process egress primitive on stock macOS.

## Permanent residuals (not "future work" — no phase closes these)

- **Allowed `github.com` egress is itself a write/exfil channel** — `git push`
  to a reachable branch, `gh gist create`, a PR/issue comment. Domain
  allowlisting has no verb/path granularity; an allowed read host is usually
  also a write host. #709 (pre-flight secrets-pattern scan on outbound payload
  content) closes a slice of this for known-shaped secrets, cheaply and
  independent of Phase 3 — but only that slice.
- **Ambient-credential oracles** — a bound-through `SSH_AUTH_SOCK` is a signing
  oracle (push as you, no file read); a `credential_process` in a bound
  `~/.aws/config` mints fresh credentials on demand. Phase 2 must default-deny
  these; Phase 1 does not touch them.
- **In-scope-by-design exfil** — the tool's legitimate job needs filesystem
  access to the project + a git credential + github.com egress; a `git push`
  carrying smuggled repo data survives all three phases.

These are recorded here so no phase's summary overclaims. The wrapper's own
header carries the same threat-model text so a reader of the code sees it too.

## Consequences

- Phase 1 ships a tested, opt-in capability with zero default behavior change.
- `bash-destructive-guard`'s string-layer guard remains the blast-radius
  isolation for the non-sandboxed default and for destructive-intent
  classification the sandbox does not do (a sandbox scopes *what is reachable*,
  not *whether `rm -rf .` inside the granted view was intended*).
- The `shellPath` slot is single-occupancy: a future default-on Phase 2 must
  compose Phase 1's env-scoping into the same wrapper, not a second one.
