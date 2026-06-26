# ADR-0008: Tier 3 artifact handoff as sole sanctioned intra-session inter-agent evidence channel

**Status:** Accepted
**Date:** 2026-05-19
**Supersedes:** [ADR-0002](0002-agent-to-agent-channel.md) (Agent-to-agent (a2a) channel — orchestrator-mediated filesystem journal)
**Related:** [ADR-0001](0001-subagent-orchestration-substrate.md), [ADR-0006](0006-artifact-handoff-and-review-format.md), [ADR-0007](0007-tier-3-payload-path.md)

## Context and Problem Statement

ADR-0002 proposed a per-session orchestrator-mediated filesystem journal (`coms`) to enable subagents within the same parallel batch to exchange evidence mid-flight. It was drafted on 2026-05-18 against a substrate in which the only inter-agent flow was parent-mediated text passing between sequential Form A/B turns.

Between ADR-0002's drafting and this ADR, three landed changes materially altered the substrate:

1. **ADR-0006 (Artifact handoff and review format)** defined a tiered handoff contract for in-session payloads larger than a Form-B summary can carry.
2. **ADR-0007 (Tier 3 payload path)** chose `.review/` as the branch-scoped tracked directory for Tier 3 payloads.
3. **PR #95** implemented the `artifact_review` tool with six hard refusals (absolute path, `..` segment, strict-under check, parent realpath outside `reviewRoot`, leaf symlink via `O_NOFOLLOW`, equality with `.review` itself), secrets-guard coverage extended to the new tool, and validate.sh § 6b shape-based SKIP_PATH_GLOBS verification.

Together these define an alternative channel for inter-agent evidence exchange: a producing agent writes a path-confined, secrets-scanned artifact under `.review/`, the parent surfaces the artifact path in the next agent's brief, the consuming agent reads it via its own `read` tool. This channel did not exist when ADR-0002 was drafted.

A 3-replica `pi-agent-expert` consensus (per [ADR-0004](0004-consensus-by-replication.md)) unanimously concluded that the realistic use cases ADR-0002 was designed to serve are now covered by this Tier 3 substrate, that the remaining uncovered case (mid-batch synchronous redirection between concurrent peers) is structurally discouraged by `agent/rules/research-parallelism.md` and `agent/rules/consensus-by-replication.md`, and that the highest-value such case is *forbidden* by ADR-0002's own hard-exclusion of the three review specialists from the bus.

The question this ADR resolves is which intra-session inter-agent evidence-exchange channel is the sanctioned one going forward, so that this design space does not get relitigated.

## Considered Options

* **Option A** — **ADR-0002 coms substrate.** See ADR-0002 for full design. Rejected per ADR-0002's superseded-to status; the realistic cost (~1600–2200 lines of review surface against a 10-item hard floor) exceeds the marginal value above what Tier 3 already provides. Detailed rationale captured on ADR-0002 itself.

* **Option B** — **Tier 3 artifact handoff (`.review/` + `artifact_review`) as the sole sanctioned channel.** Codify the substrate landed in PR #95 as the canonical mechanism. No new code; this ADR is a *closing* decision that affirms the existing substrate is the answer and that proposals for additional intra-session channels need to supersede this ADR.

* **Option C** — **Unsanctioned ad-hoc filesystem writes anywhere in the working tree.** Strictly weaker than Option B (no path confinement, no secrets-guard coverage, no audit trail, no shape contract). Rejected.

* **Option D** — **No sanctioned channel; intra-session inter-agent exchange remains Form A/B-only.** Achievable but ignores the existing capability. The substrate from PR #95 is already deployed; declining to name it leaves contributors guessing whether using `artifact_review` for inter-agent handoff is "real" or accidental.

## Decision Outcome

Chosen option: **B — Tier 3 artifact handoff (`.review/` + `artifact_review`) is the sole sanctioned intra-session inter-agent evidence channel**.

The decision is structural, not just preferential:

1. **Trust model is structurally smaller than coms.** Capability laundering is impossible by construction — the receiver acts only under its own declared `tools:` on data it chose to `read`. There are no transferred capabilities to intersect, no spawn-lineage tokens to validate, no signed registry, no hash-chained log. Every primitive Tier 3 uses already had security review and is exercised in production.

2. **Aligns with existing aggregation rules.** [`rules/research-parallelism.md`](../agent/rules/research-parallelism.md) and [`rules/consensus-by-replication.md`](../agent/rules/consensus-by-replication.md) already mandate that parallel agents run independently to completion before synthesis. The "mid-batch synchronous redirection" use case that only coms could serve would *defeat* aggregation. Tier 3's between-batch sequential semantics match the rules we already enforce.

3. **Preserves the AGENTS.md § Boundaries invariant structurally.** "No subagent invokes another subagent" remains true without carve-outs. Coms required a 10-item hard floor to nominally preserve this property while functionally violating it. Tier 3 preserves it by construction: producing agents write files; consuming agents read files; the parent decides what to surface and to whom.

4. **Reuses existing rule-shape.** Every inter-agent interaction now follows the same shape as every other parent ↔ child interaction: parent receives a Form A/B return (possibly citing a `.review/` artifact), parent composes the next brief (possibly including artifact paths to read), child consumes brief and acts under its own tool surface. No second protocol to learn.

