---
status: Accepted
date: 2026-08-13
---

# ADR-0138: Patch-train and fork policy for psmfd/pi — corrected retirement mechanism, reconciled caps, and bounded S-class scope

**Status:** Accepted — 2026-08-13.

**Supersedes:** [ADR-0136](0136-patch-train-and-fork-policy.md) (same day). ADR-0136's two-class model, soak bar, fork triggers, sorting principle, first-generation candidates, and spawn-seam requirement are carried forward; this ADR corrects defects a five-agent review found in it. **Transitively supersedes** [ADR-0041](0041-conditional-security-patch-divergence.md), which ADR-0136 superseded.

**Related:** [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md), [ADR-0039](0039-mirror-sync-cadence-and-provenance.md) (the merge mechanics this ADR reconciles with), [ADR-0040](0040-consume-psmfd-attested-pi-releases.md), [ADR-0043](0043-upstream-reporting-gate.md), [`docs/psmfd-pi-mirror-sync.md`](../docs/psmfd-pi-mirror-sync.md), [`notes/curated-feature-plan.md`](../notes/curated-feature-plan.md) § Track 2. Mirror-side schema: #982, public counterpart [psmfd/pi#53](https://github.com/psmfd/pi/issues/53).

## Context and Problem Statement

ADR-0136 was reviewed the day it merged by five independent agents (requirement-fidelity, security, shell-mechanics, git/release-workflow, and documentation lenses). The review confirmed its substance — the two-class model is sound, ADR-0041's condition 2 genuinely forbade the capability work, and nothing in it weakens ADR-0038's attestation chain or ADR-0039's sync evidence. It also found defects serious enough that leaving them in an Accepted policy is a hazard rather than an untidiness.

Superseding rather than editing follows `agent/rules/adr-required.md`. ADR-0136 stays readable as the record of what was decided and what was wrong with it.

### Defect 1 — the retirement mechanism was named after an operation the mirror forbids

ADR-0136 line 38 described retirement as "**Rebase-drop** of the `PSMFD-Patch` commit," and line 129 asserted "every sync rebases the train." Both inherit ADR-0041's wording. Both contradict the mirror's governing merge rule ([`docs/psmfd-pi-mirror-sync.md`](../docs/psmfd-pi-mirror-sync.md) § "Sync procedure"):

> Merge mechanics are fixed: **always `--no-ff` merge, never rebase, never fast-forward.** PSMFD overlay commits sit above the seed; rebasing them would rewrite their SHAs and break every existing reference.

The mechanism actually exercised twice is **not** a rebase. It is a merge-time allowlist drop: the maintainer's retirement decision lands between `merge` and `resolve`, and dropping the path from `.psmfd/overlay-allowlist.txt` flips that path's deterministic resolution from `--ours` to `--theirs`, so the next `--no-ff` sync merge takes upstream's version. The `PSMFD-Patch` commit's SHA is never rewritten and never leaves the history; only the file content reverts.

This is not cosmetic. #982 and [psmfd/pi#53](https://github.com/psmfd/pi/issues/53) commission a `psmfd-patch-integrity` check, and an implementer reading only the ADR had textual licence to implement literal `git rebase` — precisely the operation ADR-0039 says breaks every existing reference.

### Defect 2 — the first generation did not fit the cap

ADR-0136 set the active C-class cap at **≤ 4**, justified as "one generation of capability work," while its own first-generation table enumerated **six** candidates (a)–(f). Item (e) is conditional, leaving **five** non-optional. The policy's own worked example overflowed its own cap, and the ADR never reconciled it.

### Defect 3 — S-class was cap-exempt with no scope bound

Both the requirement-fidelity and security reviewers independently reached this. ADR-0136 exempted S-class from the caps (correctly — a security finding must not wait because the train is full) but bounded the *classification* without bounding the *diff*. Condition 2 anchors a patch to a real CodeQL alert or CVE, which resists casual mislabelling, but nothing required the patch's contents to be proportionate to the cited finding, and the same person proposes and adjudicates. Capability work could ride along inside a genuinely-security-classified commit and obtain an uncapped, unsoaked slot.

### Defect 4 — the blanket `--ours` rule accrues unmeasured drift debt on long-lived patches

`git checkout --ours -- <path>` takes the **whole file** from the local side, not the conflicting hunks. For S-class that is proportionate: patches are narrow and self-retiring within a sync cycle or two. For a C-class patch that may touch up to 25 files and persists until upstream *adoption*, every hunk-level conflict silently discards all of upstream's other changes to that file — bug fixes and refactors included — and this can repeat sync after sync. None of ADR-0136's three caps measures it: they bound the patch's own footprint, not the foregone-upstream debt accumulating on the files it touches.

