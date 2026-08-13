---
status: Superseded
date: 2026-08-13
---

# ADR-0136: Patch-train and fork policy for psmfd/pi — two divergence classes, soak gating, caps, and fork triggers

**Status:** Superseded by [ADR-0138](0138-patch-train-and-fork-policy-corrected.md) on 2026-08-13, the same day it was accepted.

> **Superseded — do not apply this ADR's operational detail.** A five-agent
> review found defects the day this merged. Most seriously, the retirement
> mechanism below is described as "**rebase-drop** of the `PSMFD-Patch` commit"
> (a term inherited from ADR-0041), which contradicts ADR-0039's unconditional
> "always `--no-ff` merge, **never rebase**" invariant; the real, twice-exercised
> mechanism is a merge-time allowlist drop. The active C-class cap of ≤ 4 is also
> unsatisfiable against this ADR's own first-generation table (five non-optional
> candidates), the S-class cap exemption carries no scope bound, and four
> criteria are not adjudicable as written.
>
> **ADR-0138 carries forward everything sound here** — the two-class model, the
> soak bar, the mechanism-sinks sorting principle, the first-generation
> candidates (a)–(f), the spawn-seam requirement, and the non-candidate list —
> and corrects the rest. Read ADR-0138 for current policy; this record is
> retained for the reasoning, the empirical base, and the options weighed.

**Supersedes:** [ADR-0041](0041-conditional-security-patch-divergence.md) (conditional security-patch divergence). ADR-0041's decision outcome is carried forward intact as the **S-class** rules below; it is superseded rather than amended because this ADR replaces its governing sentence ("the mirror MAY carry a behavioral patch **only** when all of the following hold", where one of those conditions restricts divergence to security findings).

**Related:** [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) (build-and-attest trust boundary), [ADR-0039](0039-mirror-sync-cadence-and-provenance.md) (sync cadence and provenance — unchanged by this ADR), [ADR-0040](0040-consume-psmfd-attested-pi-releases.md) (pi_config consumes psmfd attested releases), [ADR-0043](0043-upstream-reporting-gate.md) (upstream-reporting gate), [`docs/psmfd-pi-mirror-sync.md`](../docs/psmfd-pi-mirror-sync.md), [`notes/curated-feature-plan.md`](../notes/curated-feature-plan.md) § Track 2. Mirror-side schema follow-up: #982.

## Context and Problem Statement

`psmfd/pi` already runs a patch train. ADR-0041 opened a narrow divergence class on top of ADR-0039's zero-divergence mirror so that Critical/High findings upstream had not fixed could be shipped ahead of upstream without surrendering provenance. That class is **security-only** by construction — ADR-0041's second condition reads:

> The finding is a **security finding** — a CodeQL/code-scanning alert or a CVE/advisory (Dependabot). Routine version refreshes do not qualify and stay on the normal Dependabot/sync path.

The curated feature plan's Track 2 proposes a first train generation that is entirely **capability** work: folding the vendored subagent extension into core, exposing the runtime's own parse tree to a pre-exec hook, worktree-native sessions, client-layer provider failover, a TUI layout primitive, and a confined child-spawn primitive. None of these is a security finding. **Under ADR-0041, every one of them is prohibited.** The policy question is not "should we start a patch train" — one has been running for two months — but "on what terms may it carry capability patches, and when does the train become a fork?"

Three things are missing and are the substance of this ADR:

1. **No soak bar.** The local-first direction (maintainer decision, 2026-08-11) is that runtime patches land and soak locally first and are reported upstream with proven code and a usage basis, never requested upstream in advance. "Soaked" has no definition, so it cannot gate anything. The curated plan already gates hashline's *graduation* on this ADR for exactly that reason.
2. **No divergence guardrail.** A security patch is self-limiting: it retires when upstream ships its own fix. A capability patch has no such terminus — it persists until upstream adopts the capability or the patch is dropped. Without caps, an unbounded train becomes an accidental fork, which is the outcome the mirror's provenance model exists to avoid.
3. **No fork trigger.** If a hard fork is ever correct, it should be a decision made against pre-committed criteria, not a drift nobody declared.

