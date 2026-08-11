---
status: Accepted
date: 2026-07-28
---

# ADR-0129: runtime-scoped authority for package-agent active grants

**Status:** Accepted — the security review [ADR-0128](0128-stage-package-agent-authorization.md) requires before any activation capability ships was performed on this design and passed (see Security Review Record below)
**Supersedes (in part):** [ADR-0127](0127-package-agent-consent-and-work-item-credential-boundary.md) — §4's durable grant store, catalog-epoch-as-authority, and reload-to-activate model; §5's `grant revision` digest field; and §6's durable-epoch equality check and allowance for headless consumption of existing grants. All other §5 digest contents, §6's collision/isolation/attestation/dispatch-revalidation rules, §4's prohibited-approval-channel enumeration, and §§1–3 and §7 carry forward unchanged
**Related:** #913 (epic), #917 (sub-epic), #927 (this decision), #928, #929, #930, #931, [ADR-0128](0128-stage-package-agent-authorization.md) (staged authorization), [ADR-0097](0097-bash-tool-os-isolation.md) (bash-tool isolation scope boundary)

## Terminology

**Runtime** means one pi OS process and the extension instances it hosts. This
record uses "runtime-scoped" throughout and avoids "session-scoped": pi's
`session_start` event distinguishes `new`, `resume`, and `fork` reasons within a
single process, so a logical session is not the same boundary as a process. The
authority described here is bounded by the **process**, not by the logical
session.

## Context and Problem Statement

ADR-0128 staged package-agent authorization into two records: #916 persists
permanently inert review drafts, and #917 owns every authorizing artifact. It
resolved #916's blockers by removing authority from the record entirely, and
handed the unsolved half to #917 explicitly:

> #917 inherits the hard problem explicitly: active-grant authenticity against
> same-user mutation has no approved design yet and must clear its own security
> review before implementation.

ADR-0127 §§4–6 specify that authority as a **durable** artifact: a grant file in
an operator-owned directory, a durable monotonic catalog epoch, a per-agent grant
revision, activation after reload, and a dispatch-time digest match against the
persisted grant.

Two properties of that design are unattainable in pi's execution model:

1. **Forgery.** Pi extensions execute with the operator's full OS permissions,
   and the model can invoke file and shell tools in the same security context
   (ADR-0127, "Trust Boundary and Non-goals"). Any grant file the broker writes,
   the model can also write. A forged grant authorizes an agent the operator
   never approved.
2. **Rollback and replay.** Even with an unforgeable authenticator, an attacker
   with file access can restore a previously valid grant after it was revoked or
   narrowed. Defending this requires a monotonic high-water mark that is itself
   protected from the same attacker.

Neither is a hardening gap. No same-user file store can close them, because the
attacker's write authority over the store is identical to the defender's.

The productive question is therefore not *how do we protect the grant file* but
**what must the dispatch path trust, and can the file be removed from that set?**

## Decision Drivers

- ADR-0128 mandates that this design pass its own security review before any
  activation capability ships.
- ADR-0127's non-goals exclude a separate process, separate OS identity,
  authenticated IPC, and filesystem/network isolation from #913.
- The `debian-baseline` rule: guidance and mechanism must be portable, not
  macOS-only.
- The design must not degrade into "confirm every dispatch," which is not
  authorization but the absence of it.
- Whatever is claimed must be true. An overstated boundary is worse than a
  modest one, because downstream work relies on the claim.

## Considered Options

### 1. Durable grant authenticated by an OS-keychain MAC key

Hold a MAC key in the macOS Keychain (or libsecret on Linux) with an ACL
restricting access to the pi binary; MAC the grant with it.

**Rejected.** Keychain ACLs bind to an application's code signature; the
vendored pi runtime is a bun-compiled binary whose signing status is not
guaranteed by this repo, and the model can invoke that same binary directly, so
an ACL keyed to it authorizes the attacker's path too. There is no Debian
equivalent that meets the bar: once a libsecret/gnome-keyring collection is
unlocked, any same-user process reads it. This raises the cost of an attack
without moving the boundary.

### 2. Durable grant with a hardware-backed, presence-requiring signature

Sign grants with a FIDO2 credential requiring a physical touch
(`ssh-keygen -t ed25519-sk`) or a Secure Enclave key gated by Touch ID.