### Defect 5 — several criteria were not adjudicable

- **"Functional rework"** (the rebases-survived conjunct) was undefined as to whether a sync requiring it *fails to count* or *resets the counter to zero*.
- **"Exceeding caps for 2 consecutive syncs"** as a fork trigger is logically inconsistent with "cap breach is a stop, not a warning": if a breach blocks the sync until resolved, a second consecutive breach cannot occur under the stated mechanism.
- **"Net changed lines ≤ 2000"** named no baseline, no definition of "net" (insertions − deletions, or gross diff), and no command to produce the number.
- **Soak evidence** had no recording artifact. "≥ 3 syncs with no functional rework" is a claim needing a contemporaneous receipt; ADR-0136 defined none, leaving graduation to retrospective reconstruction — the exact memory-dependence its own soak bar exists to eliminate.

### Defect 6 — carried-forward text lost operational detail

ADR-0136 claimed ADR-0041's conditions were carried "verbatim in substance" but dropped two operationalizations that determine how they are applied, and omitted ADR-0041's disclosure sequencing entirely.

## Decision Outcome

Everything in ADR-0136 stands except as corrected below. For the unchanged material — the two-class model, the four-conjunct soak bar, the mechanism-sinks sorting principle, the first-generation candidates (a)–(f) and their payloads, the dual-consumer spawn-seam requirement, the explicit non-candidate list, and the generation mechanism — read ADR-0136; this ADR does not restate it.

### 1. Retirement is a merge-time allowlist drop, never a rebase

**Both classes retire the same way.** On the sync that carries the retirement trigger, the maintainer drops the patched path(s) from `.psmfd/overlay-allowlist.txt` and from `SECURITY_PATCH_PATHS` in `psmfd-zero-divergence.yml` *between* the `merge` and `resolve` steps. That flips the path's deterministic resolution to `--theirs`, so the merge takes upstream's version. The manifest entry is set `status: retired` with the class-appropriate retirement field. The `PSMFD-Patch` commit is **not** rewritten, dropped, or rebased — it remains in history as the audit record.

The term "rebase-drop" is retired from this policy. `--no-ff` merge, never rebase, never fast-forward (ADR-0039) is unconditional and admits no exception for retirement.

### 2. Caps, reconciled with the first generation

| Cap | Limit | Basis |
| --- | --- | --- |
| Active C-class patches | **≤ 6** | The first generation is five non-optional candidates plus one conditional (item (e)); a cap below that makes the ADR's own worked example unsatisfiable. Six is that generation, not a licence to grow — the *count* is not the binding constraint, the two below are |
| Net changed lines, all active C-class | **≤ 2000** | A bound the maintainer can re-read during a conflicted sync |
| Distinct upstream files touched, all active C-class | **≤ 25** | Each touched file is an allowlist entry the zero-divergence guard stops protecting |

**"Net changed lines" is defined** as the sum, over active C-class patches, of `git diff --shortstat` insertions plus deletions between the patch's `upstream_base` tree and mirror `main` restricted to that patch's `patched_paths`. Insertions **plus** deletions, not the difference: a patch that deletes 1900 lines is not free. The number is recomputed at each sync against the current base, not carried from patch-authoring time.

**If the caps bind before the first generation lands, that is the policy working.** The correct responses are, in order: upstream a soaked patch, drop a candidate, or take the fork decision — never raise the cap silently.

### 3. S-class is cap-exempt but scope-bound

S-class remains exempt from all three caps: a security finding is never deferred because the train is full. It gains a proportionality condition, as a sixth S-class condition:

> **S6 — proportionate scope.** An S-class patch contains only the changes the cited finding requires, plus its regression test. Any change not traceable to the advisory or alert is C-class work and is subject to the caps and the soak bar, in a separate patch with its own manifest entry.

Because proposer and adjudicator are the same person on a solo-maintained train, the control is **evidentiary rather than procedural**: the manifest's `evidence` field must state, for each S-class patch, why every patched path is required by the finding. A path that cannot be justified that way does not belong in the patch. This is not a strong control — it is an honest one, and it converts a silent judgement into a written claim reviewable against the diff.

### 4. Drift debt on C-class paths is recorded, not capped

A fourth numeric cap is deliberately **not** added. The quantity — upstream changes foregone by whole-file `--ours` resolution — is not measurable at the moment the caps are checked without reconstructing what a hunk-level merge would have produced, and inventing a number for it would repeat the error ADR-0136 made in calibrating C-class caps against S-class evidence.