### Empirical base (observed 2026-08-13)

The machinery is proven rather than theoretical, which is what makes the caps below defensible numbers rather than invented ones. From `psmfd/pi` `.psmfd/patches/manifest.yml` and the release list:

| Signal | Observed |
| --- | --- |
| Patches filed to date | 9 (`psmfd-patch-001` … `009`) |
| Active | **3** — 001 (git-ref flag injection, CodeQL 19/22), 003 (shell-quote CVE-2026-9277, sandbox lockfile), 005 (git transport hardening) |
| Retired | 6, across two sync events (upstream v0.79.10 and v0.84.1) |
| Release cadence | 8 `vX.Y.Z-psmfd.N` releases, 2026-06-19 → 2026-08-11 (~1 per 1–2 weeks) |
| Retirement mechanism | Rebase-drop of the `PSMFD-Patch` commit + manifest `status: retired` + lockstep allowlist/guard removal — exercised successfully twice |

Two observations drive the design. First, **retirement works**: the mechanism dissolved 6 of 9 patches without incident, so the lifecycle machinery does not need reinvention for a second class. Second, **3 active patches is the observed steady state** of a solo-maintained train at a ~1–2 week rebase cadence. The C-class caps are set against that measured capacity, not against an aspiration.

## Decision Drivers

- **Mechanism sinks, policy floats.** Enforcement mechanism belongs in the runtime; policy, domain knowledge, and operator preference stay in pi_config. A patch that sinks a *hook* rebases forever; a patch that sinks a *feature* accumulates conflict surface at every sync.
- **Local-first, evidence-led upstreaming.** Upstream receives proven code with a usage basis. This inverts the usual order (propose, then build) and is only defensible if "proven" is defined.
- **Solo-maintainer reality.** Every recurring obligation this ADR creates is paid by one person at a ~1–2 week cadence. A cap that is never checked is not a cap; the checks must be mechanical.
- **Provenance is the mirror's product.** ADR-0038 attests bytes built from the tagged source tree. Any divergence must exist as a real, auditable commit on `main` — the same constraint that ruled out build-time patching in ADR-0041 rules it out here.
- **A fork is a cost, not a failure.** Pre-committing the triggers makes forking a decision rather than a drift, and removes the incentive to quietly exceed caps to avoid declaring one.

## Considered Options

### Whether to permit capability divergence at all

| Option | Verdict |
| --- | --- |
| **Two classes: S-class security (ADR-0041 rules retained) + C-class capability (soaked, capped)** | **Chosen.** Keeps the security class's proven, self-retiring discipline untouched while giving capability work a bounded lane with its own gate. The two classes have genuinely different retirement semantics, so one merged rule set would be wrong for both. |
| Keep security-only; pursue capabilities upstream-first | Rejected. Contradicts the local-first direction and, in practice, means the capabilities do not happen: the plan's items (a)–(c) each delete machinery in pi_config that exists *only* to work around a missing runtime seam, and upstream has no reason to accept a seam with no proven consumer. |
| Hard fork now | Rejected. Forfeits upstream's release stream (2–5 releases/week) and the entire provenance rationale of a detached mirror, in exchange for freedoms the capped train already provides. Reserved for the triggers below. |
| Extension-only forever (no capability patches) | Rejected as the general rule, but retained as the **default**: an item must fail the extension form before it is eligible for the train (see the graduation gate). This is the status quo for everything not explicitly graduated. |

### How C-class divergence is bounded

| Option | Verdict |
| --- | --- |
| **Caps on active count / net lines / touched files, checked at each sync** | **Chosen.** Mechanical, observable at the moment the cost is actually incurred (the rebase), and expressible in the existing manifest. |
| Time-boxed patches (auto-expire after N months) | Rejected. A capability patch's natural terminus is upstream adoption, which is not on a clock. An expiry date would force either a pointless re-approval ritual or a capability regression on an arbitrary day. |
| No cap; rely on maintainer judgement per patch | Rejected. This is the current state for S-class and works only because security findings are externally rate-limited. Capability work is self-generated and has no natural limiter. |

### Soak criteria shape

