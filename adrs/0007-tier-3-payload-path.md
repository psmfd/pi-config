---
status: Accepted
date: 2026-05-19
---

# ADR-0007: Tier 3 payload path — `.review/` tracked directory on feature branch

**Status:** Accepted
**Date:** 2026-05-19
**Resolves deferred sub-decision in:** [ADR-0006](0006-artifact-handoff-and-review-format.md) § Tiered transport ladder, Tier 3 row
**Tracking issue:** #88 (sub-task #88a)
**Supersedes:** *(none — resolves a deferred decision; does not modify ADR-0006)*

## Contents

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [Why `.review/` (dotted) rather than `artifacts/`](#why-review-dotted-rather-than-artifacts)
  - [Why Option 1 over the other four](#why-option-1-over-the-other-four)
  - [How Option 1 satisfies each constraint](#how-option-1-satisfies-each-constraint)
- [Consequences](#consequences)
- [Out of scope](#out-of-scope)
- [More Information](#more-information)

## Context and Problem Statement

[ADR-0006](0006-artifact-handoff-and-review-format.md) (landed in PR #87) defined a 5-tier transport ladder for orchestrator→user review artifacts. The Tier 3 row reads:

> Draft PR on `pi_config` with `artifact-review` **label**; payload location is non-gitignored and resolved in Phase 2 (the `drafts/` directory is gitignored and therefore **not** the Tier 3 payload path — `git add -f` is explicitly disallowed); never merged — `gh pr close --delete-branch` on convergence.

(Quoted verbatim from ADR-0006 line 57; the same row is the source of every constraint enumerated below.)

That row explicitly deferred the choice of *where on disk* the Tier 3 payload lives. This ADR records that choice as the first Phase 2 deliverable of issue #88. The decision is a pre-requisite for:

- **#88 item 1**: the `artifact_review` registered tool's `Write` call needs a target path.
- **#88 item 3**: the label-gated branch-protection enforcement needs to know which paths the guard is protecting.
- **#88 item 4**: the secrets-guard scan-scope smoke test must assert that the chosen path is covered.

### Constraints (all binding, inherited from ADR-0006)

1. **Non-gitignored.** The payload must be reachable by `git add` without `-f`.
2. **`git add -f` disallowed.** Cannot launder a gitignored path onto a branch.
3. **Never merged to `main`.** The path's contents are review-time scaffolding only.
4. **Line-anchored review must work.** The whole reason Tier 3 exists as a tier (vs. the cheaper Tier 2) is to access GitHub's per-line review comments on a unified diff. Any option that defeats that defeats the tier.
5. **§1 convention compatibility.** The artifact carries `<!-- block:* id=cN -->` and `<!-- review:* id=aN -->` sentinels; reviewers must be able to anchor comments onto specific blocks.
6. **Clean cleanup.** `gh pr close --delete-branch` should remove both the PR and the payload in one operator action.

## Considered Options

A 3-way subagent fan-out (`pi-agent-expert` + `gh-cli-expert` + `docs-expert`, parallel, one `tasks: [...]` call per [`agent/rules/consensus-by-replication.md`](../agent/rules/consensus-by-replication.md)) evaluated the following:

### Option 1 — `.review/<topic>.md` tracked directory on feature branch

A new top-level `.review/` directory whose contents are committed on the feature branch only, never merged. Cleanup via `gh pr close --delete-branch`.

### Option 2 — `drafts/` on sidecar branch with per-branch `.gitignore` relaxation

Mutate `.gitignore` on the feature branch to un-ignore `drafts/`, then commit the payload to `drafts/`. Branch never merged.

### Option 3 — GitHub Gist

`gh gist create payload.md` produces a URL; the PR body references it. Payload never enters `pi_config`.

### Option 4 — `git notes` namespace

Attach the payload to the PR's head commit via `refs/notes/artifact-review`.

### Option 5 — PR comment body

Post the artifact as a single comment on the draft PR (not the PR description).

## Decision Outcome

**Adopt Option 1**, with the concrete path `.review/<topic>.md` (dot-prefix). The fan-out was unanimous (3/3 PASS_WITH_WARNINGS) for this option.

### Why `.review/` (dotted) rather than `artifacts/`

`artifacts/` is a common convention for CI build output and release tarballs; reserving `.review/` (dot-prefix, signaling tooling-managed not product code) avoids future collision and signals review-time-only intent at a glance. `pi-agent-expert` and `docs-expert` independently surfaced this naming concern.

### Why Option 1 over the other four

| Option | Disqualifying concern |
|---|---|
| 2 — sidecar + `.gitignore` relaxation | Moral violation of ADR-0006's `git add -f` ban; one accidental squash-merge pollutes `main`; `.gitignore` mutation appears as PR-body noise unrelated to the artifact. |
| 3 — Gist | Payload never appears in PR diff → defeats line-anchored review (constraint 4). Two-step cleanup (`gh pr close` + `gh gist delete`) invites orphans. Off-repo retention/access envelope invites a parallel comment vocabulary (constraint 5 / ADR-0006 § Consequences "convention drift risk"). |
| 4 — `git notes` | GitHub UI does not render notes; `git fetch` doesn't pull `refs/notes/*` by default; reviewer opens PR and sees nothing. No line-anchored review affordance. `gh` has no notes surface. |
| 5 — PR comment | GitHub permits per-line review comments only on diffs, not on issue/PR comment bodies — defeats constraint 4. Comment-edit history collapses iteration into the "edited" dropdown rather than git history. |

Option 1 is the only candidate that satisfies all six constraints simultaneously.

### How Option 1 satisfies each constraint

| Constraint | Mechanism |
|---|---|
| Non-gitignored | `.gitignore` is silent on `.review/`; no entry to add, no `-f` needed. |
| `git add -f` disallowed | `git add .review/<topic>.md` succeeds because the path is not ignored. |
| Never merged to `main` | Coupled label-gated CI guard (see § Coupled deliverables) fails any merge attempt of a PR carrying the `artifact-review` label. |
| Line-anchored review works | The file appears in the PR's "Files changed" tab; GitHub's per-line review UI anchors comments natively onto `<!-- block:* id=cN -->` sentinels. |
| §1 convention compatibility | Same as above — block sentinels become load-bearing anchor points, not ornamental. |
| Clean cleanup | `gh pr close <n> --delete-branch` removes the branch and the only ref carrying the payload; blob becomes unreachable and garbage-collected. |

## Consequences

### Positive

- **Line-anchored review works natively.** No reviewer-side configuration; the PR opens in the "Files changed" tab with the artifact rendered as a diff.
- **Secrets-guard inherits coverage automatically.** `pi-agent-expert` verified against `agent/extensions/secrets-guard/index.ts` that the extension's `tool_call` handler intercepts `Write` to any path (no path-prefix allowlist) and `.review/` does not appear in `SKIP_PATH_GLOBS`. No parallel guard registration is needed — pi's built-in `Write` tool is what the `artifact_review` registered tool will invoke.
- **6-month-archaeology citation.** Even after `gh pr close --delete-branch`, GitHub's `refs/pull/N/head` preserves the commit; future ADRs can cite `github.com/psmfd/pi-config/blob/<sha>/.review/<topic>.md` as a stable URL.
- **Convention containment.** Artifact flows through the standard repo review surface, so no parallel vocabulary (gist comments, notes tooling, comment-only threads) can emerge to fragment the §1 grammar.

### Negative

- **Adds a new top-level repo directory whose contents are designed never to merge.** Mitigated by the coupled deliverables below; without them, `.review/` is a vector for accidentally merging review scaffolding into `main`.
- **`pipefail`-equivalent semantic surface area expands.** The `artifact_review` tool must orchestrate `Write` → `git add` → `git commit` → `git push` → `gh pr create` → `gh pr edit --add-label`. Each step is idempotent and observable but the chain is non-atomic. No new race vs. status quo; flagged for the Phase 2 implementation to handle stderr from each `pi.exec` call.

### Coupled deliverables (#88b — must ship in one PR)

All three reviewers issued the **same load-bearing warning**: `.review/` adoption MUST ship in the same PR as the label-gated merge guard, or the new tracked directory is a foot-loaded gun. The PR that adopts this ADR's path must include, atomically:

1. **`.review/` directory** created with a marker file (e.g. `.review/README.md` describing the Tier 3 contract and pointing back to this ADR).
2. **`.github/workflows/artifact-review-guard.yml`** — workflow that fails when the `artifact-review` label is present on a PR targeting `main`. Per `gh-cli-expert`'s analysis:

   ```yaml
   # .github/workflows/artifact-review-guard.yml
   on: pull_request
   jobs:
     block-artifact-review-merge:
       if: contains(github.event.pull_request.labels.*.name, 'artifact-review')
       runs-on: ubuntu-latest
       steps:
         - run: |
             echo "::error::PRs labeled 'artifact-review' must not be merged (Tier 3 ADR-0006/ADR-0007)."
             exit 1
   ```

3. **Branch protection update** on `main` adding the workflow's job as a required status check.
4. **CODEOWNERS entry** on `.review/**` (belt-and-suspenders per `docs-expert`) routing review through a path that will reject any non-draft / non-`artifact-review`-labeled PR touching the directory.
5. **`agent/rules/github-flow.md` cross-reference** to ADR-0007 alongside the existing ADR-0006 carve-out citation.

The `artifact_review` registered tool implementation (#88 item 1) and secrets-guard smoke test (#88 item 4) are **out of scope for #88b** and remain for a third Phase 2 PR (#88c).

## Out of scope

This ADR records the Tier 3 payload-path decision only. It does **not** change:

- **Tier 0/1/2 transport.** Inline rendering, `renderResult`, and the Tier 2 disk-path mechanism remain exactly as ADR-0006 specifies.
- **`drafts/` directory disposition.** Stays gitignored; remains the drafting/working-artifact area per ADR-0006 § Consequences. Tier 3 payloads live at `.review/`, not `drafts/`.
- **`agent/extensions/secrets-guard/index.ts` `SKIP_PATH_GLOBS`.** Not modified; the regression-resistant smoke-test commitment from ADR-0006 § Consequences remains binding and will be discharged by #88c.
- **Form A `REPORT_FILE:` pattern** in [`agent/rules/subagent-parallel-handoff.md`](../agent/rules/subagent-parallel-handoff.md). ADR-0006 § Scope explicitly defers any retrofit to a future amendment; this ADR does not broaden that scope.
- **The 5-tier ladder itself.** Tier counts, thresholds, and opt-in semantics are unchanged from ADR-0006 § Tiered transport ladder.

## More Information

### Provenance

- 3-way subagent fan-out (parallel, one `tasks: [...]` call) per [`agent/rules/consensus-by-replication.md`](../agent/rules/consensus-by-replication.md):
  - `pi-agent-expert` (pi-internals lens): verified `Write` semantics, secrets-guard coverage by reading `agent/extensions/secrets-guard/index.ts`; verdict PASS_WITH_WARNINGS
  - `gh-cli-expert` (GitHub-mechanics lens): produced the CI guard YAML and the operator runbook; verdict PASS_WITH_WARNINGS
  - `docs-expert` (discoverability/audit lens): identified `refs/pull/N/head` archaeology durability and the CODEOWNERS belt-and-suspenders; verdict PASS_WITH_WARNINGS
- Aggregate verdict (most-severe-wins): **PASS_WITH_WARNINGS**.
- Per [`agent/rules/consensus-by-replication.md`](../agent/rules/consensus-by-replication.md) aggregation ladder: **unanimous → adopt** (no orchestrator override needed).
- Singleton novel contributions credited per [ADR-0004](0004-consensus-by-replication.md):
  - `gh-cli-expert`: ready-to-ship workflow YAML for the coupled CI guard
  - `docs-expert`: `refs/pull/N/head` survival mechanism + CODEOWNERS belt-and-suspenders
  - `pi-agent-expert`: secrets-guard hands-free coverage verification

### Cross-references

- Parent ADR: [ADR-0006](0006-artifact-handoff-and-review-format.md) (this ADR resolves its Tier 3 deferred sub-decision; does not supersede)
- Issue: #88 — Phase 2 implementation umbrella; this ADR is sub-task #88a
- Related rules: [`agent/rules/github-flow.md`](../agent/rules/github-flow.md) (Tier 3 carve-out from squash-merge-to-`main`; #88b will add ADR-0007 cross-ref alongside the existing ADR-0006 cite)
- Convention: [`agent/rules/adr-required.md`](../agent/rules/adr-required.md) — supersession-not-editing; this ADR resolves a deferred decision rather than amending ADR-0006 inline.
