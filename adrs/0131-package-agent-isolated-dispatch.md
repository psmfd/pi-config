---
status: Accepted
date: 2026-07-31
---

# ADR-0131: package-agent isolated child dispatch mechanics

**Status:** Accepted — the operator approved each decision below on 2026-07-31
as part of the #930 implementation plan. The ADR-0128 activation gate was
satisfied by [ADR-0129](0129-package-agent-active-grant-authenticity.md)'s
design review; per that record's own scoping ("not a verdict on any
implementation"), the #930 implementation carries its own replicated
`security-review-expert` obligation, which gates the final dispatch PR — not
this record.
**Related:** [ADR-0129](0129-package-agent-active-grant-authenticity.md) (the
authority model dispatch consumes), [ADR-0130](0130-package-agent-child-filesystem-confinement.md)
(the confinement builders dispatch wires), [ADR-0127](0127-package-agent-consent-and-work-item-credential-boundary.md) §6,
#930 (this implementation),
#917 (sub-epic),
#944 (upstream attestation
primitive), #945
(environmentPolicy merge design), #946
(macOS orphan cleanup)

## Context and Problem Statement

Issue #930 wires the dispatch path: full-payload revalidation under the
authority lock, spawn through the ADR-0130 sandbox, startup attestation, and
the audit ingress deferred by #929. Implementation planning surfaced five questions the
prior records left open or answered on premises that verification against the
shipped pi binary falsified. Each is resolved here so the implementation
follows a reviewed decision rather than making it in-line.

## Decision 1 — the asset-tree digest widens to the full package tree