| Option | Verdict |
| --- | --- |
| **Conjunctive bar: extension-first + duration + rebases-survived + defect-free** | **Chosen.** Each conjunct blocks a distinct failure: shipping something never used, shipping something used briefly, shipping something whose maintenance cost is unmeasured, and shipping something known-broken. |
| Duration only ("N weeks in use") | Rejected. Elapsed time with light use proves nothing; it is the rebases that measure the recurring cost the train will pay. |
| Maintainer declaration ("it feels soaked") | Rejected. This is what the curated plan already identified as the gap. |

## Decision Outcome

The mirror carries **two divergence classes**. Both remain subject to ADR-0038's provenance constraint (a patch is a real commit on `main`, never a build-time application) and ADR-0039's sync cadence and evidence requirements, which this ADR leaves entirely unchanged.

### S-class — security patches

ADR-0041's rules are carried forward **verbatim in substance**. The mirror MAY carry a behavioral patch to upstream-owned source when all of the following hold:

1. **No upstream fix exists or is in flight** for the finding, verified and recorded at patch time.
2. The finding is a **security finding** — a CodeQL/code-scanning alert or a CVE/advisory.
3. The patch is **registered in `.psmfd/patches/manifest.yml`** and the patched path is added to the allowlist in lockstep, via a prior overlay PR.
4. Every commit touching an upstream-owned path carries a **`PSMFD-Patch: <id>`** trailer tying it to its manifest entry.
5. The patch **carries evidence**: a failing-then-passing regression test for source fixes, and the resolved version + advisory ID for dependency bumps.

Lockfile-only security bumps remain the same class as source patches. Retirement remains triggered by `upstream_fixed_in`. Upstream submission remains gated on explicit maintainer approval per ADR-0043. **S-class patches are not subject to the C-class caps** — a security finding is not deferred because the train is full.

### C-class — capability patches

The mirror MAY carry a capability patch when all of the following hold:

1. **It sinks mechanism, not policy.** The patch exposes or implements a runtime seam, primitive, or enforcement point. Policy, domain knowledge, model routing, and operator preference stay in pi_config extensions. A patch that encodes a decision rather than enabling one is rejected at this gate.
2. **The extension form was tried and is insufficient.** Either the capability is unimplementable as an extension, or an extension implementation exists and is demonstrably worse — carrying a workaround whose deletion is the patch's payload. "An extension would be more annoying" does not qualify; "the extension exists, is in use, and this patch deletes N files of workaround" does.
3. **It has soaked** (below), or it is a first-generation candidate explicitly enumerated in this ADR.
4. **It fits within the caps** (below), counted after the patch lands.
5. It is **manifest-registered with `class: capability`**, allowlist-lockstepped, and `PSMFD-Patch`-trailered — identical bookkeeping to S-class.
6. It **carries evidence**: tests that fail without the patch and pass with it, plus a named consumer in pi_config that the patch unblocks or simplifies.

### Soak criteria

A capability graduates to C-class eligibility when **all four** hold. These are the criteria the curated plan defers to; nothing graduates before they exist, which is why this ADR gates graduation decisions and not extension work.

| Criterion | Bar | What it prevents |
| --- | --- | --- |
| **Extension-first** | A working extension implementation exists and is loaded in the operator's daily sessions | Sinking an unvalidated design into the runtime |
| **Duration** | ≥ **6 weeks** of daily-session use since the extension became the default path | Shipping something used briefly or only under test |
| **Rebases survived** | ≥ **3** upstream syncs during which the extension required **no functional rework** (mechanical/type-level adjustment does not reset the count) | Sinking something whose interface is still churning — the measure of recurring cost |
| **Defect-free** | Zero open correctness defects against the extension at graduation time | Sinking a known-broken design |

The duration and rebase bars run concurrently, not consecutively; at the observed ~1–2 week release cadence, 6 weeks and 3 rebases land in the same window by construction. A capability that fails any conjunct stays an extension and is re-assessed at the next sync.

**Graduation is a decision, not an automatic promotion.** Meeting the bar makes an item *eligible*; the maintainer still decides whether the train should carry it, against the caps and the sorting principle.