**Rejected as the boundary; retained as optional future hardening.** This
genuinely defeats software-only forgery: without the token and a human finger,
no valid signature can be produced. But it does not solve rollback. An attacker
replays an older, validly signed grant, and detecting that requires the verifier
to remember the highest counter it has seen — in WebAuthn/FIDO2 the relying
party, not the authenticator, stores and checks the signature counter — so the
high-water mark lives in a same-user file, which is the original problem one
level down. It also introduces a hardware dependency, no headless story, and
macOS/Linux divergence. It is a worthwhile *additional* layer later; it is not a
boundary.

### 3. Durable grant, tamper-evident only

Persist grants in a hash-chained append-only log and detect tampering rather
than prevent it.

**Rejected.** Detection after the fact does not stop an unapproved child from
being spawned, which is the criterion #917 must meet. The chain is same-user
writable, so an attacker rewrites it wholesale rather than breaking a link.
OS-enforced append-only or immutable attributes (Linux `chattr +a`, macOS
`schg`) would raise that specific bar, since setting or clearing them needs
`CAP_LINUX_IMMUTABLE` or root — but they do not change the outcome, because the
defect is that detection is not prevention. It buys accountability against
accidents, not authority against an adversary.

### 4. Runtime-scoped authority

Authority exists only in broker process memory for the runtime in which the
operator approved. Nothing on disk is read back as authorization.

**Chosen** — see below.

### 5. Separate process or OS identity with authenticated IPC

The only construction that would make a durable grant genuinely
forgery-resistant against this attacker.

**Rejected**, restating ADR-0127: explicitly outside #913's scope, and it would
require a security architecture (privileged helper, IPC authentication, its own
update and trust story) larger than the feature it protects. Recorded here so a
future decision has the option enumerated rather than forgotten.

## What Runtime-Scoped Authority Actually Buys

Two earlier drafts of this record claimed in-memory authority is a *stronger
boundary* than a file against a same-user adversary. Security review disputed
the justification twice, and the claim was then tested against pi's shipped
code rather than argued further. The result is a narrower and better-supported
claim, stated here in place of the original.

### What was verified

**Process topology is not the argument.** Per
[ADR-0097](0097-bash-tool-os-isolation.md), pi's `read`/`write`/`edit`/`grep`/
`find`/`ls` built-ins run **in-process on the host with full permissions**; only
the bash tool's child tree is a separate process. An earlier draft claimed the
file tools were child processes. That was false.

**No memory primitive is reachable through the file tools.** `/proc/self/mem`
was raised as an ordinary read of a special path that would bypass `ptrace`
entirely, since the kernel permits a process to read its own memory. Checked
against pi's shipped implementation: `read` calls `readFile(path)` and `write`
calls `writeFile(path, content)` (`dist/core/tools/read.js:23`,
`dist/core/tools/write.js:16`), both starting at byte offset 0, and `read`'s
`offset`/`limit` are **line numbers applied after the whole buffer is read**
(`read.js:193-204`), not a byte seek. `/proc/<pid>/mem` returns `EIO` for
unmapped offsets and offset 0 is unmapped, so both tools fail immediately and
neither can seek to a mapped address. The path is **not exploitable as
implemented**. Neither tool carries an `S_ISREG` guard, so this rests on the
absence of a byte-seek rather than on a deliberate refusal — a defence-in-depth
gap worth closing upstream, tracked separately, not relied on here. `edit` also
runs in-process and composes read and write; #929 verifies it exhibits the same
no-seek behavior rather than inferring it.

**Escalating to in-process code is possible.** pi auto-discovers extensions from
`<cwd>/.pi/extensions/` and `<agentDir>/extensions/` with no settings entry
required (`dist/core/extensions/loader.js:534-539`; this host's `settings.json`
has no `extensions` key, yet every extension loads). So the model's ordinary
file-write capability converts into in-process code execution **at the next
start or `/reload`** — and reload is routine, not exotic. The reload is the
cheapest path, not the only one: a bug or supply-chain compromise in
already-loaded, already-trusted code reaches the same address space with no
reload at all. The general non-guarantee below is stated without the reload
qualifier for that reason.

### The resulting claim

Within a live runtime, in-memory authority is genuinely out of reach of the
model's tool surface: no file tool yields a memory primitive, and obtaining one
means spawning a debugger through bash, which is a **descendant** — the
direction Debian's default `kernel.yama.ptrace_scope=1` denies, and which macOS
denies via `task_for_pid` absent a debugging entitlement.

Across a reload it is not a boundary at all: pre-planted extension code loads
beside the broker and can read or modify the grant directly.

So the honest claim is **a narrower window, not a stronger wall**. What this
design removes is *durable, unattended authority* — authority that persists
while no operator is present and that an attacker can forge or roll back at any
future time of their choosing. What remains is an attacker who must already have
planted code before the operator approves, and who gets one runtime's worth of
window before the grant dies with the process.