`computeAssetTreeDigest` (#928) hashed only the descriptor and wrapper, on the
stated premise that "no other file in the package can influence the child's
behaviour." ADR-0130 falsified that premise: the sandbox binds the **entire
package install root** read-only, and a `read`/`grep`/`find`/`ls`-granted
child can read (and, with outbound network open, transmit) every file under
it. `reconstruct.ts`'s own coupling rule — "if #930 ever widens what the
child reads from the package, this digest MUST widen with it" — was already
triggered by ADR-0130. Two independent reviewers flagged this during #930
planning.

**Options considered:**

1. **Widen the digest to the confined tree (chosen).** The digest walks every
   entry under the package install root except the masked top-level `.git`
   (Decision 2): regular files are content-hashed; symlinks are recorded as
   entries carrying their literal target string and are **not followed**; any
   other file type refuses reconstruction. Ordering is a deterministic
   relPath sort; the walk is bounded (`maxAssetFiles`, `maxAssetTreeBytes`)
   and refuses on overflow. Package churn between approval and dispatch now
   correctly fails the dispatch-time digest match — a changed package is a
   package the operator has not approved.
2. **Restrict the bind to descriptor+wrapper paths.** Rejected: `grep`/`find`
   need a directory root to be useful, and per-file binds would make the
   grantable tools vacuous.
3. **Accept and disclose the gap.** Rejected: unlike the TOCTOU residual,
   this gap is closable at reconstruction cost only, and the coupling rule in
   the code already promised the widening.

`GRANT_POLICY_VERSION` bumps 2 → 3: the digest's meaning changes, and
existing in-memory grants are invalidated by digest — the intended effect.
This is a strict tightening (a grant now covers strictly more of what reaches
the child), so ADR-0129's security-review verdict is undisturbed by its own
invalidation criteria (nothing widens, no ingress relaxes, no durable
authority appears).

## Decision 2 — the sandbox masks the package's top-level `.git`

The package install root is a git clone, so binding it wholesale exposes
`.git` — the full object store and history — to the child. No granted tool
needs VCS internals, and hashing `.git` into the widened digest would bind
grants to repository metadata churn.

**Chosen:** mask `<packageRoot>/.git` at the OS boundary — `--tmpfs` over the
subpath on Linux, a trailing `deny file-read*`/`file-read-metadata` subpath
rule on macOS (SBPL later-rule-wins semantics, verified by the canary) — and
exclude exactly the top-level `.git` from the digest walk, so the digest
covers precisely the bytes the child can read. A nested directory named
`.git` deeper in the tree is **not** masked and **is** digested; the mask and
the walk exclusion match byte-for-byte by construction. The canary plan gains
`<packageRoot>/.git/config` as a must-fail read so the mask is empirically
verified before every dispatch, per ADR-0130's probe-not-assume rule.
`resolvedCommit` remains in the digest, so revision identity is still bound
without exposing the object store.

## Decision 3 — startup attestation is scoped to what is verifiable

ADR-0127 §6 requires the child to "attest at startup that its effective tools
and event-handler set exactly match the grant before any model turn."
Verified against the vendored binary (v0.83.0 line, checked at 0.81.1 and
cross-checked against release notes): **no primitive exists for this.** The
`--mode json` stream's only startup record is the `session` header — no tool
or extension enumeration field; `tool_call`/`tool_result` are extension-side
events that never leave the child process; no `--list-tools` flag exists; and
`--tools` **silently ignores unknown names** rather than rejecting them. RPC
`get_state` carries no tool set either.

**Options considered:**

1. **Trust the argv flags alone.** Rejected as a *claim* — asking is not
   verifying, and this arc's discipline is verifying mechanism against
   shipped code.
2. **Probe with a no-op model turn and observe tool events.** Rejected:
   tool-execution events fire only for tools the model happens to invoke —
   zero evidence of an ungranted tool's absence — and the probe either delays
   or is indistinguishable from the real turn.
3. **Ask the child's model to self-report.** Rejected: an LLM claim about its
   own context is precisely the trust class this arc refuses.
4. **Attest what the broker controls and verify what the kernel enforces
   (chosen).** The broker attests, fail-closed, before any model turn: (a)
   the spawned argv is byte-derived from the grant's own `argvPolicy` — every
   `CHILD_ISOLATION_FLAGS` entry present, `--tools` exactly the grant's
   list, placeholders resolved from the grant and nothing else; (b) the child
   environment is exactly the closed allowlist; (c) the extension closure is
   empty by construction (`--no-extensions`, no `-e`), so the event-handler
   set is empty; and (d) filesystem confinement is canary-verified through
   the identical wrapper. OS confinement (ADR-0130) is the named
   **compensating control**: it bounds the blast radius of the unverifiable
   claim (a hypothetical extra tool still cannot read outside the package
   root or write outside scratch).

The gap between this and ADR-0127 §6's literal wording is disclosed here
rather than papered over. The upstream ask that would close it — a startup
enumeration of effective tools/extensions in JSON mode, or strict `--tools`
validation — is filed as #944.
When it lands, child-stream-reported attestation can be added *on top of*
the broker-side attestation (upgrading "asked" to "child-runtime-reported" —
still not kernel-verified, and the stream stays untrusted for every other
purpose per Decision 7).

## Decision 4 — canary execution through the byte-identical wrapper

ADR-0130 requires the full canary plan to run "through the identical wrapper"
before every dispatch, with a completed TLS handshake as the egress probe. The
production sandbox exec-allows only the child binary and `toolBinDir`
(`rg`/`fd`) — none of which is a general-purpose probe.

**Chosen (primary):** execute the probe as the child binary itself with
`BUN_BE_BUN=1` — pi is a Bun single-file executable, and Bun's compiled
binaries act as the plain `bun` runtime under that variable — running a
broker-authored probe script (materialized into the canary scratch dir) that
performs the must-fail/must-succeed reads and writes and the real TLS
handshake (`Bun.connect` + TLS session establishment against the provider
host). The profile, binds, and env shape are byte-identical to the real
spawn; only the argv after `--` and the `BUN_BE_BUN` variable differ, and
`BUN_BE_BUN` is asserted absent from the real child's environment.

- The mechanism is verified as implementation step 1 against the vendored
  binary; if it does not hold, the **fallback** is a canary profile that is
  the real profile plus minimally-additive probe-binary allowances, with the
  delta enumerated in the profile builder and its README — never a weaker
  probe set.
- Fail posture is ADR-0130's: any anomaly, including `BUN_BE_BUN`
  unexpectedly not working, refuses dispatch of file-tool grants. There is no
  unconfined fallback.
- `BUN_BE_BUN` inside the sandbox does mean "exec allowlist = child binary"
  is weaker than it reads — the child binary can run arbitrary scripts *if
  handed that env var*. This is inert for the real child: its env is the
  closed allowlist (no `BUN_BE_BUN`), and its granted tool set
  (`read`/`grep`/`find`/`ls`, no `bash`) exposes no primitive to spawn
  anything with a chosen environment. Recorded so the asymmetry is not
  silently inherited by a future tool-set widening, which must revisit this
  alongside ADR-0130's exec-surface note.

## Decision 5 — credential: short-lived bearer, sequenced behind the pi bump

ADR-0130's target mechanism (broker-minted short-lived bearer via
`pi auth print-bearer-token`, passed as `ANTHROPIC_AUTH_TOKEN`) requires
pi ≥ 0.83.0; the vendored pin was 0.81.1 at planning time, and the fallback
(the operator's long-lived `ANTHROPIC_API_KEY` in the child env, same-UID
visible per the disclosed non-goal) was assessed as a material regression
from the approved design. **Chosen:** the snapshot bump to v0.83.0 lands
*before* dispatch ships, exactly as ADR-0130 sequenced; #930 implements the
bearer path only, with no API-key fallback branch. Credential hygiene rules
carried from ADR-0130 and the hand-offs: delivery via bwrap `--args <fd>`
pipe only (never argv, never a temp file — the builders' raw argv is made
un-spreadable so a refactor cannot reintroduce the leak); the minting call
itself must not place the token in the broker's own argv where avoidable and
must never log it; the token never appears in audit records, receipts, error
text, or operator display.

