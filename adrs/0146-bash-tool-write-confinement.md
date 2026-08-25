---
status: Accepted
date: 2026-08-20
---

# ADR-0146: bash-tool write confinement (Phase 2a) — vendored landlock-run behind a composed shellPath wrapper

**Status:** Accepted 2026-08-20 — the ADR #1033 required; implementation tracked as #1046.
**Related:** [ADR-0097](0097-bash-tool-os-isolation.md) (the accepted phased ladder — this is its Phase 2 *write half*, deliberately named 2a; read-scoping is 2b and stays in #707), [ADR-0130](0130-package-agent-child-filesystem-confinement.md) (the bwrap/Seatbelt builders for package-agent children — deliberately **not** reused here, see Decision Outcome), [ADR-0136](0136-patch-train-and-fork-policy.md) item (f) (the one-primitive-two-consumers question this ADR answers; 0136 is superseded by [ADR-0138](0138-patch-train-and-fork-policy-corrected.md) but item (f) survives per its line carrying candidates (a)-(f) forward), [ADR-0072](0072-guardfall-shell-injection-hardening.md) (the GuardFall threat model), [ADR-0022](0022-gh-identity-guard-extension.md) §Q5 / [ADR-0024](0024-gh-identity-guard-inline-skip.md) (override trust-boundary precedent — never sourced from untrusted project/repo files, operator-only bypass framing; D6 takes the stricter env-only posture, see erratum), [ADR-0120](0120-worktree-session-isolation.md) (worktree isolation this composes with), #507 (the arc), #508 (honesty-over-theater discipline this ADR follows). Upstream: `@deepseek-ai/node-addon-landlock-run` from `deepseek-ai/deepseek-harness` (`native/landlock-run/`), assessed 2026-08-20; adoption queued in psmfd/FingerTrap ADR-0027 P8.

## Context and Problem Statement

The string-inspection guards are provably unsound against file-content
indirection (the GuardFall class, ADR-0072): `make test` whose recipe runs
`rm -rf "$HOME/.ssh"` never shows a destructive verb in the string any
`tool_call` hook sees. ADR-0097 named the sound fix — OS-level isolation
below the shell — and delivered Phase 1 ($HOME-scoping hygiene, explicitly
not sound). Its Phase 2 ("real filesystem sandbox", #707) remained a
design sketch: bwrap on Debian, Seatbelt on macOS, with an explicit bar
that reads must be scoped too because "reading `~/.aws/credentials` IS the
exfil."

Two things changed since. The dsh assessment (FT ADR-0027 P8) surfaced a
purpose-built, audit-friendly Linux primitive — `landlock-run`, a
self-restrict-then-exec Landlock launcher (~300 lines of static C11,
prebuilt linux-x64/arm64, pinned CLI contract, tri-state `probe()`,
fail-closed exit 125, deny-by-default, ruleset inherited across `execve`).
And ADR-0130 shipped reviewed bwrap/Seatbelt builders for package-agent
children, earmarking them for possible Phase-2 reuse ("one primitive, two
consumers" — ADR-0136 item (f) asked the two ADRs to confirm rather than
build twice).

Issue #1033 (this ADR's task) proposed the landlock-run adoption. Two of
its factual premises did not survive research and are corrected here:
the component's license is **BSD-3-Clause**, not MIT (the parent monorepo
is MIT; `native/landlock-run/` ships its own license), and pi's bash
`tool_call.input` is a **single `command` string**, not argv — no
argv-mutation capability exists or is recorded anywhere; every in-repo
mutation precedent (worktree cd-wrap, plain-english) rewrites a string
field.

## Decision Drivers

- **Honesty over theater (#508):** Landlock is grant-only — there is no
  "read everything except X". A broad `--ro /` grant means write
  confinement only; nothing may imply the read-scoping bar is met.
- **Session bash must keep doing its job:** inherit the operator's
  environment, namespaces, agent sockets, and toolchains; git/gh must keep
  working from worktrees. Any mechanism that isolates namespaces breaks
  the tool it confines.
- **Non-self-certification (ADR-0022 §Q5 trust boundary, ADR-0024
  operator-only framing):** no override the agent can embed in a command
  string or write from inside a session may disarm the boundary.
- **Verify, don't assume (testing doctrine, ADR-0130 canary precedent):**
  the probe — not the kernel version — is the authority; grants are
  canary-tested, not derived from documentation alone.
- Young dependency (public history ~10 days at assessment; liveliness
  **Active**, risk **Medium**): exact pin, vendored, re-audit cadence.

## Considered Options

1. **Landlock via vendored `landlock-run` behind a composed `shellPath`
   wrapper (chosen).**
2. **Reuse the ADR-0130 bwrap builders for session bash** — rejected:
   `--unshare-all` namespaces, env allowlists, and `/proc` hiding are
   exactly what package-agent children need and exactly what session bash
   cannot survive (worktree paths, ControlMaster sockets, gh auth, and
   ambient toolchains all live in the inherited view). ADR-0130 itself
   rejected Landlock *for that consumer*; the rejection does not transfer
   to this one, and neither does the mechanism.
3. **`tool_call` string mutation instead of `shellPath`** — rejected:
   the launcher argv would have to be encoded as one shell-quoted string
   wrapping an arbitrary multi-line script body (re-quoting fragility the
   worktree cd-wrap never has), and hook-ordering with the worktree
   mutation becomes an implicit contract. The `shellPath` wrapper receives
   `-c <command>` as argv and passes `"$@"` through verbatim — zero
   re-quoting. (ADR-0097's original rejection of `tool_call` extensions
   was about *inspection*; mutation is possible but is the worse
   mechanism here.)
4. **True advisory mode first ("log what would have been denied")** —
   rejected as unbuildable: Landlock has no permissive/dry-run mode (its
   audit support is deny-and-log, never allow-and-log). The practical
   advisory channel already exists for free: denials return synchronous
   `EACCES` that surfaces as ordinary "Permission denied" text in the
   transcript.
5. **Nothing / wait for whole-pi containerization** — leaves the GuardFall
   write class open; ADR-0097 already rejected this posture.

## Decision Outcome

**Option 1**, scoped and named honestly. The decisions, D1–D9:

### D1 — This is Phase 2a: write confinement, and only that

The confined bash child tree cannot write, create, remove, or truncate
anything outside its granted subtrees, regardless of how the command
string was obfuscated — enforcement happens at `open()`/`unlink()`/
`rename()`, below the shell (ADR-0072's "only sound fix"). What this
genuinely closes: out-of-grant clobber (`>`, `dd of=`, `truncate`,
`find -delete`), `rm -rf` of anything outside the grants (`/`, `$HOME`,
`..`), and credential/persistence file tampering (`~/.ssh/authorized_keys`,
`~/.gitconfig` `url.insteadOf`, shell rc files, systemd user units,
crontabs). What it deliberately does NOT close: **reads**. ADR-0097
Phase 2's read-scoping bar is structurally unreachable with a broad read
grant under Landlock's grant-only model; **Phase 2b (read scoping)
remains open in #707** and this ADR must never be cited as having closed
it.

### D2 — Mechanism: vendored `landlock-run`; two consumers, two primitives

The launcher binary is **vendored** per the `agent/vendor/` pattern
(extracted from the platform npm tarball, sha256-pinned, Linux-only fetch
gate in `setup.sh`, structural validate script, `/vendor-update` re-audit
cadence) — never a runtime npm dependency. License: **BSD-3-Clause**.
Debian 13 (kernel 6.12, Landlock ABI 6) probes `full`; the probe, not the
distro name, is authoritative.

This answers ADR-0136 item (f): **two consumers, two mechanisms,
deliberately.** Package-agent children keep ADR-0130's bwrap (namespace
isolation is their requirement); session bash gets Landlock
self-restriction (inherited view is *its* requirement). The macOS leg
(Seatbelt, later — #707) is where primitive-sharing genuinely applies:
it reuses ADR-0130's SBPL builder art. Recorded so it is not re-litigated.

### D3 — Interception: one composed `shellPath` wrapper + a thin policy extension

ADR-0097's single-occupancy rule is honored by **merging** Phase 1 into
the Phase 2a wrapper: env-scoping (with the scratch HOME now
**session-keyed** — the current fixed path collides across concurrent
sessions) runs first, then
`exec landlock-run <grants> -- "$bash" "$@"`. Plain `-c` semantics are
preserved end-to-end (`-lc` is rejected: login-profile chains make
unauditable writes the grant set cannot anticipate); `HISTFILE` is
neutralized; the chain is `exec`-only so signals and exit codes propagate
without relay. A thin extension supplies policy: exports
`PI_SESSION_WORKTREE` and mode/grant configuration from
`extensionSettings` into pi's process env, runs `--probe` at session
start, and emits transcript-visible warnings. The wrapper fails closed
(exit 125 + marker) on a missing worktree var under enforce mode.

### D4 — Default grant set (Linux)

- `--ro /` — broad read+exec: keeps toolchains, linkers, and profile
  chains working; is also the honest boundary of D1.
- `--rw <session worktree>`.
- `--rw` the main repo's `.git/{objects,refs,logs,worktrees/<sid>}`,
  **enumerated** — git commit/branch work from a worktree needs the
  common dir, but `.git/hooks` and `.git/config` stay unwritable
  (hook-planting and `url.insteadOf` rewriting are exactly the D1 payoff).
  Git operations that write `.git`-root files (`pack-refs`, some gc paths)
  are known breakage: canary-tested at implementation, escape hatch or a
  per-host grant extension if they matter.
- `--rw` a session-keyed scratch dir and a session-keyed `$TMPDIR`
  subdirectory — never shared `/tmp` (cross-session tampering).
- `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/tty` individually.
- Configurable extras, defaulting to `~/.cache/pi_config/**` (extension-
  deps hydration, pi download cache) and `~/.npm` — both are
  executed-cache grants and carry a named confined-write/unconfined-
  execute TOCTOU residual; per-host removable.
- **Never grant:** `$HOME` broadly, `~/.pi/**` (an rw grant there lets a
  session rewrite `settings.json` and disarm this very wrapper), `/dev`
  broadly, other sessions' `.worktrees/<sid>` trees.
- Worktree write-exemption globs (`NEXT_SESSION*.md`, `.review/**`) are
  **not** granted to bash: handoff writes go through pi's in-process
  `write` tool, which ADR-0097's scope boundary leaves unconfined; a bash
  `echo >>` to them breaks by design.

### D5 — Rollout posture

Mode `{enforce, advisory, off}` per host via `extensionSettings`.
Defaults: **enforce when probe reports `full`**; loud advisory — a
transcript-visible warning on every session, never a silent log — when
`partial` or `unusable`; strict fail-closed (refuse the bash tool)
selectable for disposable VMs and CI, matching ADR-0130's
refuse-when-unverifiable philosophy. macOS: inert with a one-time notice
until the Seatbelt stage (#707). No standing Debian-13 CI lane exists to
exercise the probe today; #1046 validates on the `mcm` self-hosted runner
or a pibox Lima VM and records which.

### D6 — Escape hatch: operator-only, non-self-certifiable

`SKIP_BASH_CONFINEMENT=1`, honored **only** from the wrapper's own
process environment (inherited from pi's launch environment) — never
parsed from the command string, never read from any repo- or
worktree-local file a session can write (the ADR-0022 §Q5
trust-boundary argument, generalized: worktree isolation is a git
construct, not a permission boundary). *Erratum 2026-08-21: originally
cited "ADR-0070", a cross-repo number that resolves to an unrelated
pi_config ADR; the in-repo precedent is ADR-0022 §Q5 + ADR-0024. Note
this hatch is deliberately stricter than §Q5's announced inline
`GH_IDENTITY_OVERRIDE=<login>` form — an identity assertion names an
alternative and is announced per hit, while a confinement bypass is a
full disarm, so no command-string form exists at all.* Consequence accepted: the hatch is session-scoped
and operator-actuated; the agent cannot obtain a per-call bypass by
construction. Extra write grants live in a **user-level** file
(`~/.config/pi/` — outside every grant), reviewed like
`.secrets-guard-allowlist`.

### D7 — Guard trio: no relaxation

ADR-0097's consequence stands verbatim: the sandbox scopes what is
*reachable*, not whether `rm -rf .` inside the granted view was
*intended*. The worktree grant still contains everything the guards
protect, and confinement is Linux-only for now. Any future relaxation
must explicitly amend that ADR-0097 line, not ride in silently.

### D8 — Exit-code contract

Launcher refusal = **exit 125 AND** a stderr line prefixed
`landlock-run:` followed by a space (the launcher's own documented disambiguation; a successful exec can
never emit it afterwards). Exit 125 without the marker is an ordinary
command exit and passes through untouched — `git bisect run` inside the
confined tree never reaches the launcher's code.

### D9 — Corrections and named residuals

Corrections to #1033 recorded: BSD-3-Clause (not MIT); string mutation
(not argv) is the only tool_call surface, and no fork-side argv
verification record exists. Residuals this ADR names rather than
inherits silently:

- **Reads are unscoped** (D1) — `~/.aws`, `~/.ssh`, and `~/.pi/agent`
  auth material remain readable. Phase 2b's problem.
- **`/proc` same-uid disclosure** — a broad read grant reads other
  same-uid processes' `environ`/`cmdline`/`maps`; Landlock provides no
  namespace isolation. bwrap would hide this; session bash cannot pay
  bwrap's price (D2).
- **Inherited-TTY ioctls** (TIOCSTI class) — `IOCTL_DEV` does not cover
  inherited fds; whether `landlock-run` closes/reopens the TTY is an
  implementation-time check in #1046.
- **Unix sockets** — reachable via the filesystem view unless the ABI-6
  scope is requested; `SSH_AUTH_SOCK` remains the signing-oracle residual
  ADR-0097 recorded. ADR-0097's "Phase 2 must default-deny these"
  directive is carried by **Phase 2b** (#707), not waived: it is an
  ambient-credential exfil-class control, the half 2a defers, and 2a's
  own Decision Drivers require inheriting agent sockets for session bash
  to keep doing its job. (*Clarified 2026-08-21 — scope allocation, not a
  decision change.*)
- **Executed-cache grants** (D4) and **`.git` enumerated-grant gaps**
  (D4) as stated.
- **Upstream asks** (record, do not block on): a per-grant noexec flag
  (Landlock has a native EXECUTE right the pinned CLI does not expose —
  a scratch grant without exec would close the drop-and-exec pattern),
  and an audit-mode passthrough if kernels grow allow-and-log.

## Consequences

- Good: the GuardFall write class is closed at the syscall boundary on
  Linux; grants compose naturally with worktree isolation; denials
  self-report in the transcript for free.
- Good: the ADR-0136 (f) question is answered in writing; ADR-0130's
  builders stay single-purpose; the Seatbelt leg has a designated reuse
  path.
- Bad: reads remain open (named loudly, D1/D9); macOS stays unconfined
  until the Seatbelt stage; some `.git`-root git operations and literal
  `/tmp` writers break under enforce mode.
- Bad: a ~10-day-old dependency enters the vendor set — mitigated by the
  exact pin, the ~300-line auditable C source, and `/vendor-update`
  re-audits.
- Neutral: #707 narrows to Phase 2b (read scoping) + the macOS Seatbelt
  leg; #1046 owns the Phase 2a implementation.

## Known Limitations and Deferred Work

- Deferred: read scoping (Phase 2b) and macOS Seatbelt — #707.
- Deferred: egress (Phase 3) — #708, untouched by this ADR.
- Deferred: outbound-payload secrets scan — #709, still the cheap
  independent hardening.
- Open: no standing Debian-13 CI lane for probe validation (#1046
  chooses `mcm` runner vs pibox VM and records it).
- Open: upstream noexec/audit asks (D9) — filed upstream only if the
  soak proves the need.
