---
status: Accepted
date: 2026-06-24
---

# ADR-0052: code-scanning follow-up process for the distribution mirrors

**Status:** Accepted
**Date:** 2026-06-24
**Amended by:** [ADR-0060](0060-source-scanning-strategy.md) (resolves the "pre-promotion source gap" consequence and the option-1 future option: paid source-side scanning is declined; the material part of the gap is closed with free CI gates)
**Related:** [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the outbound mirror sync this process gates), [ADR-0042](0042-standalone-extension-distribution.md) (the extension mirrors), [ADR-0036](0036-dev-integration-main-stable-branch-model.md) (the dev→main promotion this gate attaches to), [ADR-0019](0019-compaction-optimizer-extension.md) (the extension whose code the first findings live in)

## Context and Problem Statement

The six public distribution mirrors (`psmfd/pi-config` + five `psmfd/pi-*`
extension repos, ADR-0050) have GitHub CodeQL **default setup** enabled — free
for public repos — and are scanned on every push. The private source of truth,
`psmfd/pi_config`, has code-scanning **disabled**: enabling it requires paid
GitHub Advanced Security on a private repo.

This inverts the usual arrangement. Findings surface on the *derived* mirror,
but the fix must land in the *unscanned source* and propagate via the next sync.
Two structural facts make an ad-hoc response wrong:

- **Patching a mirror is futile.** `psmfd/pi-config` is `replace`-mode
  (`rsync --delete`); a fix committed directly to the mirror is overwritten on
  the next sync. Fixes must be made in `pi_config` and re-synced.
- **The source has a scanning gap.** Changes on `dev`/feature branches, or to
  files outside a target's manifest `sources`, are unscanned until promoted and
  synced. The gap is bounded (pre-promotion, not-yet-public) but real.

Without a defined process a HIGH finding can sit open on a public mirror while a
release is cut, and a false positive can be re-raised every sync with no record
of why it was dismissed. We need a repeatable, low-overhead follow-up that keeps
the security stance solid without buying GHAS.

## Considered Options

1. **Enable GHAS/CodeQL on the private source; disable mirror scanning.**
   Rejected for now: a recurring paid cost for a solo-maintained repo, when the
   mirrors already provide the same CodeQL coverage of the same code for free.
   Kept as a documented future option (a 60-day GHAS trial, a self-hosted CodeQL
   runner, or a scheduled Checkmarx scan) — tracked separately.
2. **Add Checkmarx One to the source CI as the source-side scanner.** Rejected:
   for this TS/shell codebase cx and CodeQL are complementary in principle but
   near-redundant in practice; cx is paid and adds a second alert stream. The
   existing on-demand `/full-review` (which already wires in `checkmarx-expert`)
   covers the deliberate-review case.
3. **Treat mirror CodeQL as the baseline, with a defined follow-up process.**
   Chosen. Free coverage of the public artifact, plus an explicit fix-at-source
   loop, a dismissal-with-rationale model, and a promotion severity gate.

## Decision Outcome

**Chosen: option 3.** The mirrors' free CodeQL is the baseline scanner; the
process below governs how findings are triaged, fixed, dismissed, and gated.

- **Default setup is mandatory on every mirror.** Advanced setup commits a
  `.github/workflows/codeql.yml`, which the `replace`-mode `rsync --delete`
  would erase on every sync unless added to the manifest `sources`. Default
  setup is configured server-side (no committed file), so it survives the sync.
  Do not migrate a mirror to advanced setup.
- **Fix-at-source loop.** A finding is fixed in `pi_config`, promoted to `main`,
  and the sync re-pushes the corrected content; CodeQL re-runs on the mirror and
  the alert transitions to *Fixed*. The per-push checklist lives in
  [`docs/outbound-mirror-sync.md`](../docs/outbound-mirror-sync.md).
- **Dismissal-with-rationale.** A false positive or accepted risk is dismissed
  on the mirror (alert state is server-side and fingerprint-keyed, so the
  dismissal survives content re-pushes as long as the location is stable). Every
  dismissal is recorded in [`security/scanning-decisions.md`](../security/scanning-decisions.md)
  — the human-readable audit log that survives even if a mirror is recreated.
  Re-emergence of a dismissed alert (a fingerprint drift after a fix) is a
  re-triage signal, not noise.
- **Promotion severity gate.** Before a `dev`→`main` promotion,
  [`scripts/check-mirror-alerts.sh`](../scripts/check-mirror-alerts.sh) queries
  all six mirrors and **fails on any open HIGH/CRITICAL alert** (default
  threshold). MEDIUM alerts require *triage recorded* (a fix in flight or a
  dismissal logged), not necessarily a fix. Alerts on mirror-only files (not
  present in `pi_config` sources) cannot be fixed at source and are mirror-side
  triage only. The gate is **runbook-manual** for now; promoting it to a
  required status check is tracked as a follow-up.
- **`security/` is not published.** The decisions log is dev-internal; `security/`
  is added to the `pi-config` mirror `exclude` in `mirror/targets.yml`, so the
  audit log is never shipped to a public mirror.

### Consequences

- Good: zero recurring cost; the public artifact is scanned and the source is
  covered for all promoted content.
- Good: a HIGH/CRITICAL finding blocks a release by default; dismissals are
  auditable and persist across syncs.
- Bad / accepted: **the pre-promotion source gap.** Changes on non-`main`
  branches, or to files outside a target's `sources`, are unscanned until
  promoted + synced. Bounded to pre-promotion, not-yet-public content; revisited
  if a source-side scanner is adopted (option 1, tracked separately).
- Bad / accepted: dismissals are per-repo. A finding common to several mirrors
  is dismissed on each, keyed by `rule.id` + location (the bulk-dismiss pattern
  is in the runbook).
- Bad / accepted: shell files are not covered by CodeQL (or cx SAST);
  `shellcheck` via the validator remains the shell security gate.

### First application (the four findings that motivated this ADR)

- **HIGH `js/incomplete-sanitization`** — `compaction-optimizer/lib/deterministic-summary.ts:432`:
  real but low-risk (the output is a Markdown summary, not an injection sink).
  Fixed at source by escaping backslashes before backticks.
- **MEDIUM `js/prototype-pollution-utility` ×2** — `compaction-optimizer/lib/settings.ts:223,241`:
  false positives — the `FORBIDDEN_KEYS` Set guard blocks polluting keys at every
  merge/assign entry point; CodeQL does not recognize `Set.has()` as equivalent
  to a hardcoded-string guard. Dismissed with rationale in the decisions log.
- **MEDIUM `actions/missing-workflow-permissions`** — `.github/workflows/validate.yml:21`:
  real; fixed by adding `permissions: contents: read` at the workflow level.
