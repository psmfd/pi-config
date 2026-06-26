---
description: When forming an implementation plan, enumerate documentation-impact alongside code/config impact and classify each affected doc surface in-scope, out-of-scope-but-tracked, or not-a-thing — before any file modifications
---

# Documentation in Plan

When forming an implementation plan, **the plan must enumerate every documentation surface the change implies and classify each one** before any code or configuration changes are made. This rule is a sub-rule of `plan-before-code.md` governing the doc-sync analysis that becomes part of every plan; as a refinement of an existing rule rather than a new architectural decision, it is exempt from `adr-required.md` under the pattern-following-addition carve-out.

Companion to #122. Sibling to `file-issues-first.md` — the same plan-time, three-way-classification shape applied to the doc-sync axis instead of the issue-tracker axis.

## Problem

The `post-implementation-review.md` rule defines a per-task gate that requires updating documentation sync pairs (skill ↔ README/AGENTS.md, agent wrapper ↔ AGENTS.md catalog, ADR ↔ README architecture-decisions list, and so on). The gate is correct as a compliance check — but it triggers too late. By the time the per-task gate runs, the implementer has already framed the work as "the code change" with documentation as appendix. Symptoms observed in this repo:

- Plans that enumerate code/config files but omit the README rows / AGENTS.md inlines / ADR cross-refs the change requires.
- Doc updates discovered at PR-review time as "oh right, AGENTS.md" follow-up commits.
- Mismatches between the agent catalog and reality when `scripts/regen-agent-catalog.sh` is forgotten until `scripts/validate.sh` complains.
- ADR-eligible decisions surfaced *during* implementation that should have been an explicit plan artifact.
- Multi-edit batches that atomically fail mid-PR, leaving the code right but the cross-links wrong, only discovered when a downstream PR tries to flip them — see the Worked Example.

The forcing function in `file-issues-first.md` solves the analogous problem on the issue-tracker axis: surface follow-up scope at planning time, classify it, and require the classification to be explicit before any file modifications. This rule applies the same forcing function to the documentation axis.

## When This Rule Applies

- Implementation tasks that touch any surface enumerated in the doc-sync map in `post-implementation-review.md` (skills, agent wrappers, prompts, rules, vendored extensions, ADRs, `setup.sh`).
- Implementation tasks that introduce, modify, or remove a convention, pattern, or architectural decision (the `adr-required.md` trigger). ADR-eligibility is a plan-time classification under this rule, not a discovery during implementation.
- User-facing surfaces the change implies even when not in the canonical doc-sync map: README sections, in-repo guides, ADR cross-refs, prompt-template references, the AGENTS.md Behavioral-rules table when adding or modifying a rule.
- Research tasks whose recommendations imply a documentation change (rule edits, ADR drafts, README revisions).

## What to Classify

For every documentation surface the change implies, the plan assigns exactly one of:

| Classification | Action |
|---|---|
| **In-scope** | Updated in this task. Listed as an explicit plan step or doc-impact bullet in the plan presented for approval. |
| **Out-of-scope but tracked** | Filed as a follow-up issue at plan time per `file-issues-first.md` (plan step 1, before any code), referenced by issue number in the plan. |
| **Not-a-thing** | Explicitly dropped with reasoning. Recorded in the plan or the Agent Efficacy Report so future readers see it was considered, not missed. |

The forcing function is the classification itself. Surfaced doc surfaces that are silently deferred (no plan-step, no issue, no rejection note) are a protocol violation. The same standard `file-issues-first.md` enforces on issue-filing applies here on doc-sync.

## What to Enumerate

At minimum, the plan walks the canonical doc-sync map in `post-implementation-review.md` § Per-Task Gate (the "Update documentation sync pairs" matrix) and classifies each row that the change touches. The map is the single source of truth — this rule does not restate it. If a future change adds a new doc-sync pair, the map gains a row in `post-implementation-review.md` and this rule keeps working unchanged.

Beyond the canonical map, the plan also classifies:

- **ADR-eligibility** — per `adr-required.md`. Either an ADR-drafting plan step is included (in-scope), an ADR-drafting follow-up issue is filed (out-of-scope-but-tracked), or the change is explicitly classified as pattern-following / trivial and exempt (not-a-thing). The third path is the most common; the explicit classification is the discipline.
- **README impact** — when the change touches surfaces the README mentions (Architecture Decisions list, skill table, workflows section, "Setup on a new machine" section).
- **AGENTS.md Behavioral-rules table** — when adding, modifying, or removing a rule.
- **Cross-rule links** — when the change makes another rule's body inaccurate or out-of-date (e.g. adding this very rule means `plan-before-code.md` and `file-issues-first.md` are now structurally siblings of a third member, but per this repo's precedent rules cross-link only to declared parents — not to siblings or children — so no edit is required there. The classification still happens.)

## Mechanics

- The doc-impact analysis is part of the plan presented for approval per `plan-before-code.md`. The plan-approval gate covers it alongside code/config changes — the user approves the doc-impact classifications when approving the plan as a whole.
- Where the classification triggers `file-issues-first.md` (out-of-scope-but-tracked), the issue-filing remains plan step 1 in execution order. The two rules compose: `file-issues-first.md` says *file before code*; this rule says *classify before approval*. Both must hold.
- The doc-impact section in the plan is structured as a small table (surface | classification | reason) when more than two surfaces are affected, or as a bulleted list when one or two. The shape mirrors the worked-example tables in `file-issues-first.md`.
- The per-task gate in `post-implementation-review.md` continues to enforce that the "in-scope" doc updates actually land in the same task. This rule is a plan-time pre-flight; the per-task gate is the execution-time check. They compose as a belt-and-suspenders pair.
- **Doc-impact analysis is recorded in the PR body** (Summary or a dedicated Doc-Impact section) for the same traceability reason `file-issues-first.md` requires back-linking filed issues. A reader of the merged PR can verify that every classified surface was either touched (in-scope), tracked (out-of-scope-but-tracked with issue number), or rejected (not-a-thing with reason).