## Decision 6 — the spawn boundary is one named module, statically enforced

The broker's standing invariant — "never spawns processes, adversarially
tested" — is enforced by a source scan over every `lib/*.ts` file
(`test/discovery.test.ts`), and `index.ts` itself is asserted by comment
only. #930 necessarily introduces spawn-capable code.

**Chosen:** all process creation lives in exactly one module,
`lib/dispatch-runner.ts`. The static scan gains a single-file allowlist
naming it (with the permitted APIs), keeps the blanket ban for every other
`lib/` file, and is **extended to scan `index.ts`** — closing the untested
gap. The module header states the boundary; `index.ts`'s header claim is
rewritten to name the carve-out precisely. Orchestration
(`lib/dispatch.ts`) stays spawn-free and pure enough to unit-test the full
transaction with a fake runner.

## Decision 7 — dispatch ingress, inputs, and output handling

Per ADR-0129, dispatch is provenance-unrestricted and fails closed with no
prompt. **Chosen ingress:** a `/package-agent dispatch <id>` TUI subcommand
and a model-callable `package_agent_dispatch` tool, both routing into the
same transaction. The request schema is `{qualifiedId, task}` and nothing
else — no grant content, digest, payload, or path may be accepted, per
ADR-0129's dispatch-request restriction; `task` is work input, not
authorization input.