### Why this still favours the chosen option

Critically, the extension-planting path defeats a **durable** grant at least as
easily — an attacker who can write files can simply forge the grant file, with
no reload required and no need to be present during a live session. Runtime-scoped
authority is therefore **never weaker than the durable design and strictly
stronger within a live runtime**. ADR-0128's decision to stop #916 minting
durable grants stands unchanged; only the strength of the claim made for the
replacement needed correcting.

Three load-bearing conditions follow, and all are restated as non-guarantees
below: this buys nothing against code already running inside the broker's
runtime; it assumes the platform's debugging restrictions are in force and that
the runtime does not hold `CAP_SYS_PTRACE`; and it assumes the vendored pi
binary carries no debugging entitlement and is never launched with an inspector
flag.

## Decision Outcome

Adopt option 4. Apply ADR-0128's move a second time: rather than defending an
authority-bearing file, remove the file from the set of things the dispatch path
trusts.

### The authority object

An **active grant** is an in-memory object held by the broker extension for the
lifetime of one pi runtime. It is created only by a fresh direct interactive TUI
approval within that runtime, over a completely reconstructed effective
definition (#928). It is never serialized into any form that the dispatch path
reads back as authorization.

**The approval ingress restriction is ADR-0127 §4's, restated as binding here**
so that no reader infers a relaxation from the partial supersession: conversation
text such as "approved," project trust, package installation, a model-callable
tool call, an RPC prompt, a `registerCommand` handler, and extension-injected
user messages do not create a grant. Approval is exact raw direct-TUI ingress
only — the gate #916 already implements (`ctx.mode === "tui"`,
`event.source === "interactive"`, `event.streamingBehavior === undefined`).

### Approval is a display-to-commit transaction

The bytes the operator reviewed must be the bytes bound into the grant. #928
inherits #916's committed transaction shape without weakening it: re-run
discovery and reconstruction under the commit lock, compare the freshly
reconstructed definition against the exact snapshot that was displayed, and abort
the approval if any byte differs. Computing the grant digest from the initially
reconstructed definition without that recomparison is prohibited — it reopens the
same-user substitution attack this record exists to close, with the operator
approving one definition while a different digest becomes authoritative.

### The dispatch trust set

At dispatch the broker trusts exactly two things:

1. the in-memory grant — the full canonical payload and its digest, captured at
   approval; and
2. bytes it re-reads and re-verifies against that in-memory digest under the
   authority lock.

It trusts **no file** for authorization. There is consequently no persisted
authorization artifact to forge, replay, or roll back.

### Approval and dispatch are separate operator-visible operations

ADR-0127 §4 rejected "activate immediately in the approval handler" because
dynamic registration would change the routing surface in the approving call frame
and make activation harder to observe and revoke. An earlier draft answered this
with a rule phrased as "no dispatch before the operator supplies a new,
independent input," which is defeated by arming a trigger during approval and
firing it on the operator's next unrelated keystroke. The rule is therefore
stated as a structural prohibition rather than a timing one:

- The approval flow **must not offer, arm, schedule, register, enable, or
  pre-authorize a dispatch.** It creates the authority object, records its
  non-authorizing receipt, and terminates — the approval handler returns before
  any dispatch code path executes, synchronously included. Presenting "dispatch
  now?" as part of approval is prohibited.
- No state written during approval may cause a dispatch to occur. Every dispatch
  requires a **subsequent request that explicitly names the qualified identity to
  dispatch** and is not causally derived from the approval — not merely a later
  input of any kind.
- This binds every asynchronous scheduling mechanism the runtime provides,
  without relying on an enumeration: microtasks, `process.nextTick`-class
  queues, timers, `MessageChannel`/worker scheduling, event emissions, and
  queued messages are all in scope, as is any equivalent added later.

Given these, ADR-0127 option 7's rationale does not reach this design.
**Nothing is registered:** no agent enters the `subagent` catalog and no tool is
added. `discoverAgents()` reads only `<agentDir>/agents` and the nearest project
`.pi/agents`, so a package agent under a package install root remains
structurally invisible to the `task` tool. Dispatch stays an explicit,
separately invoked broker operation that reconstructs and revalidates the full
payload every time.

### Who may invoke dispatch