5. **Reviewer independence is preserved by brief composition.** The three review specialists (`code-review-expert`, `security-review-expert`, `checkmarx-expert`) are hard-excluded from coms in ADR-0002 to prevent peer-influenced reviews. The Tier 3 analog: the orchestrator MUST NOT surface peer-produced `.review/` artifacts to these three reviewers in their briefs. This is now a rule-shaped obligation, recorded below in *Operational obligations*.

### Operational obligations

These obligations apply to the orchestrator (the pi parent) composing subagent briefs. They do not require any new code; they constrain orchestrator behavior.

1. **Reviewer-independence brief discipline.** Briefs sent to `code-review-expert`, `security-review-expert`, or `checkmarx-expert` MUST NOT cite peer-produced `.review/` artifacts as inputs. Reviewers receive only the diff under review and their own tool surface. Codified in [`rules/structured-review-format.md`](../agent/rules/structured-review-format.md) § Reviewer-independence brief discipline.

2. **Provenance convention.** When the orchestrator surfaces a `.review/` artifact to a downstream agent, the brief MUST state the producing agent name, the batch identifier (if known), and a one-line summary of the artifact's intended use. Filename convention for artifacts produced via `artifact_review` SHOULD be `.review/<topic>.md` with frontmatter or a leading heading capturing `author:` and `produced_at:`.

3. **No work delegation via artifact.** A `.review/` artifact is evidence, observation, citation, or structured findings. It MUST NOT contain imperative instructions phrased as commands for the consuming agent. (Same boundary coms's `agent-to-agent-channel.md` rule attempted to encode for envelopes; here it applies to artifact bodies.)

4. **Lifecycle.** Artifacts persist until cleaned. The orchestrator decides cleanup cadence per session; `.gitignore` prevents commit. Persistent multi-session artifacts are permitted when the workflow benefits from cross-session continuity (e.g., a multi-day investigation surface).

### Tradeoffs

* Good: Smallest possible trust surface — no new code, no new primitives, no new attack surface beyond what PR #95 already added and reviewed.
* Good: Reuses existing substrate (`write`, `read`, `artifact_review`, `.gitignore`, secrets-guard, path confinement) end-to-end.
* Good: Sequential between-batch semantics align with `rules/research-parallelism.md` and `rules/consensus-by-replication.md` rather than fighting them.
* Good: Closes the intra-session design space cleanly, so future contributors find an affirmative decision rather than a gap.
* Good: Artifacts are post-hoc inspectable in the working tree, giving the orchestrator a third source of truth alongside child stdout JSON events and Form A/B reports.
* Bad: Forecloses mid-batch synchronous exchange. No current workflow needs it; the re-evaluation trigger is recorded below.
* Bad: Provenance enforcement moves from runtime envelope metadata (coms) to filesystem naming + parent-curated brief convention. Weaker enforcement, but the parent controls injection so misrepresentation requires parent collusion.
* Neutral: Audit integrity is weaker than coms's hash-chained log, but ADR-0002 itself conceded the chain was "forensic-grade for honest operator, attestation-grade only with external sink" — a property nobody asked for. Parent session JSONL transcript already records every `artifact_review` invocation.

### Re-evaluation trigger

This ADR is reopened or superseded only if **≥3 concrete observed workflows** are documented where two specialists in the *same* parallel batch needed to exchange evidence mid-flight in a way that a follow-up Tier-3-mediated turn could not serve. Until that bar is met, do not reopen.

## More Information

### Out of scope: inter-orchestrator (peer-session) coordination

This ADR governs **intra-session** inter-agent exchange — multiple subagents inside a single pi parent. It explicitly does **not** address **inter-session** coordination — multiple pi parents running as peer orchestrators, sharing planning, dividing work, and coordinating commits/PRs. That is a separate design space tracked under issue #96 "Multi-orchestrator coordination topology" and any subsequent ADR.

`.review/` artifacts on a shared filesystem happen to be readable across pi sessions running in the same worktree; this is a permitted side benefit and may serve as a fast-path signal mechanism for multi-orchestrator workflows. It is not a formal commitment, and any formal multi-orchestrator protocol requires its own ADR.

### Cross-references

* Tracking issue: pi_config #69 — extension triage. Phase B (which originally tracked ADR-0002) is closed in favor of this ADR.
* Superseded ADR: [ADR-0002](0002-agent-to-agent-channel.md) — full design archive preserved, status flipped to *Superseded*.
* Preserved-as-appendix: [`agent/rules/agent-to-agent-channel.md`](../agent/rules/agent-to-agent-channel.md) — operational contract drafted for the coms substrate, retained as a *Withdrawn* design archive rather than deleted. The rule does not load and is not enforced.
* Companion ADRs: [ADR-0006](0006-artifact-handoff-and-review-format.md) (tiered handoff format), [ADR-0007](0007-tier-3-payload-path.md) (`.review/` path choice).
* Adjacent ADR: [ADR-0005](0005-tool-call-journal-and-restore.md) — independent design; references to ADR-0002 in ADR-0005 remain historically accurate (per ADR immutability ADR-0005 is not edited; readers following the cross-reference will see ADR-0002's *Superseded* status).
* Consensus method: [ADR-0004](0004-consensus-by-replication.md) — applied to produce the unanimous 3-replica recommendation underlying this decision.