This deliberately revises two standing statements, and says so rather than
contradicting them silently. ADR-0129's "no tool is added" sentence sits in
its approval/dispatch-separation argument: it rejects *approval-frame*
registration — an approval must not wire the package agent into pi's
catalogs or change the routing surface in the approving call frame. The
dispatch tool does neither: it is a **single, static, broker-owned tool
registered at extension load**, exists identically whether zero or many
grants do, never represents any package agent, cannot create, widen, or
revive a grant, and cannot cause an approval prompt (a request naming an
unknown identity fails closed) — it is the concrete form of ADR-0129's
"dispatch stays an explicit, separately invoked broker operation" for the
model-reachable path that same record requires rate-bounding for. The
broker header's tested "never registers a tool" invariant narrows
accordingly: never an agent, prompt, skill, theme, or command, and never
any tool *other than* this one dispatch ingress; the adversarial test is
updated to pin exactly that. The task text is delivered on the child's **stdin**,
never argv (child argv is world-readable on default Linux via
`/proc/<pid>/cmdline`; the system prompt, which *is* operator-reviewed
package content, rides argv per the digest-bound template — a disclosed
confidentiality trade consistent with ADR-0129's grant-content
confidentiality non-goals). Child stdout is parsed as the JSON event stream
with per-line and total byte caps; **no child-emitted content is ever an
authorization or attestation input**, and any child-sourced text shown to
the operator is routed through the existing hostile-text encoding in
`lib/viewer.ts`. The child runs under a dispatch execution timeout
(distinct from the 5-second authority-lock bound, which covers only
revalidation-through-spawn); expiry of the execution timeout terminates the
child best-effort and audits the outcome.

## Decision 8 — environmentPolicy is not injected in this version

`EffectiveDefinition.environmentPolicy` (descriptor-declared env vars) is
digest-bound and operator-reviewed but reaches no child: the child
environment is exactly the ADR-0130 closed allowlist plus the credential.
This trivially satisfies the #928 hand-off that work-item token values and
token-file pointers never reach the child regardless of wrapper requests. The
merge design — reserved-key refusal for wrapper vars, credential-collision
refusal, token-shaped-name stripping, adversarial tests — is
#945's scope and is
security-review-gated there. Until it lands, a wrapper that declares
`environment` entries gets a child that runs without them; the descriptor
field remains reviewable evidence of intent.

## Decision 9 — verify-then-exec residual, stated

The closable parts are closed and tested: per-attempt high-entropy scratch
created `0700` under a broker-owned parent; snapshot bytes materialized from
verified memory with `O_EXCL`, re-hashed via the open fd, `fsync`ed (file
and parent); the spawn call issued with **no intervening `await`** between
the in-lock digest match and process creation; PID captured from the
synchronous spawn return before any wait; canary scratch disjoint from the
real scratch; concurrent dispatches of one identity get disjoint scratch
trees. What remains open is structural: bwrap binds and Seatbelt subpath
rules consume **paths at spawn time**, not the broker's verified file
descriptors, so a same-UID actor can swap bytes between the digest match and
the mount taking effect. The honest claim, unchanged from ADR-0129: the
window is *bounded* to that synchronous span, not closed. Closing it needs
fd-based exec through the whole chain, which does not compose with the
chosen mechanisms and lands in ADR-0129's rejected option-5 territory.

## Decision 10 — vendor-binary assertions land with dispatch

Two ADR-0129 obligations assigned to #930, with one correction: ADR-0129
cites `agent/vendor/validate-*-vendor.sh`, but `scripts/validate-pi-vendor.sh`
is metadata-only and never touches the binary; the extracted binary exists
only after `scripts/lib/fetch-pi-binary.sh` runs. **Chosen placement:** the
darwin entitlement assertion (`codesign -d --entitlements` must show no
`com.apple.security.get-task-allow`) runs in `fetch-pi-binary.sh`
immediately after the atomic extract-and-swap, gated on the already-computed
platform triple; the Bun inspector check (no inspector activation on
`SIGUSR1`) is a live test in the broker suite where the vendored binary is
available. Both fail closed. **Verified 2026-07-31** against
`v0.81.1-psmfd.1`: the binary carries no entitlements (unsigned build — the
assertion targets a debug-ENTITLED regression, and an unsigned binary has
none), and SIGUSR1 takes the default terminate disposition with no inspector
announcement — Bun installs no signal handler, unlike Node. The live test
re-verifies both properties against every future pin.

## Implementation Security Review Record