Approval is direct-TUI only; **dispatch is not restricted by provenance**, and
that is safe by construction rather than by trust: a dispatch request cannot
create, widen, extend, refresh, or revive a grant, and it cannot cause an
approval prompt to be shown. It can only ask to use a grant that already exists
in this runtime's memory. A request naming an unknown, expired, or revoked grant
fails closed with no fallback and no prompt — an untrusted-provenance caller must
never be able to induce an approval dialog, which would convert dispatch spam
into approval fatigue.

**The dispatch request carries a qualified-identity reference and nothing else.**
Its parameter schema must not accept grant content, a digest, a payload, or any
other caller-supplied material that the broker would then treat as authoritative
— not even as a convenience or debug affordance. Admitting such a parameter would
reopen, through a tool or RPC channel, exactly the externally-supplied-artifact
problem this record closes for files.

**Re-approval while a grant is live.** Approving the same qualified identity
again in one runtime atomically retires the prior grant under that identity's
authority lock and installs the new one; two approval identifiers for one
identity are never simultaneously resolvable. A `revoke` naming that identity
therefore always has exactly one target. Re-approval takes the same preemptive
lock priority as revocation (rule 3 below) — it too narrows or replaces
authority, and an operator's re-approval must not queue behind model-driven
dispatch traffic. Approving a **different ref** of the same package and agent is
a distinct qualified identity, so it does not retire the older grant; ADR-0127
§6's package-identity collision refusal applies and the approval is refused
until the older grant is revoked, rather than leaving two independently
dispatchable grants for what an operator would read as one agent.

Because dispatch is model-reachable, #929 enforces a **per-runtime dispatch
concurrency and rate bound** (consistent with the `subagent` extension's existing
`MAX_CONCURRENCY` precedent). Its purpose is resource containment and, per the
locking rules below, preventing dispatch volume from delaying a revocation.

### The two locks are distinct, ordered, and bounded

Two different locks appear in this design and must not be conflated:

- the **authority lock** is an in-process mutex serializing reads, creation, and
  revocation of the in-memory grant, and it is held across dispatch-time
  revalidation and process creation. It is in-process because the object it
  guards is in-process; nothing outside this runtime can affect it. It is
  **per-qualified-identity, not runtime-global**, so dispatching agent A never
  serializes behind agent B and the per-runtime concurrency bound below remains
  meaningful. Read-only display paths (`/package-agent status` and the like) take
  the lock too: a status read that races a revocation would otherwise report
  authority that no longer exists, and this design leans on status being the
  operator's window onto an object they cannot otherwise see.
- the **store lock** is #916's existing cross-process `O_EXCL` file lock, which
  serializes writes to the shared receipt and audit records only. It never
  participates in an authorization decision, and its presence or absence is never
  an authorization input.

Three rules keep them from interfering:

1. **Ordering.** The authority lock is never held while acquiring the store lock.
   Authorization-relevant in-memory mutation completes and the authority lock is
   released *before* any cross-process receipt or audit I/O. #916's store lock
   retries with backoff, and a revocation must never wait behind that.
2. **Bounded hold.** The authority lock's hold across process creation is bounded
   by a timeout, **defaulting to 5 seconds**; exceeding it fails the dispatch
   closed and releases the lock. The magnitude is load-bearing, not incidental:
   rule 3's anti-starvation guarantee is only as strong as this bound, so an
   implementer raising it to tolerate slow child startup is trading away
   revocation latency and must say so.
   "Fails closed" is broker bookkeeping and does not by itself prove no OS
   process resulted: if the spawn call may already have succeeded when the
   timeout fires, the broker must attempt to terminate that process and record
   the attempt. Consistent with ADR-0127 §6, that termination is best effort and
   is not an authorization guarantee.
3. **Revocation preempts, and is never starved.** A revocation arriving while a
   spawn is in flight is recorded as pending and applied at the earliest point
   the authority lock is released. A pending revocation **takes the lock ahead of
   every already-queued and subsequently-arriving dispatch waiter** — a plain
   FIFO mutex is insufficient, because sustained rate-bound-compliant dispatch
   traffic would otherwise let queued waiters spawn children after the operator
   revoked but before the revocation is serviced, contradicting the guarantee
   below.

Where ADR-0127 §6 says the dispatch transaction runs "under a cross-process
broker lock," that role passes to the authority lock; the cross-process lock
survives only for its store-serialization purpose.

### Reconciling ADR-0127 §5 and §6

ADR-0127 §5 requires the digest to bind "the qualified agent's grant revision,"
and §6 requires "the runtime's catalog-epoch snapshot to equal the durable
epoch." Neither construct survives, so each is resolved explicitly rather than
left for an implementer to re-derive:

- **grant revision** → a **runtime-scoped approval identifier**: a runtime
  instance identifier plus a monotonic per-runtime approval sequence for that
  qualified identity. It occupies the same digest position and serves the same
  purpose — distinguishing two approvals of otherwise-identical content — without
  implying durability. The runtime instance identifier is a high-entropy random
  value generated once at runtime start — 32 bytes from `crypto.randomBytes`,
  matching the review-draft nonce's `DRAFT_NONCE_BYTES`. Deriving it from the PID
  is prohibited: PIDs are reused. The approval identifier and the nonce are both
  retained and are **not** interchangeable: the identifier carries a monotonic
  per-identity sequence (what makes re-approval ordering and audit ordering
  well-defined), while the nonce carries one-shot randomness (what makes two
  byte-identical approvals distinguishable). Dropping either as redundant is a
  mistake.
- **durable-epoch equality** → **removed, not replaced.** The epoch check existed
  so a runtime holding a stale in-memory catalog snapshot could not activate
  against a durable store that had moved on. With authority held in memory and no
  durable store to diverge from, that staleness class does not exist. Its
  remaining function — detecting that relevant state changed between approval and
  dispatch — is already discharged by §6's full-payload reconstruction and exact
  digest match, which runs on every dispatch and covers strictly more than a
  counter could. An earlier draft substituted a "runtime-local generation
  equality" check; three independent reviewers found it underspecified and
  observed that a runtime-wide counter would spuriously invalidate agent A when
  unrelated agent B was approved, creating an obvious incentive to disable it.
  Specifying a redundant check precisely is worse than removing a redundant
  check. A monotonic per-runtime counter is retained for **audit ordering only**
  and is explicitly not an authorization input.

Every other §5 digest field carries forward unchanged.

### Nonce and expiry under a runtime-scoped grant

Both survive §5 with defined meaning:

- the **nonce** binds one specific approval instance into the digest, so two
  approvals of byte-identical content in one runtime are distinguishable.
- **expiry** is an absolute bound measured from approval and enforced at every
  dispatch, not a vestigial field. It exists for the unattended-terminal case: a
  runtime can outlive the operator's presence by days, and a grant lasting as
  long as the process would make "the operator was there" arbitrarily stale.
  #929 implements an absolute lifetime with a default of 4 hours; the value is a
  design parameter, the enforcement is not optional. Elapsed time is measured
  from a **suspend-inclusive monotonic** source — `CLOCK_BOOTTIME` or
  equivalent, not `CLOCK_MONOTONIC` — for two distinct reasons. Wall-clock time
  is rejected because adjusting the system clock backward would extend a grant.
  Plain `CLOCK_MONOTONIC` is rejected because on Linux it excludes time the host
  is suspended, and suspending is reachable through the bash tool
  (`systemctl suspend`, `pmset sleepnow`), so repeated suspend/resume cycles
  could stall a 4-hour countdown across far more wall-clock time than intended
  — defeating the unattended-terminal case the bound exists for. macOS needs the
  same care rather than less: Darwin's `CLOCK_MONOTONIC`/`mach_absolute_time`
  also pauses across sleep, and only `mach_continuous_time` is suspend-inclusive.
  #929 therefore verifies the suspend-inclusiveness of whatever primitive the
  runtime actually resolves to, on **both** platforms, rather than assuming
  either one is safe by default. Wall-clock timestamps remain in receipts and
  audit records for human readability only.

### Operator-set parameters

Three values in this ADR are design parameters rather than derived results. The
operator set them on 2026-07-28, after this ADR was accepted:

| Parameter | Value | Where |
| --- | --- | --- |
| Absolute grant lifetime | 4 hours | "Nonce and expiry", above |
| Spawn-lock acquisition timeout | 5 seconds | "The two locks are distinct, ordered, and bounded" |
| Simultaneous active grants per runtime | 32 identities | "Consequences" |

Only the lifetime moved from the accepted draft's value (8 hours); the other two
were affirmed as written. Shortening the lifetime tightens the bound rather than
widening it, so it does not disturb the Security Review Record below — that
verdict is invalidated only by a change that widens what a grant authorizes,
relaxes the approval ingress, or reintroduces durable authority. Re-tuning any
of these three within the same direction is a parameter decision recorded here;
raising the lifetime or the cap is not, and needs its own review.

### Revocation and lifetime