### Caps and rebase cadence

Counted over **active C-class patches only**, at every `sync/upstream-*` import:

| Cap | Limit | Basis |
| --- | --- | --- |
| Active C-class patches | **≤ 4** | The train's observed steady state is 3 active (all S-class) at a ~1–2 week cadence; 4 is one generation of capability work without doubling the rebase surface |
| Net changed lines, all active C-class patches | **≤ 2000** | A bound the maintainer can actually re-read during a conflicted sync |
| Distinct upstream files touched, all active C-class patches | **≤ 25** | Each touched file is a permanent allowlist entry the zero-divergence guard stops protecting; this is the surface the exemption costs |

**Rebase cadence is not separately scheduled.** It binds to ADR-0039's existing upstream-release-driven sync trigger: every sync rebases the train, and the caps are evaluated as part of that sync's evidence block. This deliberately adds no new recurring obligation — a scheduled "freshness" rebase would be the same anti-pattern ADR-0039 rejects for syncs.

**Cap breach is a stop, not a warning.** A sync that would leave the train over any cap does not proceed until a patch is dropped, upstreamed, or the fork decision below is taken. Exceeding caps for **2 consecutive syncs** is itself a fork trigger.

### Hard-fork triggers

A hard fork is considered — as an explicit, ADR-recorded decision — when any of:

1. **Upstream stagnation ≥ 2 quarters.** No upstream release and no substantive commit activity for two consecutive quarters. The mirror's entire value proposition is upstream's release stream; if it stops, the detached-mirror posture is paying provenance costs for nothing.
2. **Caps exceeded for 2 consecutive syncs.** The train is structurally larger than a rebasing train can carry, and pretending otherwise means each sync degrades into a merge project.
3. **Upstream rejects a load-bearing soaked patch.** A patch that survived the full soak bar, was contributed with evidence, and was declined on grounds that will not change. "Load-bearing" means pi_config's design depends on it; a declined nice-to-have is dropped, not forked over.

None of these triggers *mandates* a fork. Each mandates a decision recorded in a new ADR, with continuing-as-is an available outcome.

### First-generation contents — candidates, not commitments

The following are recorded as the **first generation of C-class candidates**. Enumeration here satisfies C-class condition 3 for these items (they may proceed without the retrospective soak bar, since their extension-form predecessors predate this policy) but does **not** commit the train to carrying them — each is still individually gated on conditions 1, 2, 4, 5, and 6.

| # | Candidate | Payload |
| --- | --- | --- |
| **(a)** | **Subagent fold** | Vendored subagent extension + local patch series folded into core; deletes the vendor copy, `PATCH_MANIFEST.json`, the drift validator, and the snapshot-bump workflow; unlocks schema-validated returns |
| **(b)** | **Pre-exec shell AST hook** | Exposes the runtime's own parse tree post-parse/pre-spawn so the shell guards judge the *executing* AST; retires the vendored `bash-parser` and the ADR-0072/0100/0112 parser-mismatch bypass class. Guards stay extensions — this sinks the seam, not the policy |
| **(c)** | **Worktree-native sessions** | Session starts inside the worktree; deletes the deny/redirect steering machinery. WIP-snapshot logic may stay extension-side |
| **(d)** | **Provider failover / circuit breaker** in the client layer | ADR-0122/ADR-0126 behavior, uniform for parent and children. Auto-router *policy* stays an extension |
| **(e)** | **TUI layout-region/tab primitive** | **Decision point, not a commitment.** Dropped from the first generation if FingerTrap phase FT-1 lands first — FT-1 is the primary resolution for the persistent tab bar, this is the fallback |
| **(f)** | **Confined child-spawn primitive** | bwrap/landlock, `.git` masking. All grant and approval policy stays in pi_config. Expected to be the **same** confinement implementation the typed-tool-surface work needs for filesystem confinement — one primitive, two consumers. The two ADRs must confirm this rather than build twice |

Items (a)–(d) and (f) each satisfy condition 2 by deleting an existing pi_config workaround; that deletion is the evidence.