Instead: **whenever a sync resolves a conflict `--ours` on a C-class path, the sync evidence block records the path and the upstream diff that was discarded** (`git diff <ours> <theirs> -- <path>`). This makes the debt visible at the moment it is incurred, accumulates a reviewable record per path, and gives the eventual `psmfd-patch-integrity` check something concrete to report on. A path accruing repeated discards is a signal the patch should be upstreamed or dropped; treat it as an input to the fork triggers, not a separate trigger.

### 5. Adjudicable criteria

- **Functional rework** is any change to an extension's behaviour, interface, or control flow made in response to an upstream sync. Renames, import-path updates, type-signature adjustments that alter no behaviour, and formatting are *not* functional rework. A sync requiring functional rework **resets the rebases-survived counter to zero** — the criterion measures consecutive syncs of stability, and a non-resetting count would let a patch reworked at every other sync accumulate credit indefinitely.
- **Soak evidence is recorded contemporaneously**, not reconstructed. At each sync, for every extension under soak, the sync evidence block records one line: the extension, whether it required functional rework, and if so what. Graduation reads that record. An extension with no contemporaneous record has not soaked, regardless of elapsed time.
- **The cap-breach fork trigger** is restated to remove the contradiction: a cap breach blocks the sync until resolved (unchanged), and the fork trigger fires when **the stop-and-mitigate procedure is invoked at two consecutive syncs** — i.e. the train arrived over cap twice running, regardless of how each was mitigated. It counts pre-mitigation breaches, not a persisting over-cap state.
- **Upstream stagnation** (fork trigger 1) has no monitoring today and cannot acquire any while ADR-0039 rejects scheduled syncs. Recorded as a known-weak trigger dependent on maintainer observation until the `psmfd-sync-notify.yml` workflow contemplated by ADR-0039 exists. Naming the weakness is the point; a trigger everyone believes is automatic is worse than one known to be manual.

### 6. Operational detail restored from ADR-0041

- **"No upstream fix in flight"** (S1) means: no merged upstream commit, and no open upstream PR likely to merge. Verified and recorded at patch time.
- **Routine version refreshes do not qualify** as S-class and stay on the normal Dependabot/sync path (S2).
- **Disclosure sequencing** is unchanged and restated here because the mirror is public and a patch diff discloses whatever it changes: upstream is privately notified no later than the patched release, so the public diff never precedes upstream awareness. No upstream report is filed without explicit maintainer approval (ADR-0043).

## Consequences

- **Positive.** The policy no longer licences an operation the mirror's provenance model forbids; the caps and the first generation are consistent; the S-class exemption has a written scope claim rather than an unstated one; drift debt becomes visible at the moment it is incurred; and four previously unadjudicable criteria can now be applied by someone reading the ADR cold.
- **Negative / accepted.** The active-patch cap rose from 4 to 6, which is a real widening of the guard's blind-spot surface. It is the honest number: the alternative was a cap the first generation could not satisfy, which would have been resolved in practice by quietly exceeding it. The line and file caps — the ones that actually bound conflict surface — are unchanged.
- **Negative / accepted.** S6 and the soak-evidence requirement add per-sync recording work to a solo-maintained process. Both were chosen over mechanical alternatives that do not exist yet; if the recording is not done, the criteria they support are not satisfiable, which is the intended failure direction.
- **Negative / accepted.** The `--ours` drift debt is recorded but not bounded. A determined accumulation could still degrade a file's fidelity to upstream without tripping any cap. Bounding it correctly requires hunk-level merge analysis the sync process does not perform.
- **Unchanged.** ADR-0038's build-and-attest boundary and ADR-0039's sync cadence, evidence requirements, trusted-bypass model, and never-cross list. Both patch classes remain real commits on `main`, so attested bytes continue to match a tagged source tree.
- **Follow-up.** #982 / [psmfd/pi#53](https://github.com/psmfd/pi/issues/53) must implement the manifest `class:` field against **this** ADR, not ADR-0136 — in particular the retirement semantics above, and a C-class retirement field distinct from `upstream_fixed_in`. What "upstream adoption" looks like mechanically for a capability upstream reimplemented differently remains undefined and is the hardest open question in this policy.

## Review provenance

The defects corrected here were found by a five-agent divergence fan-out over ADR-0136 and ADR-0137 (`code-review-expert`, `security-review-expert`, `shell-expert`, `gitflow-expert`, `docs-expert`) on 2026-08-13, per `agent/rules/research-parallelism.md`. Defect 1 came from the git/release-workflow lens; defect 3 was reached independently by two reviewers. One reviewer finding — that ADR-0137's test-count arithmetic was off by one — was **refuted** on verification: the counts are suite counts, and `scripts/test-github-read.sh` covers both `github-read/test` and `git-read/test`. The findings against ADR-0137 are code changes rather than policy and are tracked in #989, #990, and #991.