Revocation drops the in-memory object under the authority lock. There is no
durable grant to race, no epoch to advance for authorization purposes, and no
rollback surface. The linearization guarantee ADR-0127 §6 sought is preserved
within the runtime: a child created before the drop may already be active; none
can be created after it. Consistent with ADR-0127 §6, **termination of an
already-running child remains best effort and is not the authorization
guarantee.**

Authority dies with the runtime. Process exit is a complete revocation of
everything in that runtime. `/reload` tears down and re-instantiates the
extension runtime — pi fires `session_shutdown` with `reason: "reload"` and marks
the prior extension instance stale (`invalidate()` / `assertActive()` in the
extension SDK types) — so reload clears authority and re-approval is required
afterward. #929 carries this as a tested acceptance criterion rather than an
assumption.

### What carries forward from ADR-0127 unchanged

§5's content-bound digest contents apart from the grant-revision substitution
above; §6's collision refusals, child isolation rules, ordered content-addressed
extension/module closure, child startup attestation, and dispatch-time
full-payload revalidation; §4's prohibited-approval-channel enumeration; §§1–3
(typed work-item extension, credential boundary, package layout and
distribution); and §7 (credentialless companion agent).

## Scope of the Guarantee

Stated explicitly so downstream work does not over-rely on it.

**This design guarantees:**

- No persisted authorization artifact exists, so no file can be forged or rolled
  back to *create* authority for an unapproved package agent. Dispatch of bytes
  other than those approved is separately bounded by the residual verify-then-exec
  window below, which is narrowed rather than closed.
- Revocation and process exit prevent any *new* child from being created from
  that grant, within the runtime that holds it, taking effect at the next
  authority-lock release and therefore bounded by the spawn timeout above — not
  instantaneously, since a spawn already holding the lock completes first.
  Already-running children are not killed; termination is best effort
  (ADR-0127 §6).
