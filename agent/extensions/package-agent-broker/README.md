# package-agent-broker — package-agent review and approval broker

First-party pi extension implementing #916 under [ADR-0128](../../../adrs/0128-stage-package-agent-authorization.md)
(which supersedes [ADR-0127](../../../adrs/0127-package-agent-consent-and-work-item-credential-boundary.md)
in part), extended by #928 under [ADR-0129](../../../adrs/0129-package-agent-active-grant-authenticity.md).

It runs two deliberately separate flows:

- **Review (#916)** — discovers installed pinned-Git packages' inert agent
  descriptors and persists **permanently non-authorizing review drafts**.
- **Approve (#928)** — reconstructs the **complete effective definition** from
  current state, takes a fresh direct-TUI approval over it, and installs a
  **runtime-scoped active grant**: an in-memory object that dies with the pi
  process. Nothing on disk grants authority.

The separation is the point. A draft says an operator *looked* at something.
A grant says an operator *authorized* something, and it exists only inside one
live runtime.

## What a review draft is — and is not

A draft records that the operator reviewed an exact, digest-bound snapshot of
a package-agent proposal. It is **inert evidence**:

```json
{
  "kind": "package-agent-review-draft",
  "activatable": false,
  "requiresFreshApproval": true,
  "authorizationDigest": null
}
```

- It cannot register or activate an agent, tool, prompt, skill, or command.
- It cannot be consumed, promoted, migrated, or upgraded by #917 — #917 must
  reject every record of this kind unconditionally as authorization evidence.
- It explicitly enumerates unresolved provenance (effective tool
  implementations, runner identity/content, argv policy, event-handler set,
  extension/module closure); that incompleteness keeps it non-authorizing.
- It is harmless if forged, replayed, expired, or rolled back, because it
  carries no authority. Activation requires #917's distinct active-grant
  schema, complete provenance reconstruction, a fresh direct-TUI approval,
  and #917's own passing security review.

## Operator commands (direct TUI input only)

The broker registers **no model-callable tool and no `registerCommand`
handler**. It intercepts exact raw input via `pi.on("input")`, which runs
after extension-command lookup and before skills/templates:

```text
/package-agent list
/package-agent inspect <qualified-id>
/package-agent status [qualified-id]
/package-agent review <qualified-id> [--alias <alias>]
/package-agent reject <qualified-id>
/package-agent revoke-draft <qualified-id>
/package-agent approve <qualified-id> [--alias <alias>]
/package-agent grants
/package-agent revoke <qualified-id>
```

Every command except `revoke` (which only narrows in-memory authority) requires all of:

```typescript
ctx.mode === "tui"
event.source === "interactive"
event.streamingBehavior === undefined
```

RPC, extension-injected (`sendUserMessage`), steer, and follow-up inputs are
refused. Matched input always returns `action: "handled"` — it never reaches
the model, skill expansion, prompt-template expansion, or another extension.
Unknown or malformed `/package-agent` input is handled and rejected rather
than passed onward. Qualified identity: `git:<host>/<path>@<ref>#<name>`
(strict printable ASCII; confusable lookalikes are not the exact token and
are therefore never ours).

## Review flow

1. **Inert discovery** — bounded data-only reads of installed user-scope
   pinned-Git packages' `agents/*.json` (+ optional sibling `<name>.md`
   wrapper). Never imports package modules, executes lifecycle scripts,
   spawns processes, touches the network, or registers resources; the test
   suite asserts this statically. Files are opened `O_NOFOLLOW` and
   fstat-verified regular within explicit size/count/total-byte bounds.
   Project-scope packages are out of scope (not operator-owned evidence).
2. **Immutable snapshot** — exact descriptor/wrapper/prompt bytes, requested
   tools, environment/model/guard/context policies, source evidence (byte
   counts + sha256), observed commit (evidence only), proposed alias, and the
   unresolved-provenance list. Digest: sha256 over a deterministic canonical
   encoding under the domain `pi-config/package-agent-review-draft/v1` —
   deliberately distinct from any future active-grant domain.
3. **Safe viewer** — hostile characters are visibly encoded (`⟦U+XXXX⟧`):
   C0/C1 controls and DEL, line/paragraph separators, the entire Unicode
   `Cf` format category (bidi embeddings/overrides/isolates, zero-width
   characters, soft hyphen, word joiner and invisible operators, the
   invisible Tag block U+E0000–E007F), BOM, variation selectors, the
   combining grapheme joiner, and combining-mark runs beyond two
   (anti-Zalgo bound; short runs render normally). Fields are delineated,
   byte counts/hashes/digest shown, paginated without omission. **Every**
   on-disk-derived string reaching the terminal passes through this encoder
   — the `list` and `status` notification paths included, not just the
   snapshot viewer.
4. **Untimed confirmation** — the operator must affirmatively acknowledge
   **every** page (declining any page, the last one included, aborts the
   review before the retype prompts are reached), then retypes the exact
   qualified id and the exact digest (byte-exact match, no trimming or case
   folding).
5. **Display-to-commit CAS** — under a cross-process lock: reload the state
   generation, re-read every source byte, rebuild the snapshot, and abort on
   any difference; then allocate the draft revision, 256-bit nonce, issue
   time, and 30-day expiry, and persist exactly the displayed candidate.

## Approval flow (#928)

`approve` is the only path that creates authority. It shares the review flow's
ingress gate, page-acknowledgement contract, and double-retype confirmation,
and adds complete provenance reconstruction on top.

1. **Complete reconstruction** — every ADR-0127 §5 field is resolved from
   current state, including the six a review draft explicitly cannot resolve:

   | Field | How it resolves |
   | --- | --- |
   | effective tool implementations | built-ins only, each bound to the runner digest (ADR-0127 §6) |
   | runner identity and content | the executable that will be spawned: symlink-resolved, `O_NOFOLLOW`-opened, fstat-verified, digested byte-for-byte |
   | argv policy | a broker-owned constant template, digested as data; placeholders resolve at dispatch from the grant itself, never from caller input |
   | extension closure | **empty by construction** — the child runs `--no-extensions` with no explicit `-e` |
   | event-handler set | empty, following from the above (handlers come from extensions) |
   | transitive module closure | empty, following from an empty extension closure |

   "Empty" is recorded as `mode: "none"` — a positive assertion, never an
   absent field, so it can never be read back as "not determined".
   Reconstruction has no partial success: an unresolvable field is a refusal.
   A grant additionally **requires** a resolved commit, where a draft tolerates
   `observedCommit: null`.

2. **Tool policy** — a package agent may be granted `find`, `grep`, `ls`, and
   `read`. `bash`, `write`, and `edit` are refused, and so is any name that is
   not a pi built-in. The reason is specific: the guard extensions that
   constrain those tools in a normal session (`secrets-guard`,
   `bash-destructive-guard`, `gh-identity-guard`) are themselves extensions, so
   the isolation that makes the closure empty would also leave a child running
   them **unguarded**. Lifting this needs an explicit content-addressed guard
   closure, not a list edit — and it must bump `GRANT_POLICY_VERSION`, which
   invalidates existing grants by digest.

   **The grantable set is confined at the OS boundary (#934, ADR-0130).**
   Refusing the mutating built-ins bounds what a package agent can *change*,
   not what it can *read*: pi's `read`/`grep`/`find`/`ls` run in-process on the
   host with full permissions and the isolation flags scope extensions, not the
   filesystem. #934 closes this — the grantable file built-ins are dispatchable
   only inside a verified per-child OS sandbox (see "Child filesystem
   confinement" below). Until #930 wires that sandbox into dispatch, no
   dispatch path exists, so nothing is reachable regardless.

3. **Display, then double retype** — the full definition renders through the
   same hostile-content-safe viewer, and the operator retypes the exact
   qualified id and the exact **grant** digest. Each approval attempt binds its
   own nonce, so a digest observed in one attempt cannot be replayed into
   another.

4. **Display-to-commit under the authority lock** — the definition is
   reconstructed a *second* time and its digest compared with the displayed
   one; any difference aborts. The operator approves the digest that becomes
   authoritative, or nothing is installed.

5. **Install, then record** — the grant enters the in-memory registry. Only
   *after* the authority lock is released does the broker write the
   non-authorizing receipt and audit event (ADR-0129's lock-ordering rule: the
   authority lock is never held while acquiring the cross-process store lock,
   so a revocation can never queue behind it). A receipt that cannot be written
   warns loudly and leaves the grant standing — a non-authorizing record must
   never destroy authority an operator granted in person.

### What a grant is

| Property | Value |
| --- | --- |
| Storage | in-memory only; never serialized as authorization |
| Digest domain | `pi-config/package-agent-active-grant/v1` (distinct from the review-draft domain) |
| Lifetime | 4 hours absolute from approval (operator-set, ADR-0129) |
| Cap | 32 simultaneous identities per runtime; **refuses** at the cap rather than evicting |
| Lock | per-qualified-identity in-process authority lock, with a preemptive queue for #929's revocation |
| Death | process exit and `/reload` are complete revocations |

Re-approving the same identity atomically retires the prior grant, so exactly
one grant is ever resolvable per identity. Approving a **different ref** of the
same package agent is a distinct identity that would not retire the older
grant, so it is refused as a package-identity collision until that grant is
revoked.

### Lifecycle and dispatch boundary

`approve` creates authority; it does not dispatch, and it never offers, arms,
schedules, registers, enables, or pre-authorizes a dispatch. `revoke` removes
only the named grant in the **current runtime** and accepts any input provenance
because it can only narrow authority; it never prompts or creates a grant.
Revocation also cancels every **queued** dispatch-admission request for its
identity before taking the preemptive authority lock; already-promoted attempts
are the "child created before revocation" case ADR-0129 permits, and they are
stopped by the #930 dispatch-time revalidation finding no grant.

Expiry uses a suspend-inclusive monotonic clock: Linux resolves the kernel's
`/proc/uptime`; Darwin resolves `mach_continuous_time` through the Bun runtime
FFI. A failed resolution is explicitly unverified, and the #930 dispatch path
refuses such a grant outright (`clock-unverified`). #929 supplied the
lifecycle controls, #934 the filesystem confinement, and #930 the dispatch
flow below.

### Child filesystem confinement (#934, ADR-0130)

pi's file built-ins run in-process with the operator's full permissions and
pi ships no path scoping by design, so the grantable `read`/`grep`/`find`/`ls`
are dispatchable **only inside a verified OS-level per-child sandbox**:
unprivileged `bwrap` (`--unshare-all --share-net`) on Linux, a deny-default
`sandbox-exec` (Seatbelt) profile on macOS. The sandbox confines the child's
whole process tree — including the `rg`/`fd` subprocesses `grep`/`find`
spawn — to the package install root (read-only) plus a scratch dir, with
outbound network kept open for the model provider. `~/.pi/agent` (auth.json,
sessions, settings, extensions) is never visible even though the package root
nests under it; `PI_OFFLINE=1` plus pre-provisioned `rg`/`fd` forbid runtime
tool downloads; the child environment is a closed allowlist built by the
broker (`HOME`/`TMPDIR`/`PI_CODING_AGENT_DIR` inside scratch; target
credential is a short-lived `ANTHROPIC_AUTH_TOKEN` bearer minted at dispatch
once the pi snapshot reaches ≥ v0.83.0).

`lib/child-sandbox.ts` holds the **pure builders** (SBPL profile, bwrap fd
payload, env allowlist, canary plan); every OS process the broker creates
lives behind exactly one module, `lib/dispatch-runner.ts` (the static scan
pins that boundary). The dispatcher runs the canary plan through the
identical wrapper before every dispatch: out-of-scope reads (every sensitive
agent subpath and the masked package `.git`) must fail, the in-scope read
must succeed, writes must land only in scratch. Any anomaly — mechanism
missing, canary read succeeding — refuses dispatch of any grant holding a
file built-in; unconfined file-tool dispatch is never a fallback. Paths in
the spec must be canonical (realpath'd); a non-canonical package root fails
the must-succeed canary and refuses dispatch rather than silently
mis-scoping. The package's **top-level `.git` is masked** (bwrap `--tmpfs`,
trailing SBPL denies) and the full-tree grant digest excludes exactly that
path, keeping digest coverage byte-aligned with what the child can read
(ADR-0131 D1–D2). These policy changes are why `GRANT_POLICY_VERSION` moved
to 2 (#934) and then 3 (#930).

### Dispatch admission (#929)

`lib/dispatch-admission.ts` is the runtime-local resource-containment seam
ADR-0129 requires because dispatch is model-reachable. It is **not**
authorization — it never reads a grant and never substitutes for dispatch-time
digest revalidation. Every dispatch attempt (either ingress) passes through
admission first and releases its ticket however the attempt ends.

Limits (implementation parameters under ADR-0129, fixed on #929, 2026-07-29 —
materially raising or removing any needs renewed security review): **4**
concurrently active callbacks; **16** queued requests globally, at most **4**
per qualified identity; **12** promoted starts per exact rolling **60 s**;
**60 s** maximum queue age. Retries, parallel items, and chain steps are
independent requests; a promoted attempt consumes a rate-window start even if
the dispatch later fails revalidation or spawn. Revocation and re-approval
bypass admission entirely — they ride the preemptive authority-lock path and
never queue behind model-driven dispatch traffic.

### Dispatch flow (#930, ADR-0131)

Two ingresses route into one transaction (`lib/dispatch.ts`): the TUI
subcommand `dispatch <id> -- <task>` and the single static model-callable
`package_agent_dispatch` tool — the only tool the broker ever registers, and
deliberately provenance-unrestricted per ADR-0129: a request carries
`{qualifiedId, task}` and nothing authoritative, cannot create/widen/revive a
grant, and an unknown/expired/revoked identity fails closed with **no
prompt**. The transaction: validate the request → admission → run the full
canary through the byte-identical wrapper OUTSIDE the authority lock on a
throwaway scratch (the probe is the child binary acting as plain bun via
`BUN_BE_BUN`, which the real child's env refuses twice over) → mint the
short-lived bearer (`pi auth print-bearer-token`; a mint failure refuses —
bearer-only, no API-key fallback) → under the per-identity authority lock
with a **5 s bounded hold**: retire expiry, refuse an unverified expiry
clock, re-run discovery and full reconstruction with the approval binding
and runner path anchored to the in-memory grant (runner bytes re-digested;
a swapped binary fails the match), require an exact grant-digest match,
attest the argv (every isolation flag, the exact `--tools` list, no
placeholders), and spawn synchronously with the PID captured before anything
is awaited → after lock release: await the child under a 10-minute execution
timeout with stdout caps that terminate rather than truncate, tear down the
per-attempt `0700` scratch, flush the closed-schema audit events
(`dispatch-admission-refused` / `dispatch-request-cancelled` /
`dispatch-refused` / `dispatch-spawned` / `dispatch-completed`), and release
the admission ticket. The task rides the child's **stdin**, never argv; on
Linux the bwrap `--setenv` payload (credential included) rides an in-memory
fd-3 pipe, never argv and never a file. Child stdout is untrusted output:
the TUI path visible-encodes and caps it; the tool path returns it to the
model as ordinary untrusted tool output. Startup attestation is scoped to
what is verifiable at the current pi pin (argv/env/closure; OS confinement
as the compensating control) — the upstream enumeration ask is #944, and
`environmentPolicy` injection is deliberately absent pending #945.

## State and audit

State root (operator-owned, outside projects and packages):

```text
${XDG_STATE_HOME:-~/.local/state}/pi/package-agent-broker/
```

`0700` directory, `0600` files, ownership/type/no-follow verified on every
load; one authoritative `state.json` image (drafts, per-proposal revisions,
state generation, audit) written via `O_EXCL` temp file → fsync → atomic
rename → parent fsync. Locks use bounded acquisition with conservative
stale-lock refusal (never auto-stolen). A load that finds a draft violating
the non-authorizing contract (`activatable` flipped, an authorization digest
present) refuses the whole image.

Audit events are a closed positive-allowlist schema (kind, UTC timestamp,
qualified identity, safe source/commit identifiers, proposal digest, draft
revision, state generation, expiry, outcome, fixed reason code). Raw paths,
package bytes, prompts, descriptor bodies, environment values, exception
strings, and retype input structurally cannot enter audit serialization.

Per-file discovery skips (`descriptor invalid`, unsafe file) are deliberately
**not** audited — they are continue-eligible outcomes shown in the UI skip
list, and auditing every malformed file would let package content drive
unbounded audit growth. Systemic refusals and decision points are audited.
If an audit record cannot be written (e.g. the mutation lock is held), the
refusal still stands and the operator gets an explicit warning that the audit
trail is incomplete for that event — audit loss is never silent.

Grant lifecycle transitions are audited under their own closed kinds (#929):
`grant-revoked` (operator revocation), `grant-expired` (expiry retirement,
recorded outside every authority lock when a command's registry reads observe
it), and `grant-shutdown-invalidated` (best-effort at `session_shutdown` —
the one deliberate exception to the loud-warning rule, since no UI remains to
warn and the transition is already implied by the runtime ending). Revocation
and expiry additionally stamp a `terminal` field on the matching persisted
receipt — guarded by runtime-instance id **and** approval sequence, so
evidence from one approval can never mislabel a later one. Receipts remain
non-authorizing throughout; the dispatch path reads no file.

## Refusal policy (per-rule)

| Rule | Classification | Rationale |
| --- | --- | --- |
| Non-TUI / non-interactive / streaming input | **Hard refusal** | Only direct operator TUI input can record review evidence (ADR-0127 option 5/6 rejections carry forward) |
| Malformed or unknown `/package-agent` input | **Hard refusal** (handled, never passed onward) | Prevents skill/template/model re-interpretation of broker-shaped input |
| Source bytes changed between display and commit | **Hard refusal** | The operator reviewed exact bytes; any drift voids the review (TOCTOU) |
| Identity/digest retype mismatch | **Hard refusal** | Untimed deliberate confirmation is the consent mechanism |
| Package identity: an active grant exists for the same package agent at another ref | **Hard refusal** | Two coexisting grants for what an operator reads as one agent; revoke the older one first (ADR-0127 §6, ADR-0129) |
| Tool not a grantable built-in, or a mutating built-in (`bash`/`write`/`edit`) | **Hard refusal** of the whole approval | Never a silently narrowed allowlist — the operator must approve what the child actually gets |
| Package revision unresolvable at approval | **Hard refusal** | A grant binds a resolved immutable revision; a draft does not |
| Runner unresolvable, non-regular, empty, or changed mid-read | **Hard refusal** | The grant binds the bytes that will execute |
| Active-grant cap reached (32) | **Hard refusal** | Evicting would silently destroy in-person-granted authority |
| Collision (protected name, duplicate, case-fold, alias) | **Hard refusal** | Collisions are refused, never resolved by load order. `PROTECTED_NAMES` in `lib/collisions.ts` is a **doc-sync pair with `agent/agents/`** — adding a first-party agent wrapper requires a matching entry there |
| State integrity violation (symlink, perms, ownership, corrupt, contract) | **Hard refusal** (fail closed) | Broker state must be operator-owned and intact |
| Lock unavailable / stale | **Hard refusal** with manual guidance | Conservative: never steal a lock |
| Global discovery byte budget exhausted (`total-budget-exceeded`) | **Hard refusal** of the whole pass | Bounded reads are part of the inertness claim; git-metadata reads are charged to the same budget and read once per package |
| Per-file invalid descriptor / oversized file / unsafe file | **Continue-eligible** (skipped with bounded reason) | One bad file must not block reviewing others |

## Override mechanisms

None. There is deliberately no `SKIP_*` env var, no allowlist file, and no
non-interactive path: every affirmative action is an explicit operator
keystroke sequence in the TUI, and the records produced carry no authority to
need overriding. (Removing a draft is itself a command: `revoke-draft`.)

## Files

- `index.ts` — input wiring, command dispatch, review flow, TUI dialogs.
- `lib/input-router.ts` — exact raw-input parsing (pure).
- `lib/strict-json.ts` — duplicate-key-rejecting bounded JSON parser (pure).
- `lib/descriptor.ts` — versioned strict descriptor schema (pure).
- `lib/discovery.ts` — bounded data-only package reads.
- `lib/collisions.ts` — protected-name/duplicate/alias refusal (pure).
- `lib/review-snapshot.ts` — snapshot build + canonical digest (pure).
- `lib/viewer.ts` — hostile-content-safe paginated rendering (pure).
- `lib/state-store.ts` — locked, CAS, atomic, fail-closed persistence.
- `lib/audit.ts` — closed-schema audit event constructors (pure).
- `lib/builtin-tools.ts` — the reviewed grantable/refused built-in tool policy (pure).
- `lib/reconstruct.ts` — complete provenance reconstruction + grant digest (#928).
- `lib/grant-registry.ts` — in-memory grant registry, per-identity authority lock, monotonic clock seam (#928); expiry-retirement drain and close-evidence return (#929).
- `lib/suspend-inclusive-clock.ts` — verified suspend-inclusive expiry clock resolution, fail-visible (#929).
- `lib/dispatch-admission.ts` — runtime-local dispatch-admission seam: concurrency, queue, and rolling-rate bounds (#929).
- `lib/lifecycle-evidence.ts` — persisted lifecycle audit events + receipt terminal stamps, post-authority-lock (#929).
- `lib/child-sandbox.ts` — pure child-confinement builders: deny-default SBPL profile, bwrap argv, env allowlist, canary plan (#934, ADR-0130).
- Shared: [`../shared/package-agent-review-contract.ts`](../shared/README.md)
  (draft record shapes, bounds, identities, state image),
  [`../shared/package-agent-grant-contract.ts`](../shared/README.md)
  (grant shapes, bounds, the ADR-0127 §5 digest-field enumeration), and
  [`../shared/package-agent-canonical.ts`](../shared/README.md)
  (domain-separated canonical encoding, reused under both domains).

## Tests

`scripts/test-package-agent-broker.sh` runs nineteen suites (input-router,
descriptor, canonical, discovery, review-snapshot, viewer, collisions,
state-store, index-flow, grant-digest, reconstruct, grant-registry,
approve-flow, suspend-inclusive-clock, dispatch-admission,
lifecycle-evidence, child-sandbox, dispatch, dispatch-runner) covering: RPC/extension/steer/follow-up refusal;
confusable, whitespace, ANSI/bidi/control, and oversized input; zero
import/spawn/network/registration (static source assertion); duplicate keys
and malformed schemas; every canonical field mutation changing the digest;
symlink swaps; generation-CAS conflicts; crash injection at persistence
boundaries; stale locks; expiry; rollback; and the load-time refusal of any
draft violating the non-authorizing contract.

`index-flow.test.ts` is the integration suite over `index.ts` itself — the
gate and orchestration layer. It drives the real handler through a fake
`ExtensionAPI`/`ExtensionContext` against a temp agent dir and state root,
and pins the behaviors a unit test cannot see: every non-interactive
provenance combination is refused for every command; declining any page
(including the last) aborts on the decline rather than falling through to
the retype prompts; a hostile on-disk file name cannot inject escapes via
`/package-agent list`; a fully confirmed review records exactly one inert
draft; and the factory registers no command or agent and exactly ONE tool — the
static dispatch ingress — before and after a full command sweep.

The #928 suites add: a mutator table whose key set must equal the ADR-0127 §5
field enumeration exactly, so a digest field cannot be added without proving it
is bound; digest-domain separation observed end to end; every refusal pinned to
its audit reason code; the authority lock's serialization, per-identity
independence, and preemptive queue; the cap refusing rather than evicting; and
an adversarial `approve-flow` suite proving that a forged draft or receipt
refuses the state load outright, that a *legitimate* draft shortens nothing
(same pages, same prompts, same content bindings), that a digest cannot be
replayed across attempts, that authority does not survive into a new runtime,
and that no grant object is ever serialized to disk.

The #934 `child-sandbox` suite is adversarial in the ADR-0130 sense: beyond
byte-level profile/argv/env assertions (deny-default-first, agent dir never
exposed, closed env allowlist), it spawns real sandboxed processes through
the built artifacts on the running platform and proves an out-of-scope read
fails (auth.json included) while in-scope reads and scratch writes succeed —
and on hosts where the OS mechanism is unavailable it asserts the
unavailability is correctly classified (the refuse-dispatch signal), never
silently skipped.

The #929 suites add: fully clock-injected admission coverage (all four limits,
exact rolling-window promotion, queue aging, FIFO order, no-refund starts,
identity-scoped cancellation leaving other identities and already-promoted
attempts untouched, close semantics); expiry retirements draining exactly once
and `close` returning evidence-only cleared grants; lifecycle audit events
pinned to their kinds and reason codes; the approval-identity guard on receipt
terminal stamps (a stale observation never mislabels a newer approval, and a
re-approval after revocation carries no inherited stamp); whole-batch
validation before any write; and the loud-vs-swallowed store-failure contract
split between the command and shutdown paths.

The #930 suites add: the dispatch transaction driven end to end with a fake
runner (revalidation ordering, the full-tree digest catching post-approval
package edits, `clock-unverified` and `credential-unavailable` refusals,
malformed-request legs, the bounded authority hold refusing with zero spawns,
and the #929 hand-off interaction test — a promoted admission ticket whose
grant is revoked mid-flight is refused by in-lock revalidation with its
ticket still released); live spawn-boundary coverage (real canary runs
through the identical wrapper with the vendored binary, including a
sabotaged plan that must surface as an anomaly; stdin task delivery;
execution-timeout termination; canonical `0700` scratch lifecycle with a
parent-guarded remover); the structural `BUN_BE_BUN` double-refusal; bearer
minting that classifies every failure as null; and the SIGUSR1
inspector-channel verification ADR-0129 assigned to #930.