## Exemptions

Mirroring `plan-before-code.md` and `file-issues-first.md`:

- **Trivial single-line fixes / typo corrections** that touch no doc-sync pair.
- **Subagents executing a parent's already-approved plan** — the parent owned the doc-impact analysis when forming the plan; the subagent inherits that approval.
- **Tier 3 review artifacts under `.review/`** persisted via `artifact_review` per ADR-0006/0007. Findings from a review that rise to "needs a doc update" go through this rule when the orchestrator turns them into a plan.
- **Documentation-only edits where the doc-impact is the entire change.** The plan still states what's changing and where, but no separate doc-impact classification is required because the change *is* the doc-impact.

## Rationale

- **Plan-time enumeration is cheap; mid-PR archaeology is expensive.** Two minutes of "what does this touch in the doc-sync map" replaces hours of "why is the catalog wrong, and which PR's atomic-edit failure caused it?"
- **Three-way classification forces commitment.** A plan cannot leave doc surfaces in a quantum superposition of "maybe AGENTS.md needs an edit." Each surface is acted on, tracked, or explicitly dropped.
- **ADR-eligibility surfaces before code instead of during.** The most expensive ADR-bug is one discovered after merge ("we should have written one"). Plan-time classification catches it cheap.
- **Composes cleanly with existing rules.** `file-issues-first.md` handles the issue-axis; this rule handles the doc-axis; `post-implementation-review.md` validates execution. Three rules, one canonical doc-sync map, no duplication.
- **Single source of truth preserved.** The doc-sync map stays in `post-implementation-review.md`. This rule references it. Adding a doc-sync pair is a one-file edit to the map; this rule keeps working.

## Worked Example

During the `wsl2-expert` work (PR #124, merged 2026-05-20), the doc-impact analysis surfaced cleanly during planning:

| Surface | Classification | Reason |
|---|---|---|
| `agent/skills/wsl2-expert/SKILL.md` | in-scope | the skill itself |
| `agent/agents/wsl2-expert.md` | in-scope | the wrapper |
| `agent/AGENTS.md` agent catalog | in-scope | regenerated via `scripts/regen-agent-catalog.sh` |
| `agent/skills/hyperv-expert/SKILL.md` cross-links | in-scope | flip 5 soft "until #121 lands" refs to firm `wsl2-expert` refs |
| `agent/agents/hyperv-expert.md` cross-link | in-scope | flip the wrapper's soft ref |
| ADR | not-a-thing | pattern-following addition (paired skill + wrapper, established by hyperv-expert and 19 prior agents) |
| README | not-a-thing | README references `agent/rules/` and `agent/skills/` by directory only, no per-skill or per-agent rows |

The plan-time enumeration would also have caught the earlier incident on PR #123: a fixup commit on `feat/hyperv-expert` softened 5 forward references to `wsl2-expert` (then-unbuilt). The fixup was a single multi-edit `edit` call against `agent/skills/hyperv-expert/SKILL.md`. One of the five edits had a stale `oldText` and the call failed atomically — but the *commit message* asserted all five had been softened. Only 1 of 5 (the wrapper edit, which was a separate `edit` call) actually applied. The drift was discovered in PR #124 mid-flight when the doc-impact section in *its* plan tried to flip the soft refs and found 4 of them were already firm.

What the new rule contributes there:

- The PR #123 plan's doc-impact section would have listed the 5 cross-link surfaces explicitly. After the fixup commit, a per-task-gate verification step ("each in-scope surface actually changed") would have run `git diff` against the listed surfaces and caught the atomic-edit failure before the commit message went out.
- The PR #124 plan's doc-impact section did list the cross-link flip as in-scope, but framed it as "flip 5 soft refs" rather than as a verified-against-current-state list. The mid-PR archaeology was three minutes wasted; with a more explicit "what does main currently say at each cross-link site" pre-flight (a natural extension of plan-time enumeration), the work would have been "verify and flip, expecting 4 already-firm" from the start.

The forcing function — *enumerate the surfaces explicitly, classify each, verify post-execution* — converts both classes of drift into noise the planning step naturally absorbs.

## Anti-Patterns

- **"I'll regenerate the catalog before pushing."** That's a plan step that should be listed, not an unstated implementer assumption. Listing it is the rule.
- **"The README probably needs an update too, I'll figure it out at PR time."** No. Classify it now: in-scope (list the section), out-of-scope-but-tracked (file the issue), or not-a-thing (state why).
- **"This is too small to need a doc-impact section."** If the change touches no doc-sync pair, the plan can say so in one bullet ("doc-impact: none — change is internal to `<component>`"). The forcing function is the explicit statement, not the section length.
- **"ADR-eligibility is something we'll know if we hit it."** The rule is the inverse: ADR-eligibility is a plan-time classification. State the conclusion ("not-a-thing — pattern-following addition") so a reviewer can disagree before code is written.
- **Restating the doc-sync map inside the plan instead of referencing it.** The map lives in `post-implementation-review.md`. The plan's doc-impact section names the surfaces it touches and classifies each; it does not restate the matrix.
- **Blanket `not-a-thing` across every surface to avoid the doc-impact work.** The classification is per-surface with surface-specific reasoning. A wall of `not-a-thing` with the same generic reason on every row is the failure mode this rule is designed to surface, not satisfy. Each `not-a-thing` row must answer the specific question "why does *this* surface not need an update for *this* change." Reviewers should challenge generic-reason `not-a-thing` rows in PR body doc-impact tables.
