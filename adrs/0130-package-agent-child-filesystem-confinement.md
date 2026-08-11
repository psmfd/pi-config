---
status: Accepted
date: 2026-07-30
---

# ADR-0130: OS-level filesystem confinement for package-agent children

**Status:** Accepted
**Date:** 2026-07-30
**Related:** [ADR-0129](0129-package-agent-active-grant-authenticity.md) (the
authority model this confines the consumer of), [ADR-0097](0097-bash-tool-os-isolation.md)
(the bash-tool isolation arc whose boundary argument this reuses),
[ADR-0128](0128-stage-package-agent-authorization.md), #934
(this decision), #930 (the
dispatch path that consumes it), #707
(bash-tool Phase 2, which can reuse these builders), #887/#888
(the pi snapshot bump this sequences against)

## Context and Problem Statement

ADR-0129 grants approved package agents a finite built-in tool allowlist
(`read`/`grep`/`find`/`ls`; `bash`/`write`/`edit` refused). Those built-ins run
**in-process on the host with the operator's full permissions** — pi ships no
path scoping of any kind, deliberately (`docs/security.md`: "Pi does not
include a built-in sandbox... Real isolation needs to come from the operating
system"). The child-isolation CLI flags remove extension, skill, template, and
context surface; none scopes the filesystem. So an approved package agent
holding only `read` can read anything the operator can read — SSH private
keys, cloud credentials, unrelated repositories — and `secrets-guard` cannot
intervene, because it is an extension and extensions do not load in the child.
Issue #928 disclosed this in `lib/builtin-tools.ts`; #934 requires it resolved
before dispatch (#930) ships.

Facts established from pi's vendored source (0.81.1, cross-checked against the
v0.82.0/v0.82.1/v0.83.0 release notes — none of which touch path handling):

- `read`/`ls` are pure in-process `node:fs` calls; **`grep`/`find` spawn
  `rg`/`fd` child processes** that perform their own filesystem traversal
  (`dist/core/tools/grep.js`, `find.js`). Confinement must therefore cover the
  child's whole **process tree**, not just its PID.
- `rg`/`fd` are **downloaded from the GitHub Releases API at first use** unless
  already present or `PI_OFFLINE=1` (`dist/utils/tools-manager.js`).
- All four tools resolve absolute paths unchanged (`dist/utils/paths.js`); no
  `rootDir`/allowlist mechanism exists anywhere in the tool or path code.
- The extension `tool_call` hook can **block but not rewrite** a call
  (`BeforeToolCallResult` has no argument-rewrite field), and extension tools
  can shadow built-ins by name (the shipped Gondolin example does exactly
  that).
- The child inherits the parent's full environment by default, and pi's
  credential surface is disk-adjacent to the package content: `auth.json` and
  session files live under `~/.pi/agent/`, the **parent directory** of the
  package install root (`~/.pi/agent/git/<host>/<path>`).

## Considered Options

1. **OS-level per-child sandbox (chosen).** The broker-owned spawn (#930)
   wraps the child pi process in a kernel-enforced filesystem view: only the
   package install root (read-only), a scratch dir (read-write), and the
   minimal runtime closure exist; outbound network stays open for the model
   provider. `bwrap` on Linux, `sandbox-exec` (Seatbelt) on macOS.
2. **Tool-layer interception** — load one content-addressed guard extension
   into the child (explicit `-e`) whose `tool_call` handler denies file
   built-in calls resolving outside the package root. Rejected. Unlike the
   bash case ADR-0097 rejected, file built-ins do receive the literal path as
   a structured argument — but the gate still (a) **fails open** on any logic
   gap (symlink resolution, APFS case-insensitivity, NFC/NFD normalization,
   glob roots) with no detection mechanism, (b) does not confine the `rg`/`fd`
   **subprocesses** that do the actual traversal — the guard sees only the
   requested root argument, not what the search engine then touches, and
   (c) structurally contradicts #928's no-extensions-in-child invariant,
   growing the dispatch TCB and requiring its own review round for a weaker
   guarantee than option 1.
3. **Shrink the grantable set to zero (prompt-only v1).** Rejected as a
   standalone decision: #916's descriptor validation refuses an empty `tools`
   array and the refusal philosophy forbids silently narrowing an allowlist,
   so "every file tool refused" means **no package agent is approvable at
   all** — it does not ship a limited v1, it ships nothing. Its posture
   survives as this decision's **failure mode**: where confinement cannot be
   verified, dispatch of file-tool grants is refused (see below).
4. **Landlock (Linux) / `systemd-run` properties** — viable fallbacks,
   recorded but not chosen as primary: Landlock is a self-restriction API
   needing an exec shim (and has no stock Debian CLI); `systemd-run --user`
   ties confinement to a user systemd instance that is not guaranteed
   present. `bwrap` fully wraps the spawn with no cooperation from the child.

## Decision Outcome

**Option 1**, with option 3's refusal as the fail posture. Confinement is
applied by the broker at spawn time and **verified empirically before every
dispatch**; it never becomes an authorization input and never touches the
grant digest — the tool set the operator approved is unchanged, only its
filesystem reach is bounded. This mirrors ADR-0097's boundary argument
exactly: the sound enforcement point for in-process file operations is the
kernel, not an in-process check.

### Per-platform mechanism

- **Linux (Debian 13 baseline):** unprivileged `bwrap` with `--unshare-all
  --share-net --die-with-parent`; read-only binds for the pi binary, system
  libraries, `/etc/resolv.conf`, `/etc/nsswitch.conf`, `/etc/ssl`, the
  pre-provisioned `rg`/`fd` binaries (`toolBinDir`), and the package install
  root; a `--bind` scratch dir (read-write, caller-owned — see the environment
  contract for its cleanup duty); nothing else present in the mount namespace.
  `/usr/bin` and `/bin` are deliberately NOT bound wholesale — bwrap makes a
  bound executable tree runnable, so only the child binary and `toolBinDir`
  are exposed (the child `PATH` names `toolBinDir` alone). `--clearenv` plus `--setenv` for each allowlist entry
  make the child environment self-contained in the argv, so the child cannot
  recover the broker's environment via `/proc/self/environ` (a same-uid
  self-read the filesystem allowlist does not stop). Debian does not restrict
  unprivileged user namespaces by default, but conflicting reports exist across
  derivatives — which is why availability is **probed, never assumed** (below).
- **macOS:** `sandbox-exec` with a **deny-default** SBPL profile (the
  first-rule-decides trap — an `(allow default)` profile is a denylist and was
  the vector in a documented real-world escape). The profile allowlists: the
  root-directory literal and dyld/runtime paths (`/usr/lib`, `/System`,
  `/private/var/db/dyld`) as a verified bootstrap requirement — without a
  `file-read` on the root directory itself the Bun child aborts before main;
  `sysctl-read`; `mach-lookup` **scoped to `com.apple.mDNSResponder`** (DNS
  resolves via mDNSResponder over Mach IPC — without it `getaddrinfo` fails
  even with network allowed) rather than every registered Mach service;
  `file-read-metadata` **scoped to the same runtime read-set plus the package
  root and scratch** rather than a whole-filesystem `subpath "/"` — a blanket
  metadata grant is an existence oracle over `~/.ssh`, `~/.aws`, and sibling
  repos, which the scoped form removes; content reads under the package root
  and runtime closure only; writes under scratch only; and `network-outbound`.
  `sandbox-exec` is deprecated-but-functional and is the same mechanism Codex
  CLI and Claude Code ship today; the SBPL dialect is an Apple-internal API,
  so the profile is **revalidated by the canary probe on the running OS**
  rather than trusted across macOS releases. Seatbelt confinement is inherited
  across `process-exec`, so `grep`/`find`'s `rg`/`fd` children are confined by
  the same profile (proven in the adversarial suite); `process-exec` is
  itself allowlisted to the child binary and the tool-bin dir only.

  The `mach-lookup` scope is deliberately tight. If the real Bun child needs
  additional Mach services for TLS trust evaluation, the positive egress
  canary (below) turns that into a fail-closed dispatch refusal, and widening
  the allowlist is a reviewed change, not a silent runtime fallback.

### Fail-closed canary verification (required at every dispatch)

Before the real child spawns, the identical wrapper runs a canary probe:

1. an out-of-scope read (a file the operator CAN read — e.g. a broker-created
   canary outside the package root) **must fail** — and every entry in
   `SENSITIVE_AGENT_SUBPATHS` (auth.json, settings.json, sessions, extensions,
   skills, prompts) is probed, not only auth.json, so a narrow over-allow that
   spares auth.json cannot pass silently;
2. an in-scope read under the package root **must succeed**;
3. a write inside the read-only package root **must fail**, a write outside
   every bound tree **must fail**, and a write inside scratch **must succeed**;
4. if a provider `host:port` is supplied, the confined child **must complete a
   TLS handshake to it** — a positive egress probe that converts an over-tight
   `mach-lookup`/network profile into a fail-closed refusal rather than a
   silently broken child. A bare TCP connect is insufficient: it exercises only
   DNS and socket egress, not the Mach-IPC trust-evaluation path a too-narrow
   `mach-lookup` scope would break, so #930 must perform a real handshake.

Any anomaly — mechanism missing, wrapper error, canary read succeeding, egress
probe failing — means confinement is unavailable or wrong: **dispatch of a
grant containing any file built-in is refused.** A probe is used instead of
tool-presence or distro-version checks precisely because platform defaults
conflict across derivatives and macOS releases; the probe answers
authoritatively on the running host.

### Child filesystem and environment contract

- `~/.pi/agent` (auth.json, sessions, settings, extensions) is **never**
  visible to the child, even though the package root nests under it — the
  bind/allow is the package-root subpath only, and the spec builder refuses a
  package root that is not strictly under `<agentDir>/git/`.
- `rg`/`fd` are pre-provisioned read-only and `PI_OFFLINE=1` is set: the
  child never downloads tool binaries at runtime.
- The environment is an **explicit allowlist** (never inherited): minimal
  `PATH`, `HOME`/`TMPDIR`/`PI_CODING_AGENT_DIR` pointed into scratch (on
  pi ≥ 0.82.0 crash/debug logs honor `PI_CODING_AGENT_DIR`, keeping all child
  writes in scope), TLS CA path pinned explicitly on Linux. A credential var
  colliding with any of these reserved keys is refused, not overwritten. On
  Linux the allowlist is OS-enforced via `--clearenv`/`--setenv`; on macOS
  `sandbox-exec` does not scope the environment, so the dispatcher must pass
  exactly this map as the spawn env — macOS has no `/proc/self/environ`, so the
  self-read leak `--clearenv` closes on Linux does not exist there.
- **Scratch lifecycle is the dispatcher's duty.** Linux scratch is a
  caller-owned `--bind` dir, not a `--tmpfs`, so the dispatcher (#930) must
  create it `0700`, keep it per-dispatch, and remove it after the child exits —
  crash/debug artifacts and any credential-derived state written there do not
  vanish with the mount.
- **Credentials (amended 2026-07-30 for pi v0.82.1/v0.83.0):** the target
  mechanism is a **short-lived bearer token minted by the broker at dispatch
  time** (`pi auth print-bearer-token`, v0.83.0 — automatic OAuth refresh,
  minimum-validity enforcement) passed as `ANTHROPIC_AUTH_TOKEN` (v0.82.1) —
  the raw provider key and `auth.json` never enter the sandbox. Until the
  vendored pi snapshot is bumped to ≥ v0.83.0, the fallback is passing the
  provider API key env var alone. **Sequencing:** the snapshot bump
  (#887/#888 arc, now v0.83.0) should land before #930 ships; note the bump
  is non-trivial (v0.83.0's TypeBox 1.3.7 breaking change must be checked
  against all extensions).
- **Credential delivery must not use the visible argv.** The Linux env
  allowlist is `--clearenv`/`--setenv`, which places every value — including
  the credential — in bwrap's arguments. bwrap survives as the sandbox monitor
  process, and its `/proc/<pid>/cmdline` is **world-readable** on a default
  Debian host (`hidepid=0`), a strictly broader exposure than the same-uid
  `/proc/self/environ` self-read `--clearenv` closes. The dispatcher therefore
  MUST deliver the bwrap arguments through bwrap's `--args <fd>` primitive
  (`encodeBwrapArgsFd` produces the NUL-separated payload; spawn
  `bwrap --args <fd> -- …`), so the only visible argument is the fd number and
  no `--setenv` value reaches `cmdline`. The credential then lives in the
  child's `environ` only — a same-uid exposure matching the disclosed non-goal.
  On macOS the credential flows through the real spawn environment (there is no
  `sandbox-exec` argv equivalent, and no `/proc` to self-read), so it never
  reaches an argv either. The adversarial suite spawns the Linux child through
  the `--args <fd>` path and asserts a planted broker secret does not appear in
  the child's `/proc/self/environ`.

### What this does and does not guarantee

Confines the child process tree's filesystem view (reads and writes) and its
tool-binary provenance. It does **not**: filter egress content (the child can
send whatever it read in-scope to its provider — egress policy is the
issue-#708 problem class, out of scope); hide the child's own environment (including
the credential) from unconfined **same-UID** processes via `/proc/self/environ`
or `ps` (the `--args <fd>` delivery keeps it out of the world-readable
`cmdline`, but same-uid environ visibility remains); or survive Apple removing
`sandbox-exec` (the canary probe converts that event into refused dispatch, not
silent unconfinement — and `sandbox_init()` is the recorded fallback path).

**Platform exec-surface asymmetry.** macOS scopes `process-exec` to the child
binary and `toolBinDir` only. bwrap has no per-bind `noexec` and no exec
allowlist, so any executable *present in the namespace* can run — but the
namespace contains only the child binary, `toolBinDir`, system libraries, and
the package root, and the package root is `--ro-bind` (an attacker-planted
executable there is runnable only if an exec primitive is granted). The
grantable tool set (`read`/`grep`/`find`/`ls`, no `bash`) exposes no such
primitive, so this is inert today. It becomes live if these builders are reused
for a tool set that can exec package-controlled paths (e.g. the #707 bash-tool
Phase 2 reuse), which must add a `noexec`/`seccomp` exec restriction before
relying on them — recorded here so the asymmetry is not silently inherited.

### Policy version

`GRANT_POLICY_VERSION` bumps 1 → 2: the tool policy's meaning changes (file
built-ins are dispatchable only under verified confinement). Existing
in-memory grants are invalidated by digest, which is the intended effect.

## Consequences

- #934 delivers the **pure builders** (`lib/child-sandbox.ts`: SBPL profile,
  bwrap argv, env allowlist, canary plan, spec validation) plus adversarial
  tests that spawn real sandboxed processes where the mechanism is available
  and assert correct unavailability classification where it is not. The
  broker extension itself remains spawn-free; its existing static
  no-spawn/no-network assertions hold unchanged.
- #930 wires the builders into dispatch: run the canary probe under the
  authority-lock-external ordering, spawn through the identical wrapper,
  refuse on any probe anomaly, and add the admission/attestation audit
  events (ADR-0129, #929 hand-off).
- #707 (bash-tool Phase 2) can reuse the same builders — noted there after
  merge.
- Raising the child's filesystem view, weakening the canary requirements, or
  reintroducing inherited environment invalidates this decision's security
  review and needs a fresh one.
