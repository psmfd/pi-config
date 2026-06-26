---
status: Accepted
date: 2026-06-25
---

# ADR-0056: pi_config uses classic branch protection; the sync-mirrors `verify` gate is required

**Status:** Accepted
**Date:** 2026-06-25
**Closes:** #398 (register the sync-mirrors `verify` gate as a required check)
**Related:** [ADR-0036](0036-dev-integration-main-stable-branch-model.md) (the dev/main branch model whose enforcement this records), [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the sync engine whose `verify` job this gates on). **Follow-up:** #420 (evaluate migrating to repository rulesets).

## Context and Problem Statement

ADR-0036 defines the `dev` (integration) / `main` (stable) branch model and
states that branch protection is required, but is deliberately
**mechanism-agnostic** — it does not mandate *how* protection is enforced. Two
loose ends motivated a recorded decision:

1. **Undocumented mechanism.** `pi_config` enforces protection via **classic
   branch protection** on `dev` and `main` (`enforce_admins=true`, strict
   required status checks). It does **not** use repository rulesets
   (`GET /repos/psmfd/pi-config/rules/branches/dev` returns no rules). The
   agent-framework's global `github-flow.md` rule describes a *rulesets* model
   (`protect-dev`/`protect-main`, an inherited `enterprise-baseline`,
   framework-repo ADR-0056/0068) — but that is the **framework repo's** setup,
   not `pi_config`'s. Mapping it onto `pi_config` caused real confusion; this ADR
   records what `pi_config` actually does so the confusion does not recur.

2. **The `verify` gate was advisory.** The sync-mirrors `verify` job
   (`scripts/sync-mirror.sh --all --dry-run`, ADR-0050) fails a PR if a
   denylisted/unsanitized string would reach a public mirror — but it was not a
   required status check, so a PR with a failing `verify` could still merge
   (#398). The authoritative fail-closed gate is the `sync` job's pre-push
   verify, but the PR-time gate should also block.

A subtlety blocks a naive fix: the `verify` trigger was **path-filtered**
(`on.pull_request.paths`). GitHub keeps a *required* status check that is skipped
(because its workflow did not trigger) in a perpetual "expected" state, which
**blocks the PR from merging**. Marking a path-filtered check required therefore
breaks every PR that does not touch a listed path (e.g. a `LICENSE`-only PR).

## Considered Options

1. **Mark `verify` required as-is (path-filtered).** Rejected: blocks any PR that
   does not touch a filtered path — a footgun.
2. **Make `verify` always run on protected-branch PRs, then mark it required.**
   Chosen. Change the trigger from `paths:` to `branches: [dev, main]`; the
   dry-run is ~10s and staging-only, so always-on is cheap and strictly more
   protective (it also catches a leak introduced via an unlisted path).
3. **Migrate `pi_config` to repository rulesets and configure the gate there.**
   Deferred to #420 — a larger decision with thin payoff here (admins are
   already covered by `enforce_admins`; merge methods are constrained
   repo-wide). Not required to make the gate solid.

## Decision Outcome

**Chosen: option 2**, recorded alongside the mechanism itself.

- **Mechanism:** `pi_config` uses **classic branch protection** on `dev` and
  `main`, with `enforce_admins=true` and strict required status checks. Migration
  to repository rulesets is a separate, deferred decision (#420); until then,
  classic protection is the recorded, satisfying-ADR-0036 mechanism.
- **`verify` always runs on protected-branch PRs:** the sync-mirrors
  `pull_request` trigger is scoped by `branches: [dev, main]`, not `paths:`, so
  the check reports on every such PR and can safely be required.
- **`verify` is a required status check on `dev`:** added to `dev`'s required
  checks alongside `validate` and `block-artifact-review-merge`. This is applied
  to the live protection **after** the trigger change merges (so no in-flight PR
  is blocked by a not-yet-always-running check).

### Consequences

- Good: a PR that would leak a denylisted string into a public mirror now fails a
  **required** gate at PR time, not just at push time.
- Good: the actual protection mechanism (classic, not rulesets) is recorded, so
  future work does not mis-assume the framework's ruleset model applies here.
- Neutral: `verify` runs on every `dev`/`main` PR (~10s) instead of a path
  subset — negligible cost, more coverage.
- Neutral: `dev` is not yet migrated to rulesets; the framework-preference
  question is tracked in #420, not silently dropped.
- Accepted: the required-check addition is a server-side protection edit, applied
  post-merge; it is not captured in this repo's tree (GitHub branch-protection
  config lives in repo settings, per ADR-0036).
