---
status: Accepted
date: 2026-06-12
---

# ADR-0041: Conditional security-patch divergence for the psmfd/pi mirror

**Status:** Accepted
**Date:** 2026-06-12
**Tracking label:** `track:pi-mirror` (pi_config)
**Related:** [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) (build-and-attest trust boundary), [ADR-0039](0039-mirror-sync-cadence-and-provenance.md) (sync cadence and provenance), [ADR-0040](0040-consume-psmfd-attested-pi-releases.md) (pi_config consumes psmfd attested releases), [#368](https://github.com/psmfd/pi_config/issues/368) (validate `--` ref fix, report upstream), [psmfd/pi#7](https://github.com/psmfd/pi/issues/7) (public tracking of the git-ref injection finding), [`docs/psmfd-pi-mirror-sync.md`](../docs/psmfd-pi-mirror-sync.md), [`docs/psmfd-pi-release-runbook.md`](../docs/psmfd-pi-release-runbook.md)

## Context and Problem Statement

The `psmfd/pi` mirror enforces **strict zero-divergence**: it carries no
behavioral source patches, only overlay files (docs, security policy, repo
metadata, `psmfd-*` workflows). The zero-divergence guard
(`psmfd-zero-divergence.yml`) blocks any PR touching upstream-owned paths
unless it is a trusted `sync/upstream-*` import. PROVENANCE.md states the rule
absolutely: "the mirror must not carry behavioral source patches."

That posture has no answer for a security finding that upstream has **not**
fixed. As of 2026-06-12 the mirror (and `pi_config`, which vendors
`v0.79.1-psmfd.1` per ADR-0040) is exposed to:

- **CodeQL `js/second-order-command-line-injection`** (psmfd/pi alerts 19/22,
  High) — `source.ref` flows into `git fetch`/`git checkout` without a `--`
  separator or leading-`-` rejection in `packages/coding-agent`. No upstream
  issue, PR, or commit addresses it at upstream HEAD (v0.79.2).
- **vitest < 3.2.6** (CVE-2026-47429, Critical) — upstream PR #5451 to bump it
  was **closed unmerged**; upstream HEAD still pins 3.2.4.
- **esbuild < 0.28.1** (GHSA-gv7w-rqvm-qjhr High, GHSA-g7r4-m6w7-qqqr Low) — no
  upstream bump.
- **shell-quote ≤ 1.8.3** (CVE-2026-9277, Critical) in the sandbox example
  lockfile — upstream fixed only the *root* lockfile (commit `a7f9fe68`); the
  sandbox lockfile is still exposed.

Under strict zero-divergence the only sanctioned response is "escalate and
wait for upstream." For a Critical/High finding with no upstream work in
flight, that is an unbounded exposure window for the mirror's own released
artifacts. We need a sanctioned, auditable way for the mirror to ship a fix
**ahead of upstream** without surrendering the provenance guarantees the mirror
exists to provide, and a deterministic way to dissolve that divergence once
upstream catches up.

## Decision Drivers

- A CodeQL alert closes only when the fix is reachable from the **default
  branch**; a fix that lives only on a side branch or is applied at build time
  never closes the alert.
- The release pipeline (ADR-0038) attests **bytes built from the tagged source
  tree**. The patched source must therefore exist as a real, auditable commit
  on `main` — a build-time patch would attest bytes that match no source
  commit, breaking provenance.
- The zero-divergence guard is a security control on a public release pipeline.
  Any mechanism that relaxes it must fail closed, keep accidental divergence
  blocked, and add as little logic as possible to the guard itself.
- Solo-maintainer reality: the reconciliation path on upstream sync must be
  mechanical, not a per-event judgement call.

## Considered Options

### Where patches live

1. **Overlay commits on `main`, manifest-tracked (chosen).** The patch is an
   ordinary commit on `main`, gated by a `.psmfd/patches/manifest.yml` entry
   and a lockstep allowlist extension. Closes CodeQL alerts immediately on
   merge; the attested tree matches the tagged commit; divergence is explicit
   and documented.
2. **Long-lived `psmfd-patches` branch.** Rejected: never closes CodeQL alerts
   until merged to `main`, and re-introduces a recurring rebase conflict on
   every `sync/upstream-*` import — exactly the clean-sync invariant ADR-0039's
   trusted bypass was designed to protect.
3. **Build-time `.patch` application (quilt/Debian style).** Rejected: the
   attested bytes would differ from every auditable source commit, breaking the
   ADR-0038 provenance chain; and the alert never closes because no commit
   carries the fix.

### How the guard permits a patched upstream path

1. **Lockstep allowlist + manifest, two-step PR flow (chosen).** A patched path
   is added to both the text allowlist (`.psmfd/overlay-allowlist.txt`) and the
   guard's embedded allowlist (`psmfd-zero-divergence.yml`), accompanied by a
   `.psmfd/patches/manifest.yml` entry, in an **overlay PR** that touches only
   already-allowed paths (so it passes the guard normally). The subsequent
   **patch PR** then touches the now-permitted upstream path. No change to the
   guard's permission model or trust logic — only its allowlist data. Accidental
   divergence stays blocked because a path is permitted only after a reviewed
   overlay PR names it.
2. **Label-gated runtime bypass.** Rejected for now: adding `contents: read`
   and label/manifest-reading logic puts more code — and a new bypass vector —
   into the security-critical guard. The lockstep-data approach achieves the
   same outcome with no new guard logic. (Revisit only if per-PR path scoping
   becomes necessary.)
3. **Permanently allowlist `package.json`/lockfiles.** Rejected: would un-guard
   high-churn upstream files for their whole lifetime. The chosen approach
   scopes the exemption to named files and removes them on retirement.

### Disclosure sequence for the injection finding

Because the mirror is **public**, the patch diff publicly discloses the
vulnerability the moment it ships. Options weighed: report-first-then-release
(most conservative), release-then-report-later (original sequencing), and
**notify-upstream-same-day (chosen)** — upstream is privately notified no later
than the patched release, so the public diff never precedes upstream awareness.
Per maintainer decision, **no upstream report is filed without explicit
maintainer approval** (the report is a hard human gate, not an automated step).

## Decision Outcome

Adopt **conditional security-patch divergence**: the mirror MAY carry a
behavioral patch to upstream-owned source **only** when all of the following
hold.

1. **No upstream fix exists or is in flight** for the finding (no merged commit,
   no open PR likely to merge). Verified and recorded at patch time.
2. The finding is a **security finding** — a CodeQL/code-scanning alert or a
   CVE/advisory (Dependabot). Routine version refreshes do not qualify and stay
   on the normal Dependabot/sync path.
3. The patch is **registered in `.psmfd/patches/manifest.yml`** and the patched
   path is added to the allowlist in lockstep, via a prior overlay PR.
4. Every commit touching an upstream-owned path under this policy carries a
   **`PSMFD-Patch: <id>`** trailer tying it to its manifest entry.
5. The patch **carries evidence**: a failing-then-passing regression test for
   source fixes (following upstream's `test/suite/regressions/<n>-<slug>` or the
   `package-manager.test.ts` unit pattern), and the resolved version + advisory
   ID for dependency bumps.

Lockfile-only security bumps are treated as the **same class** as source
patches (the attested bytes depend on the lockfile), with the same manifest +
trailer + allowlist discipline. Upstream's `PI_ALLOW_LOCKFILE_CHANGE=1`
pre-commit guard is set for the lockfile commit and noted in the commit body.

**Manifest schema** (`.psmfd/patches/manifest.yml`): per patch — `id`, `status`
(`active` | `retired`), `upstream_base`, `patched_paths`, advisory/alert ref,
`upstream_issue`, `upstream_pr`, `upstream_fixed_in`, `psmfd_commit`,
`psmfd_retire_commit`. `upstream_fixed_in` is the retirement trigger.

**Lifecycle.** Patch → overlay PR registers manifest + allowlist → patch PR
applies the change on `main` (closing the alert) → attested release
`vX.Y.Z-psmfd.N` (the psmfd suffix bumps; the upstream base `X.Y.Z` is
unchanged) → upstream submission **with evidence, on maintainer approval** →
when upstream ships the fix, the `sync/upstream-*` import that carries it
retires the patch by **rebase-drop** of the `PSMFD-Patch` commit, sets
`status: retired` + `upstream_fixed_in` + `psmfd_retire_commit`, and removes the
path from the allowlist — dissolving back to zero divergence.

**Release evidence.** A security-patch release's notes must list each active
patch (ID, advisory, patched paths, upstream submission status) alongside the
standard SHA256SUMS + attestation verification instructions.

**Upstream submission.** From a clean fork branch off upstream HEAD,
cherry-picking only the fix commit with `PSMFD-Patch`/mirror-specific trailers
stripped, including the regression test. Same-day private disclosure for the
injection finding; public PR acceptable for findings with no remote attack
surface — **assessed per finding, filed only on maintainer approval.**

## Consequences

- **Positive:** open Critical/High findings get a sanctioned, attested fix
  ahead of upstream; CodeQL alerts close on merge; the divergence is explicit,
  audit-tracked, and self-retiring; consumers (pi_config) can pin a patched
  `-psmfd.N` build.
- **Negative / accepted:** the zero-divergence guarantee narrows from "never" to
  "never, except manifest-registered security patches." PROVENANCE.md and
  `.psmfd/security-baseline.md` are updated to state the narrow exception. While
  a path is allowlisted, the guard will not flag *other* changes to it — bounded
  by named-file scope, manifest review, and removal on retirement.
- **Follow-up:** a future `psmfd-patch-integrity` check can assert
  manifest↔allowlist consistency (every `active` entry's paths are allowlisted;
  no `retired` entry leaves residual diff) and that `upstream_fixed_in` implies
  `retired`. Tracked under `track:pi-mirror`.

## Supersession note

This ADR narrows, but does not revoke, the zero-divergence model of ADR-0039.
The trusted `sync/upstream-*` bypass and all sync evidence requirements are
unchanged. This ADR adds a second, separately-gated divergence class (security
patches) on top of the sync bypass; the two are mutually exclusive by
construction (a sync PR never carries an overlay or patch change, and vice
versa).
