---
status: Accepted
date: 2026-05-19
---

# ADR-0006: Artifact handoff format for in-session user review

**Status:** Accepted
**Date:** 2026-05-19
**Companion to:** [ADR-0001](0001-subagent-orchestration-substrate.md)
**Tracking issue:** #67

## Contents

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [Tiered transport ladder](#tiered-transport-ladder)
  - [Artifact-structure convention (the §1 convention)](#artifact-structure-convention-the-1-convention)
- [Consequences](#consequences)
- [More Information](#more-information)

## Context and Problem Statement

When the orchestrator prepares a long single-file artifact for user review — typically a PR body, an ADR draft, an upstream issue draft, or a synthesized review report in the 1–50 KB range — the current handoff is to paste the artifact inline in chat. This doubles the conversation token cost (once as tool output, once as the assistant's narrative), offers no per-block review affordance, makes the round-trip expensive (each iteration re-renders the full artifact), and degrades poorly for whitespace-sensitive content. The pattern most recently surfaced as friction while preparing the upstream pi-mono issue body for #46 — a ~10 KB Markdown artifact with embedded code/diff blocks.

The pain point is dominated by **token cost of re-pasting on revision**, not by absence of per-block accept/reject affordances. Evidence: in this repo's session history, artifact-review cycles have averaged ~3 revisions before convergence, with the inline paste consuming the largest single block of context per cycle.

## Considered Options

The issue body enumerated six options. Two singleton novel options surfaced during the 4-way subagent fan-out (`pi-agent-expert`, `gh-cli-expert`, `gitflow-expert`, `docs-expert`).

- **Option 1** — `pi.events` review hook + custom side-panel TUI extension
- **Option 2** — External editor handoff (`$EDITOR` / `code --wait`)
- **Option 3** — `git diff`-style iteration in a `drafts/` path (sub-variants: 3a tracked / 3b gitignored / 3c ephemeral branch)
- **Option 4** — GitHub draft PR/issue with edit-in-browser (sub-variants: 4a issue draft / 4b draft PR / 4c gist / 4d direct upstream)
- **Option 5** — Inline-paste with collapsed sections
- **Option 6** — Two-pane: summary inline + full artifact on disk
- **Option 7** *(novel, credit `pi-agent-expert`)* — Fuse Options 3+6 into a single registered tool `artifact_review` invoking `Write` + `renderResult` + `ctx.ui.editor` + `pi.sendMessage({deliverAs:"steer"})` with diff-only re-injection (~150 LOC, S-tier)
- **Option 8** *(novel, credit `docs-expert`)* — Deliver revisions as unified `diff -u` in a fenced ```diff block + changelog cover letter, never re-render full v2 body unless asked

## Decision Outcome

**Adopt a five-tier transport ladder defaulting to Option 6 (two-pane), gated by artifact size and structure. Adopt docs-expert's §1 convention as the load-bearing transport-independent authoring grammar. Defer Options 7 and 1 to follow-up issues; document Option 8 as the revision-delivery default within Tier 2.**

The 4-way subagent fan-out converged on Option 6 as the primary transport from four independent lenses (pi-internals feasibility, GitHub-side UX, git-workflow integration, authoring/UX). Aggregation per [`agent/rules/consensus-by-replication.md`](../agent/rules/consensus-by-replication.md) ladder: unanimous → adopt. The adjacent contributions stack rather than compete — `gitflow-expert` specifies the on-disk substrate (3b, gitignored `drafts/`), `pi-agent-expert` names the implementation form (Option 7), `docs-expert` produces the authoring convention, `gh-cli-expert` positions Option 4 as escalation only. No dissent to record.

### Tiered transport ladder

**Sizing principle:** when an artifact's predicted body size falls near a tier boundary, **default UP to the next tier**. Truncation and re-paste cost are asymmetric — promoting a small artifact to Tier 2 costs a `Write` tool call; demoting an over-budget artifact to fit Tier 1 risks losing content to scrollback or context-window pressure. Err larger.

| Tier | When | Mechanism | Status |
|---|---|---|---|
| **0** | size < 1 KB AND one-shot trivial | Inline paste, no convention | Status quo, retained |
| **1** | 1 KB ≤ size < 4 KB | Inline paste **using §1 convention** — block sentinels, attention pragmas, ID grammar | Adopt |
| **2 *(default)*** | size ≥ 4 KB (up to 50 KB) | Write to gitignored `drafts/<topic>.md`; emit inline summary (1:10–1:20 ratio) with numbered `aN:`-keyed claims/open-questions; revisions delivered as unified `diff -u` + changelog (Option 8) | Adopt |
| **3** | size ≥ 8 KB AND strong block structure AND user requests line-anchored review | Draft PR on `pi_config` with `artifact-review` **label**; payload location is non-gitignored and resolved in Phase 2 (the `drafts/` directory is gitignored and therefore **not** the Tier 3 payload path — `git add -f` is explicitly disallowed); never merged — `gh pr close --delete-branch` on convergence | Adopt as opt-in |
| **4** | Per-block accept/reject demand confirmed by real pain | Custom side-panel TUI extension (Option 1, L-tier ~600–900 LOC) | Deferred — open follow-up issue only on observed need |

Size thresholds err on the side of larger per the truncation-avoidance principle above: Tier 2's 4 KB floor (rather than docs-expert's empirical ~8 KB crossover) accepts a small flow tax on artifacts in the 4–8 KB band in exchange for never having a Tier-1-classified artifact silently exceed inline-paste capacity. The 8 KB Tier 3 trigger matches the empirical "strong block structure" threshold from `gh-cli-expert`'s analysis of when GitHub line-anchored review starts to pay back its 1-leave-per-cycle friction. Tier 4 is the highest-quality outcome (custom panel) but the lowest-ROI investment today.

Tiering escalation is **opt-in by the user**, not automatic. The orchestrator selects Tier 0/1/2 based on predicted body size; Tier 3 requires explicit user request ("let's review this on GitHub"); Tier 4 doesn't exist as a built path until a follow-up issue ships it.

### Artifact-structure convention (the §1 convention)

Adopt the convention proposed by `docs-expert` in the #67 fan-out, comprising:

1. **YAML frontmatter** with fields `artifact`, `version`, `parent`, `prior` (iff `version > 1`), `summary_ratio`, `attention_count`
2. **GFM TOC** (depth H2/H3, included when ≥ 4 H2s or size ≥ 3 KB)
3. **`anchor:<name>` HTML comments** before headings that need rename-stable IDs
4. **`<!-- block:<type> id=<idN> -->` sentinels** with closed 8-tag vocabulary: `summary`, `claim`, `rationale`, `diff`, `quote`, `xref`, `open`, `meta`; IDs are short ordinals scoped per tag (`c1, c2, …`, `r1, r2, …`)
5. **`<!-- review:<level> id=aN -->` pragmas** with three escalation levels: `please-confirm`, `low-confidence`, `decision-needed`; IDs `aN` unique across the artifact
6. **Iteration grammar**: `<id>: accept | drop | <replacement text>`; `§<anchor>: <action>` for whole sections; `+after <id>:` / `+before <id>:` for insertions
7. **Diff-on-revision**: prepend `## Changes since v{N-1}` table; retain prior version at `<name>.v<N>.md`; default response after regeneration is changelog + regenerated blocks only (full body on demand)
8. **Collapse policy**: always-expanded for `summary`/`claim`/`open` and all `review:*`; collapse-when-> 400 B for `rationale`/`diff`; always-collapsed for `quote`/`xref`/`meta`; skip `<details>` markup entirely below 5 KB total

The convention is the load-bearing deliverable because it is transport-independent — it works whether the artifact is rendered inline (Tier 1), referenced on disk (Tier 2), pushed as a draft PR body (Tier 3), or — if Tier 4 ever ships — fed to a custom panel that honors the same block grammar. Adopting the convention now locks in the structural compatibility before any tool/extension is built against it.

**Scope.** Convention adoption is scoped to **orchestrator→user artifact handoff only**. The existing Form A `REPORT_FILE:` pattern in [`agent/rules/subagent-parallel-handoff.md`](../agent/rules/subagent-parallel-handoff.md) is **not** retrofitted under this ADR; a future amendment may broaden scope but is out of scope here.

## Consequences

**Positive.** Revision cycles in Tier 2 cost ≈ delta-bytes × 2 (the `diff -u` representation) instead of full-artifact-bytes per revision. For a 14 KB artifact iterated 3× with ~500-byte deltas, this drops revision token cost from ~84 KB to ~3 KB (~96% reduction). Authoring discipline (numbered claims, attention pragmas) makes reviewer attention routing explicit. Tier 3's `artifact-review` label gives access to GitHub's best-in-class line-anchored review when needed, without making it the default tax.

**Negative / costs.**

- **Authoring cost on the orchestrator side**: composing artifacts under the §1 convention is more structured than free-form prose. Estimated +10–15% authoring tokens vs. unstructured output; recouped on first revision.
- **`drafts/` directory** added to `.gitignore`. The secrets-guard extension layer (`agent/extensions/secrets-guard/index.ts`) must explicitly cover gitignored writes (already true — `drafts/` is not in `SKIP_PATH_GLOBS`); the follow-up implementation issue must include a smoke-test that asserts `drafts/**` remains in scan scope (regression-resistant).
- **Tier 3 deviation from GitHub Flow**: `artifact-review`-labeled draft PRs are an exception to the squash-merge-to-`main` rule. The exception is documented here and cross-referenced from [`agent/rules/github-flow.md`](../agent/rules/github-flow.md). **The "never merged" rule is currently policy-only** — branch protection on `main` does not key off the `artifact-review` label, so a labeled PR satisfying `validate` could be squash-merged by accident. Phase 2 must add a label-gated enforcement mechanism (required status check failing on `artifact-review`, or a repo ruleset / CODEOWNERS entry refusing merge of label-carrying PRs).
- **Convention drift risk**: if a future extension or tool implements its own block-typing vocabulary, the §1 grammar fragments. Mitigation: when a follow-up implementation issue lands (Option 7 tool, Option 1 panel), the implementation MUST consume the §1 convention as authored here, not a parallel vocabulary.

## More Information

### Resolved design decisions

1. **Predicted-body-size heuristic.** Tier selection requires the orchestrator to predict artifact body size *before* writing. Heuristic: outline + count-sections × average-section-size; **±15% tolerance**; **when uncertain at a tier boundary, default UP not DOWN**; if a Tier-1 or Tier-2 artifact crosses its upper boundary at write time, **promote mid-flight without re-asking the user** (consistent with err-on-larger principle in § Tiered transport ladder).
2. **ID stability across regenerations.** Block IDs (`cN, rN, aN, …`) remain stable when the underlying block is unchanged across versions, and renumber only on insertion/deletion (which the changelog records). Implementation: the orchestrator hashes block content and maintains an `<id> → hash` map per artifact; on regeneration, unchanged-hash blocks keep their ID, new blocks get the next free ordinal, deleted IDs are not reused within an artifact's lifetime.
3. **`.archive/` retention.** On artifact convergence, move `drafts/<topic>.md` and any retained `.v<N>.md` snapshots to `drafts/.archive/<YYYY-MM-DD>-<topic>.md`. Retention: **3 days**. Sweep cadence: session-startup-triggered, pruning entries older than 3 days at the start of every interactive session. Both `drafts/` and `drafts/.archive/` are gitignored.
4. **Promote-from-draft mechanics.** When an artifact converges (user accepts), the orchestrator strips review-only scaffolding (`<!-- block:* -->`, `<!-- review:* -->`, `parent`/`prior`/`attention_count`/`summary_ratio` frontmatter fields, `## Changes since vN` sections) before promoting the file to its final destination. Initial implementation: **orchestrator discipline** — no helper script. A `scripts/promote-draft.sh` helper is filed only if drift is observed in practice.

### Implementation sequencing

- **This PR (ADR landing):** Adds `.gitignore` entry for `drafts/`; commits this ADR; amends [`agent/rules/github-flow.md`](../agent/rules/github-flow.md) to cite the Tier 3 carve-out; files follow-up issue for the Option 7 `artifact_review` tool implementation.
- **Phase 2 — Option 7 (follow-up issue, post-ADR-merge):** Build `artifact_review` registered tool per `pi-agent-expert` § 3 (~150 LOC, S-tier). Lives in a new `agent/extensions/artifact-handoff/` extension. Includes the secrets-guard smoke test.
- **Phase 3 — Option 1 (deferred):** Custom side-panel TUI extension. Open follow-up issue only after Phase 2 has shipped and real usage shows per-block accept/reject is the next bottleneck.

### Cross-references

- Tracking issue: #67
- Related ADRs: [ADR-0001](0001-subagent-orchestration-substrate.md) (orchestration substrate — this ADR adds a UX layer above), [ADR-0002](0002-agent-to-agent-channel.md) (agent-to-agent channel — independent), [ADR-0004](0004-consensus-by-replication.md) (consensus-by-replication — the aggregation rule that produced the unanimous Tier-2 default)
- Related rules: [`agent/rules/subagent-parallel-handoff.md`](../agent/rules/subagent-parallel-handoff.md) (Form A `REPORT_FILE:` — closest existing file-handoff precedent; not retrofitted, see § Scope), [`agent/rules/github-flow.md`](../agent/rules/github-flow.md) (squash-merge-to-`main`; receives Tier 3 carve-out)
- Adjacent issue: #46 — motivating moment

**Provenance.** Drafted from a 4-way subagent fan-out (`pi-agent-expert` + `gh-cli-expert` + `gitflow-expert` + `docs-expert`) issued in a single `subagent` `tasks:[...]` call. Convergence was unanimous on Option 6 as primary transport; the §1 convention is `docs-expert`'s contribution adopted verbatim; tiering is the orchestrator-side synthesis; Options 7 and 8 are credited singleton novel contributions per [`agent/rules/consensus-by-replication.md`](../agent/rules/consensus-by-replication.md) ladder.
