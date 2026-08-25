---
status: Accepted
date: 2026-08-20
---

# ADR-0145: second-generation C-class admission — RPC protocol seams for the v0.84.2-psmfd.1 bump

**Status:** Accepted 2026-08-20 — operator-approved as dsh-adoption step 3b (the pickup order recorded after psmfd/FingerTrap ADR-0027). Implementation is the `v0.84.2-psmfd.1` fork release.

**Related:** [ADR-0138](0138-patch-train-and-fork-policy-corrected.md) (governing patch-train policy; this ADR is a generation record under its rules), [ADR-0136](0136-patch-train-and-fork-policy.md) (the generation mechanism this ADR exercises: "Each subsequent generation is recorded … via a new ADR"), [ADR-0039](0039-mirror-sync-cadence-and-provenance.md) (sync ritual the folded v0.84.2 import follows), [ADR-0092](0092-pi-runtime-bump-automation.md) (consumer pin bump), psmfd/FingerTrap [ADR-0025](https://github.com/psmfd/FingerTrap/blob/main/adrs/0025-ft2-rpc-supervisor-native-pane.md) / [ADR-0027](https://github.com/psmfd/FingerTrap/blob/main/adrs/0027-deepseek-harness-assessment.md) (the downstream adoption decisions), psmfd/pi [#54](https://github.com/psmfd/pi/issues/54), [#56](https://github.com/psmfd/pi/issues/56), [#57](https://github.com/psmfd/pi/issues/57), [#53](https://github.com/psmfd/pi/issues/53) / #982 (manifest schema), #1008 (v0.84.2 upstream sync, folded in).

## Context and Problem Statement

FingerTrap's FT-2 supervisor drives pi over `--mode rpc` and has filed three protocol gaps against the fork, each with an implementation plan already posted on the issue:

1. **pi#56 — `hello` ready line.** RPC mode emits no ready signal; the supervisor's only options are the sleep-and-probe readiness hack and "died silently" ambiguity. The plan: a first-stdout-write `hello` frame carrying `piVersion`, `protocol`, and a `capabilities` array — the forward-compatibility valve that lets later commands be advertised instead of probed.
2. **pi#54 — `list_sessions` command.** The supervisor needs session metadata but the only path is a direct filesystem scan (FingerTrap `SessionStore`, isolated for deletion when this lands). The plan: expose the existing `SessionManager.list()`/`.listAll()`, header fields only, `allMessagesText` omitted.
3. **pi#57 — spawn-time dialog silent exit-0.** RPC mode attaches its stdin reader only after `session_start` hooks complete, so a dialog awaited there is unanswerable; the hook deadlocks and pi exits 0 silently. Discovered and pinned by FingerTrap's record–replay golden suite (FT#139, golden `session-start-dialog-exit`).

FingerTrap ADR-0027 (P2/P3) recorded the adoption decision — implement in the fork as `-psmfd` patches, PR upstream from there — but the fork-side policy admission is this repo's to make: ADR-0138's C-class lane is the only sanctioned mechanism for capability divergence, and these are its first occupants. Two policy questions need explicit adjudication, and the bump also needs its base version decided (upstream v0.84.2 shipped; #1008 proposes folding the sync into this bump).

### The condition-3 gap

C-class condition 3 (ADR-0136, carried by ADR-0138) requires that a patch "has soaked, or is a first-generation candidate explicitly enumerated in this ADR." The soak bar's first conjunct is **extension-first** — a working extension implementation in daily use. All three seams fail that conjunct *by construction*, not by neglect:

- `hello` must be the first stdout write, before extensions are even bound — no extension executes early enough to emit it.
- `list_sessions` needs a structured, id-correlated RPC *response*; extensions surface output through events and messages, not the response channel, and would need `SessionManager` internals regardless.
- pi#57 is a startup-ordering defect in `runRpcMode` itself; an extension is the *victim* of the ordering, not a position from which to fix it.

Read literally, condition 3 makes any never-implementable-as-extension seam permanently inadmissible — even though condition 2 explicitly recognizes "the capability is unimplementable as an extension" as the stronger of its two branches. That is a drafting gap, not a design intent: the soak bar exists to stop *unvalidated designs* from sinking into the runtime, and its validation pressure is meaningless for capabilities that cannot exist at the outer layer at all.

### The consumer-locus gap

C-class condition 6 requires "a named consumer **in pi_config** that the patch unblocks or simplifies." The consumer here is FingerTrap's supervisor — a psmfd downstream of the same attested release stream, with its adoption recorded in its own ADRs — not a pi_config extension. Condition 6's wording predates a second consumer of the fork existing.

## Considered Options

### Where the three seams land

| Option | Verdict |
| --- | --- |
| **C-class patches in the fork, this release** | **Chosen.** The adoption decision is recorded (FT ADR-0027); the plans are posted on the issues; the golden suite (FT#139) exists specifically so a pin bump is verified by recorded-transcript diff — this bump is that ritual's first customer. |
| Upstream-first PRs, wait for a release | Rejected — contradicts the local-first direction ADR-0136 records (proven code with a usage basis, never requested in advance), and upstream has no reason to accept a ready-signal or listing command with no consumer. |
| FingerTrap works around all three forever | Rejected — the workarounds are the cost: a sleep-and-probe readiness hack, a parallel session scanner scheduled for deletion (FT ADR-0025), and a supervisor policy (FT#147) treating clean exits as fatal. Each is machinery that exists only because a seam is missing — exactly ADR-0136's "mechanism sinks" case. |

### The condition-3 gap

| Option | Verdict |
| --- | --- |
| **Adjudicate: generation-ADR enumeration satisfies condition 3 when condition 2's "unimplementable as an extension" branch holds** | **Chosen.** Mirrors the first generation's own exemption (its candidates skipped the retrospective soak bar because "their extension-form predecessors predate this policy"); here the extension form cannot predate or postdate anything — it cannot exist. The validation the soak bar buys is supplied instead by condition 6 evidence: fork-side tests that fail without the patch, plus FingerTrap's replayed golden lane, which pins the exact wire behavior on every CI run of the consumer. |
| Amend ADR-0138 to rewrite condition 3 | Rejected — supersession for a one-clause adjudication is churn; this ADR records the reading, and a future policy revision can fold it in. |
| Treat the seams as inadmissible; keep the workarounds | Rejected — elevates a drafting gap over the policy's stated intent, and leaves pi#57 (a real defect with a silent-failure mode) unfixable in the fork. |

### The consumer-locus gap

Adjudicated: "named consumer" is read as **a named consumer in the psmfd estate with its adoption recorded in an ADR** — FingerTrap qualifies via ADR-0025/0027. pi_config remains a consumer indirectly (the vendored pin, ADR-0092, serves the same attested release). The alternative reading (pi_config extensions only) would make the fork's protocol surface unimprovable for any other consumer, which the two-consumer spawn-seam requirement in ADR-0136 already contradicts in spirit.

### Base version

| Option | Verdict |
| --- | --- |
| **Fold the upstream v0.84.2 sync in; tag `v0.84.2-psmfd.1`** | **Chosen.** One rebase/re-verification instead of two (the sequencing note on #1008); the v0.84.2 delta does not touch `rpc-mode.ts` and grazes `session-manager.ts`/`main.ts` by ~11 lines, so patch conflict risk is minimal. |
| Patch on v0.84.1; tag `v0.84.1-psmfd.2`; sync later | Rejected — pays the sync rebase twice within days and releases a fork base already one version stale. |

## Decision Outcome

**Admit three C-class patches as the second generation**, landing in fork release `v0.84.2-psmfd.1` on an upstream v0.84.2 base:

| Patch | Seam | Payload (per the posted issue plans) |
| --- | --- | --- |
| `psmfd-patch-010` | `hello` ready line (pi#56) | First stdout write in `rpc-mode.ts`, before the stdin reader: `{"type":"hello","piVersion":…,"protocol":1,"capabilities":[…]}`. Capabilities advertise `list_sessions` so pi#54 is discovered, never probed. |
| `psmfd-patch-011` | `list_sessions` command (pi#54) | RPC `list_sessions { cwd?, all? }` → `{ sessions: […] }` over `SessionManager.list()`/`.listAll()`; header fields only (`path`, `id`, `cwd`, `name`, `parentSessionPath`, `created`, `modified`, `messageCount`, `firstMessage`); `allMessagesText` omitted from the wire. |
| `psmfd-patch-012` | spawn-time dialog fix (pi#57) | Attach the stdin JSONL reader before the `session_start` emit, buffering non-`extension_ui_response` lines until session bind completes — spawn-time dialogs become answerable; the silent exit-0 class is closed. |

**Per-condition adjudication (ADR-0136 C-class conditions, as corrected by ADR-0138):**

1. *Mechanism, not policy* — all three are protocol seams (a ready signal, a metadata projection, a reader-ordering fix); no routing, preference, or domain knowledge sinks.
2. *Extension form* — unimplementable as extensions, per the condition-3 gap analysis above; the stronger branch of condition 2.
3. *Soak / enumeration* — satisfied by enumeration in this generation ADR under the adjudication above.
4. *Caps* — after landing: 3 active C-class patches (≤ 6), estimated well under 2000 net lines and 25 files; recomputed in the sync evidence block per ADR-0138 §2.
5. *Bookkeeping* — manifest-registered `class: capability`, allowlist-lockstepped, `PSMFD-Patch`-trailered. **Prerequisite folded in:** the manifest `class:` field and a C-class retirement field distinct from `upstream_fixed_in` (pi#53 / #982, ADR-0138's named follow-up) are implemented in the same fork PR series, and the zero-divergence guard gains a `C_CLASS_PATCH_PATHS` set parallel to `SECURITY_PATCH_PATHS` (both workflows + `.psmfd/overlay-allowlist.txt` + `.psmfd/security-baseline.md`, lockstep).
6. *Evidence* — fork-side tests failing without / passing with each patch, plus the consumer proof: FingerTrap re-records its #139 golden suite against the new pin, and the working-tree diff of `Goldens/data/` **is** the drift report (`hello` appears in every transcript; `session-start-dialog-exit` flips from silent exit-0 to an answered round-trip; a new `list_sessions` scenario is added). Named consumers: FingerTrap `PiRpcClient` (FT#148 hello gating, FT#140 listing carry-over, FT#147 policy retirement), pi_config's vendored pin via ADR-0092.

**Retirement terminus** (the C-class field pi#53 adds): each patch retires when upstream ships an equivalent capability — the local-first path is to PR these upstream from the fork once soaked in FingerTrap daily use, with the golden transcripts as the usage evidence.

## Consequences

- **Positive.** The fork's first capability generation lands under the policy rather than around it; the two drafting gaps in the C-class conditions are adjudicated in writing instead of by silent judgment; the #139 golden ritual gets its first real pin bump; pi#57's silent-failure class is closed at the source instead of being policy-papered in every consumer.
- **Negative / accepted.** Three permanent-until-retired allowlist entries widen the zero-divergence guard's blind spot — the exact cost ADR-0138's caps meter. `psmfd-patch-012` reorders RPC startup, the riskiest of the three; mitigated by fork-side regression tests plus the golden lane replaying the full startup wire sequence on every FingerTrap CI run.
- **Negative / accepted.** The condition-3 and condition-6 adjudications are readings recorded here, not text changes in ADR-0138; a future policy revision should fold them in so the conditions read correctly cold.
- **Follow-up.** After the bump: pi_config pin bump via `bump-pi-runtime.sh` (ADR-0092) closes the loop; FingerTrap re-verifies `docs/rpc-contract.md` from the golden diff; FT#148/FT#140/FT#147 proceed on the new pin.