ADR-0129 scopes its own verdict to the design ("not a verdict on any
implementation, each of which carries its own review obligation"), and
sub-epic #917's hand-off requires this issue to carry a replicated review. Three
independent `security-review-expert` invocations over identical briefs
reviewed the complete change set on 2026-07-31:

| Reviewer | Verdict | Principal findings |
| --- | --- | --- |
| 1 | `PASS_WITH_WARNINGS` | Single late hold-budget check; stdout caps measured in string units; approval display bound the widened tree but showed only its digest |
| 2 | `PASS_WITH_WARNINGS` | Stdout cap checked after append with no settled-guard during the SIGTERM grace window; the vendored-binary live tests passed trivially when the binary was absent |
| 3 | `NEEDS_CHANGES` | Untrusted child stdout reached the operator's terminal unencoded on the model-tool ingress; audit-write failures silent on that same ingress; unsigned-binary entitlement reasoning unverified |

Majority verdict is `PASS_WITH_WARNINGS`; consistent with this arc's
precedent, **every** finding was fixed rather than deferred, and each fix
carries a regression test:

- child stdout is `visibleEncode`d and capped on **both** ingresses (the
  hostile-text rule has no ingress exemption);
- audit-write failures surface on the tool ingress too (folded into the
  returned summary, since that path has no `ctx`);
- stdout caps are byte-accurate, checked **before** retention, and stop
  retaining once settled;
- the hold budget is re-checked between in-lock stages (still cooperative —
  the walk itself is bounded by `maxAssetFiles`/`maxAssetTreeBytes`);
- `attestArgv` compares byte-identically against a fresh resolution of the
  grant's template (stronger than the substring check, and immune to a
  legitimate prompt containing literal `{{`);
- the approval pages enumerate every asset-tree entry the digest binds, so
  displayed review covers bound scope;
- a worktree-style (non-directory) top-level `.git` is refused explicitly
  rather than failing opportunistically at spawn;
- the dispatch tool's parameter schema is closed (`additionalProperties:
  false`);
- the vendored-binary live tests (canary + SIGUSR1) now **fail** when the
  binary is absent instead of passing trivially — the repo contract hydrates
  it, and a missing binary is a broken environment, not a skip;
- `toolBinDir: null` is documented as a deliberate non-provisioning choice.

One finding is recorded as a **residual, not fixed**: reviewer 3 noted that
the darwin entitlement assertion treats an unsigned binary as satisfying
"no `get-task-allow`", and that public first-party documentation does not
establish that a fully unsigned binary receives the same same-UID
`task_for_pid` denial a signed-without-the-entitlement one does. The
assertion targets the regression it was assigned (a debug-entitled build)
and fails closed on a probe error, but the broader "unsigned ⇒ not
attachable" step is unverified. Empirically testing it is tracked as
#950 rather than asserted
here — ADR-0129 already lists platform debugging posture among its explicit
non-guarantees.

## Consequences

- PR 1 of the #930 arc ships this record, the audit-schema extensions
  (`dispatch-admission-refused`, `dispatch-request-cancelled`,
  `dispatch-refused`, `dispatch-spawned`, `dispatch-completed`, with their
  reason codes), `GRANT_POLICY_VERSION` 3 with the widened digest and its
  bounds, and the `.git` mask in the sandbox builders. PR 2 ships the
  dispatch transaction, runner, ingress, and static-boundary change. PR 3
  ships the vendor assertions, remaining live tests, and documentation.
- The #929 hand-off interaction test (promoted admission ticket → concurrent
  revoke → in-lock revalidation refuses → ticket still released) is a PR 2
  acceptance test; #931 keeps the adversarial conformance suite.
- Raising the child's filesystem view, weakening the canary, reintroducing
  inherited environment (ADR-0130), widening what a grant authorizes,
  relaxing approval ingress, or adding any credential-fallback branch
  invalidates the standing security posture and needs fresh review.