**Spawn-seam requirement.** The core seam introduced by (a) must serve **both** spawn consumers — the folded subagent extension and pi-workflow's `SubagentInvoker` adapter — with pi-workflow's child-hardening contract as the default: `--no-context-files --no-skills --no-prompt-templates --no-extensions`, canonicalized absolute extension paths, a host-owned env allowlist, absolute-PATH-only resolution, no shell, spawn-fenced dispatch, and mutating-work-treated-as-indeterminate on post-spawn error. A seam that serves only the folded extension would force pi-workflow to re-implement hardening the runtime already performs.

### Generation mechanism

Track 1 graduates enter as **second-generation candidates** once soaked, rather than being enumerated in the first generation now. The soak pilot is `hashline-edit` (ADR-0134/ADR-0135): it is deliberately extension-first, and its graduation to an in-core edit tool is gated on the criteria above. Each subsequent generation is recorded by amending this ADR's candidate table via a new ADR, never by editing this one.

### Explicit non-candidates

Recorded so the sorting principle is not re-litigated per item. These are at the **correct layer already** and are not train candidates in any generation:

- **`context-manager`, `compaction-optimizer`** — context policy is policy.
- **The meters** (`token-meter`, `cache-meter`, `prefill-meter`) — observation, not mechanism; they render and record, which is the outermost layer's job.
- **`github-read`, `git-read`, `web-fetch`, `artifact-handoff`, `indexing`, the expertise suite, `payload-tuner`** — tool surfaces and domain integrations. The typed-tool-surface work makes these *data* (descriptors), which is further from the runtime, not closer.
- **All agents, skills, and rules** — policy and domain knowledge by definition.

The guards (`secrets-guard`, `bash-destructive-guard`, `gh-identity-guard`) are a deliberate near-miss: candidate (b) sinks the *parse tree* they judge against, while the guards themselves stay extensions. Sinking a guard would sink policy and is rejected.

## Consequences

- **Positive.** Track 2 becomes executable; the local-first direction gets an enforceable definition of "soaked"; divergence acquires a mechanical bound checked at the moment its cost is paid; forking becomes a pre-committed decision rather than a drift; and the sorting principle is written down before the first capability patch rather than reconstructed after the fifth.
- **Negative / accepted.** The zero-divergence guarantee narrows a second time — from "never, except security patches" to "never, except security patches and ≤ 4 capped capability patches." Each C-class allowlist entry is a file the zero-divergence guard stops protecting for the patch's lifetime, and C-class lifetimes are long (upstream adoption, not upstream fix). This is bounded by named-file scope, the file-count cap, and manifest review, and it is a real widening of the mirror's inbound risk surface — accepted deliberately, not incidentally.
- **Negative / accepted.** The caps are calibrated to a **solo maintainer at the currently observed cadence**. If either changes materially, the numbers are wrong in one direction or the other and this ADR needs superseding rather than reinterpreting.
- **Follow-up (#982).** The mirror's three lockstep surfaces need the new class: a `class:` field in `.psmfd/patches/manifest.yml` (existing entries backfilled `class: security`), generalized comment headers in `.psmfd/overlay-allowlist.txt` (whose current text implies all exemptions are temporary — true for S-class, false for C-class), and a rename-or-sibling for `SECURITY_PATCH_PATHS` in `psmfd-zero-divergence.yml`. Per ADR-0041's design property, this must add **no new guard logic** — allowlist data only. The C-class retirement field is also new: `upstream_fixed_in` is meaningless for a capability, whose retirement trigger is upstream *adoption* or a drop decision.
- **Follow-up.** A `psmfd-patch-integrity` check asserting manifest↔allowlist consistency and cap conformance remains the mechanical enforcement this ADR's caps assume. Until it exists, cap checking is a sync-time manual step in the evidence block.

## Supersession note

This ADR supersedes ADR-0041 and narrows, but does not revoke, ADR-0039's zero-divergence model. The trusted `sync/upstream-*` bypass, all sync evidence requirements, the sync-PR/overlay-PR mutual exclusivity, and the never-cross list are unchanged. ADR-0038's build-and-attest trust boundary is unchanged: both patch classes exist as real commits on `main`, so attested bytes continue to match a tagged source tree.
