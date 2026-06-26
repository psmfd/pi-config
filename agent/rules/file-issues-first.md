---
description: When planning surfaces a work item that should exist as an issue, file it as the first step of The Plan before any code changes
---

# File Issues First

When forming an implementation plan, if a work item is identified that should exist as an issue — in this repo or any other — **filing that issue is the first action executed in The Plan**, before any code or configuration changes. This rule is a sub-rule of `plan-before-code.md` governing how plans get formed when follow-up scope surfaces; as a refinement of an existing rule rather than a new architectural decision, it is exempt from `adr-required.md` under the pattern-following-addition carve-out.

Companion to #100.

## Problem

During task execution, new work surfaces routinely: follow-up issues for deferred scope, upstream issues against the pi monorepo or vendored extensions, downstream issues against consuming repos, bugs discovered tangentially while doing other work, and tech-debt items the current PR explicitly punts on. Without a discipline, these items get mentioned in commit messages, PR bodies, or chat — and frequently get lost between the moment they are identified and the moment the current work lands. By the time the PR merges, the context for filing a crisp follow-up has decayed and the item silently drops.

## When This Rule Applies

- Implementation tasks where planning identifies scope that will not land in the current PR.
- Research tasks whose recommendations include actionable follow-ups (file upstream feature requests, file ADR-drafting issues, file deprecation-of-X issues).
- Cross-repo concerns surfaced by a subagent (per `orchestrator-protocol.md` § Sub-Agent Obligations) that the orchestrator decides are real and out-of-scope.
- Bugs and tech debt observed in passing while working on something else.

## What to File

Three-way classification at planning time. Each surfaced item gets exactly one of:

| Classification | Action |
|---|---|
| **In-scope** | Do it now as part of the current task. No issue needed; it lives as a plan step. |
| **Out-of-scope but tracked** | File an issue as plan step 1 (or steps 1..N if multiple). Subsequent plan steps reference the resulting issue numbers as stable handles. |
| **Not-a-thing** | Explicitly drop with reasoning. Record the rejection in the plan or the Agent Efficacy Report so future readers see it was considered, not missed. |

The forcing function is the classification itself. Surfaced items that are silently deferred (no issue, no rejection note) are a protocol violation.

## Mechanics

- The `gh issue create` invocations happen **before** any `edit`, `write`, branch creation, or commit. They are plan step 1.
- Plan approval per `plan-before-code.md` still gates execution: the plan presented for approval **includes** the issue-filing steps with their proposed titles, labels, and target repos. Approval covers step 1 alongside everything else. This rule sequences filing first within an approved plan; it does not bypass approval.
- Each filed issue gets the labels appropriate to its scope (per existing repo label conventions).
- If the item targets an upstream repo, `gh issue create --repo <owner>/<repo>` is used; surface the resulting URL in the plan for traceability.
- Subsequent plan steps reference the issue numbers as stable handles ("defer X to #NNN", "unblocks #MMM", "tracked in `<upstream-url>`").
- Commit messages and PR bodies for the current work then link the filed issues naturally, with no "TODO: file an issue later" placeholders.
- **Back-link from the current work to every issue filed under this rule.** The PR body, commit messages, or both must reference the filed issue numbers/URLs. An issue filed but never back-linked defeats the cross-linking rationale.
- **File with enough context to act on later.** A one-line title with no body is not a tracked item — it is a deferred archaeology assignment. Bodies should capture the problem, the proposed direction, and any links to the work that surfaced it.

## Exemptions

- **Micro-todos within the current PR's scope.** A two-line follow-up edit needed in the same file in the same commit is a plan step, not an issue. The bar is "will this leave the current PR open as work?" — if no, plan step; if yes, file.
- **Tier 3 review artifacts under `.review/`.** Findings persisted via `artifact_review` per ADR-0006/0007 use the artifact channel, not the issue tracker. Items from a review that rise to "needs its own work item" still go through this rule and get filed as issues.

(Subagent-internal observations that the orchestrator decides are not real are not an exemption — they are a direct application of the "Not-a-thing" branch of the three-way classification above. Document the rejection in the plan or the Agent Efficacy Report; do not file an issue.)

## Rationale

- **Filing is cheap; recovering lost context is expensive.** Two minutes at planning time replaces hours of archaeology later.
- **Issue numbers become stable handles before the PR is written.** Cross-linking commit messages, PR bodies, and ADRs becomes natural rather than retrofitted.
- **Forces commitment.** The three-way classification means the orchestrator cannot leave surfaced scope in a quantum superposition of "maybe later." Each item is either acted on, tracked, or explicitly dropped.
- **Compounds across sessions.** Every issue filed under this rule is a context-recovery anchor for the next session that picks up the area.

## Worked Example

During work on the pi-binary-vendoring assessment (research round preceding #103), the orchestrator identified that upstream `earendil-works/pi-mono` releases ship per-platform binaries but no `SHA256SUMS` asset. The recommendation under this rule:

1. **Plan step 1:** File an upstream issue against `earendil-works/pi-mono` requesting a `SHA256SUMS` asset on releases. (Out-of-scope-but-tracked — we cannot land it ourselves; upstream owns it.)
2. **Plan step 2:** Draft ADR-0009 capturing the binary-pin-and-fetch decision.
3. **Plan step 3+:** Implement `fetch_pi_binary()` with self-computed checksums until the upstream SHA256SUMS lands.

Filing the upstream request as step 1 means our ADR can reference the open upstream issue ("we compute checksums ourselves pending `<upstream-url>`"), and a future bump audit can trivially check whether upstream now ships the file and the workaround can be removed.

## Anti-Patterns

- **"I'll file it after this PR lands."** No. The next thing that happens after the PR lands is the next task, which will surface its own follow-ups, which will also be deferred. File now.
- **"It's small, I'll just leave a TODO in the code."** Code-level TODOs are not a tracking mechanism. They are unsearchable across repos, unprioritizable, and invisible to anyone not reading the specific file.
- **"It belongs upstream, so it's not our problem to file."** It is exactly our problem to file. Upstream issues we never raise are upstream fixes we never get.
- **Filing speculative issues for items the orchestrator has not committed to as real.** The three-way classification exists to prevent this. If an item is "not-a-thing," document the rejection; do not file an issue to defer the decision.