- No review draft (#916) and no approval receipt can shorten or satisfy an
  approval.

**This design does not guarantee:**

- **Intra-process integrity, reachable by file write across a reload.** Code
  running inside the broker's own runtime can read or modify the in-memory
  grant, and the model's own write access is the enabling step: pi auto-discovers
  extensions from `<cwd>/.pi/extensions/` and `<agentDir>/extensions/` with no
  settings entry, so planted code loads beside the broker at the next start or
  `/reload`. This is disclosed as a *first-class* limitation rather than a
  hypothetical compromised-extension scenario. It is the reason this record
  claims a narrower window rather than a stronger wall — and, as argued above,
  the same capability defeats a durable grant file more cheaply still. Child
  isolation (`--no-extensions` plus an explicit approved closure) limits what the
  *child* loads; it does not harden the parent.
- **Platform debugging defaults.** The argument above assumes Debian's Yama
  `ptrace_scope` restriction and macOS's SIP / hardened-runtime posture are in
  force. A host that relaxes them (`ptrace_scope=0`, SIP disabled) weakens
  in-memory authority toward file-equivalence.
- **Privileged runtimes.** `ptrace_scope` is ignored entirely for a caller
  holding `CAP_SYS_PTRACE`, which root ordinarily has. A deployment running pi
  as root — plausible for a containerized or systemd-service self-hosted
  install, exactly the shape the `debian-baseline` rule targets — voids the
  descendant restriction, letting a same-user *sibling* process attach freely.
  This is a distinct mechanism from the relaxed-default case above.
- **Absence of an `S_ISREG` guard on the file tools.** pi's `read`/`write`
  built-ins do not refuse special files. No memory primitive follows from this
  today, because both start at byte offset 0 and `read`'s offset/limit are line
  based, so `/proc/<pid>/mem` yields `EIO` rather than heap access. The design
  does not depend on that accident holding forever; a byte-seek addition upstream
  would change the analysis, and the missing guard is worth closing on its own
  merits.
- **Absence of a debugging entitlement on the vendored binary.** The macOS half
  of the argument holds only while the vendored pi binary carries no
  `com.apple.security.get-task-allow` or equivalent debugging entitlement. This
  is a *build-artifact* property, distinct from the code-signing identity
  discussed in option 1, and plausibly more likely to regress (a debug-entitled
  build added for troubleshooting) than an operator disabling SIP. #930 adds an
  entitlement assertion to the vendor validation script
  (`agent/vendor/validate-*-vendor.sh`) so a regression is caught mechanically
  rather than assumed away.
- **Absence of an inspector channel.** Bun exposes the WebKit Inspector Protocol
  over a local WebSocket when launched with `--inspect`/`--inspect-brk`/
  `--inspect-wait`, giving any same-user caller that reaches the port full heap
  access without any `ptrace`/`task_for_pid` involvement. Bun's documentation
  describes activation only via those startup flags, but the analogous Node.js
  runtime activates its inspector on `SIGUSR1` with no flag at all — a signal any
  same-user process can send — so "Bun has no signal-triggered toggle" is an
  assumption about a distinct JSC-based implementation rather than a verified
  property. #930 verifies it against the vendored binary alongside the
  entitlement assertion rather than leaving it asserted. Regardless, pi must
  never be launched with an inspector flag while holding an active grant, and
  that is an operational control, not something this design enforces.
- **Integrity of the broker's own code or the pi binary between runs.** Package
  source review, vendor pinning, and the repo's existing integrity machinery
  remain the controls.
- **A fully closed verify-then-exec window.** Materializing verified bytes to a
  path and spawning from it retains a narrow same-user TOCTOU window. It is
  bounded by reading into memory, verifying in memory, materializing into a
  freshly created `0700` directory, and spawning immediately — and it is
  documented rather than claimed closed (#930).
- **Authenticity of terminal input itself.** With no durable layer, the direct-TUI
  approval is the sole root of trust, and it inherits whatever the platform's
  terminal offers. Synthetic-keystroke injection into the controlling terminal
  (TIOCSTI-class, and equivalents on macOS) is out of this design's reach; the
  same exposure existed in the durable design, which was created by the same
  approval event, but it is now unbacked by any second checkpoint.
- **Confidentiality of grant contents against memory disclosure, including
  actively triggered disclosure.** Grant contents — the complete system prompt
  and tool provenance among them — may reach disk passively via swap,
  hibernation images, or core dumps on hosts without encrypted swap. They may
  also be disclosed *actively*: a same-UID process can signal the runtime
  (`SIGABRT`/`SIGQUIT`) to force a core dump, which is governed by ordinary
  UID-matching signal permissions and not by `ptrace_scope` at all. Where
  `systemd-coredump` is installed and active it routes dumps root-only, which
  mitigates this — but it is a separate package that minimal and headless server
  images (the ARM64 VPS shape the `debian-baseline` rule targets) may not carry,
  and the kernel's fallback `core_pattern` writes the dump into the crashing
  process's own working directory under its own UID, readable by exactly the
  attacker assumed here. macOS and non-default `core_pattern` configurations are
  likewise unmitigated. Nothing reads any of this back as
  authorization, so the authorization claim is unaffected; the confidentiality
  exposure is real.
- **Inherited descriptors.** Stdio and any other descriptors inherited by a
  spawned child are not a channel into the parent's private memory, but the
  child-side surface is #930's isolation work (ADR-0127 §6), not a property this
  section claims.
- **Availability of an approved grant.** Revocation is deliberately reachable
  outside direct TUI (ADR-0127 §4 permits it because it can only narrow
  authority), and this record additionally gives a pending revocation priority
  over queued dispatch waiters. Together those let an untrusted-provenance caller
  destroy a live grant at will, forcing a fresh TUI approval before the agent is
  usable again. That is a denial-of-service against availability, not against
  authenticity — narrowing authority is always the safe direction — but the
  preemption rule sharpens its practical effect, so it is named rather than left
  implicit.
- **When and with what inputs an approved agent runs.** Because dispatch is
  provenance-unrestricted by design, any caller — including a model turn shaped
  by untrusted content it read — can dispatch an already-approved agent at a
  time and with inputs the operator did not anticipate. Approval authorizes *an
  agent definition*, not each individual invocation of it. This is inherent to
  any post-approval dispatch architecture and orthogonal to the forgery/rollback
  problem this record solves, but it is a real residual and belongs in this
  list.

## Consequences

- **The operator approves once per runtime per agent**, and again after the
  absolute expiry elapses. This is the price, and it is visible. It is also
  arguably the correct semantics: an authorization that survives unattended
  across restarts is precisely what the threat model says cannot be protected.
- **Revocation is scoped to the issuing runtime.** Two concurrently running pi
  runtimes each hold their own independently approved grant, and revoking in one
  cannot reach the other — there is no shared durable authority through which to
  propagate it. The durable design's catalog epoch did provide that cross-process
  reach, so this is a real narrowing, disclosed rather than implied. It matters
  in this repo specifically, where multiple agent sessions routinely run
  concurrently. `/package-agent revoke` must state in its operator-facing output
  that it revokes only the current runtime, and #931 tests that wording.
- **Headless and RPC dispatch of package agents becomes impossible.** ADR-0127
  §6 permitted consuming existing exact grants headlessly after full
  revalidation; with no durable authority there is nothing for a headless
  runtime to consume, and no approval path exists there. This narrows ADR-0127
  and is consistent with its stated posture that headless automation is
  intentionally read-only in the initial design.
- **Approval receipts must not be used to reduce review friction.** A receipt is
  forgeable by the same attacker this record is written against, and the design
  now rests entirely on the operator's fresh review each runtime. This is stated
  structurally rather than as guidance: **the approval code path must not branch
  on receipt presence at all**, so no future UX change can "recognize a returning
  agent" and streamline the confirmation. Receipts are surfaced only in
  `/package-agent status`, labelled unverifiable, and never during an approval
  flow. #931 tests that the approval presentation is byte-identical with and
  without a receipt present.
- **#929 implements a runtime-scoped lifecycle**, not a durable authenticated
  store. The #916 state-store primitives (cross-process `O_EXCL` lock, atomic
  temp → fsync → rename → parent fsync, load-time integrity refusal) remain in
  use for the receipt and audit records, where their job is durability and
  operator-visible integrity rather than authority. The receipt carries **only
  digests and identifiers** — qualified identity, alias, proposal and grant
  digests, approval identifier, timestamps — and never raw grant content: no
  system prompt, descriptor body, wrapper bytes, tool implementation bytes, or
  environment-policy values. #916's `AuditEvent` schema already draws that line,
  and binding the receipt to it keeps the on-disk confidentiality surface no
  wider than the existing audit record. Receipts and active-grant audit events
  live in a **store root distinct from #916's review-draft state**, so the two
  components never contend on one `O_EXCL` lock; the digest-domain separation is
  required regardless, but separate roots keep the locking independent too.
  At most **32 qualified identities** may hold simultaneous active grants in one
  runtime (the review-draft store's `maxDrafts: 128` is the analogous bound);
  each requires its own operator approval, so the cap is a backstop rather than a
  practical limit, and #919 has a stated target to validate.
- **Collision refusal narrows to the runtime.** ADR-0127 §6's collision checks
  ran against a durable cross-runtime store; with grants held in memory they
  necessarily scope to the current runtime's own approvals. This is intended.
  #929 must not reintroduce a durable active-grant registry to widen it — that
  would restore the very artifact this decision removes. Protected-name and
  package-identity refusals are unaffected, since those are checked against
  static policy and discovered package content rather than against other
  runtimes' grants.
- **#919's aggregate validation must cover the runtime-scoped lifecycle**,
  including the property that a restarted or reloaded runtime holds no authority.
- **Option 2 remains available as later hardening.** Adding a
  presence-requiring signature over the approval receipt would raise the cost of
  forging *evidence*; it is not required to make dispatch safe under this
  decision, and adopting it would need its own ADR.
- **The ADR-0128 gate is satisfied**, so #928–#931 are unblocked. Any later
  change that widens what a grant authorizes, relaxes the approval ingress, or
  reintroduces durable authority invalidates this verdict and requires a fresh
  security review before it ships.

## Security Review Record

ADR-0128 requires this design to pass its own security review before any
activation capability ships. Four replicated rounds were run, three independent
`security-review-expert` invocations per round over identical briefs:

| Round | Verdict | Outcome |
| --- | --- | --- |
| 1 | 2× `NEEDS_CHANGES`, 1× `PASS_WITH_WARNINGS` | Cross-runtime revocation gap undisclosed; approval-time display-to-commit guard unspecified; §5/§6 reconciliation missing; dispatch invocation channel unspecified; "call frame" loophole |
| 2 | 3× `NEEDS_CHANGES` | The in-memory-vs-file argument rested on a false premise; the generation check was underspecified and would have been disabled in practice; the approval/dispatch rule was defeatable by "any subsequent input" |
| 3 | 2× `NEEDS_CHANGES`, 1× `PASS_WITH_WARNINGS` | `/proc/self/mem` and extension planting raised against the central claim; lock granularity, clock source, and privileged-runtime gaps |
| 4 | 3× `PASS_WITH_WARNINGS` | Gate satisfied. Every warning was fixed rather than deferred |

Round 3's challenge was resolved by testing both contested mechanisms against
pi's shipped code rather than re-arguing them; the result narrowed the central
claim (see "What Runtime-Scoped Authority Actually Buys") and is why this record
claims a window rather than a wall. In round 4 all three reviewers independently
re-verified the code citations against pi's source and confirmed them.

The verdict is scoped to the design as written here. It is not a verdict on any
implementation, each of which carries its own review obligation.
