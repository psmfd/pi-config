---
status: Accepted
date: 2026-06-25
---

# ADR-0054: the distribution mirror ships no source-repo CI workflows

**Status:** Accepted
**Date:** 2026-06-25
**Closes:** [#411](https://github.com/psmfd/pi_config/issues/411) (the `pi-config` mirror's `validate` check was permanently red)
**Related:** [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the outbound mirror sync this refines — what the config mirror ships), [ADR-0052](0052-mirror-code-scanning-followup.md) (the mirror's CodeQL default-setup scanning posture, which this leaves as the mirror's only CI), [ADR-0053](0053-pin-github-actions-to-sha.md) (the Actions-hardening these same workflows received), [ADR-0036](0036-dev-integration-main-stable-branch-model.md) (the dev/main gate model `validate.yml` enforces on the source)

## Context and Problem Statement

The `pi-config` target in `mirror/targets.yml` is `replace`-mode: the staged
tree wholly defines the public mirror (`rsync --delete`). Its `sources`
allowlist shipped three source-repo CI workflows — `validate.yml`,
`setup-smoke.yml`, and `artifact-review-guard.yml` — so each landed in the
mirror's `.github/workflows/` and ran there.

`validate.yml` runs `scripts/validate.sh`, a source-of-truth gate
(frontmatter/catalog/ADR/link/extension typecheck) that assumes the full repo
tree and dev toolchain. The mirror is a curated *subset* — the five first-party
extensions and dev-internal surfaces are excluded — so the gate cannot pass. On
the mirror it failed on **every push** (run 28178646590: exit 126 — the runner
could not even execute the script as shipped), a permanently red, required-looking
check on a public-facing repo, which erodes trust in the mirror. The failure was
pre-existing (red before v1.3.0), not introduced by a release.

Inspecting the other two confirms neither belongs on the derived artifact either:

- `setup-smoke.yml`'s final step *also* runs `scripts/validate.sh` (the same
  failure), and its weekly `cron` fires on the mirror independent of any push
  (plus the unrelated macOS breakage in [#388](https://github.com/psmfd/pi_config/issues/388)).
- `artifact-review-guard.yml` enforces the source-internal Tier-3 `.review`
  never-merge contract (ADR-0006/ADR-0007), gated on a PR label. The mirror has
  no pull requests and excludes `.review` — it is inert and meaningless there.

The root cause is categorical: a **source-of-truth / source-internal CI gate
should not run on a wholly-derived distribution artifact**. The source's gates
belong on the source (`psmfd/pi_config`).

## Considered Options

1. **Exclude the source-repo CI workflows from the mirror.** Chosen. Drop the
   three `.github/workflows/*.yml` entries from the `pi-config` target `sources`;
   the next `replace`-mode sync prunes them via `rsync --delete`. The mirror then
   ships no workflow files and relies solely on CodeQL default-setup for scanning.
2. **Ship a trimmed, mirror-appropriate validation overlay.** Rejected: adds a
   separately-maintained mirror-only workflow for marginal value. The mirror's
   correctness is already gated at the source (`validate.sh` on `pi_config`) and
   at sync time (`sync-mirror.sh`'s fail-closed verify); security is covered by
   CodeQL. A bespoke overlay is machinery without a problem to solve.
3. **Disable Actions on the mirror.** Rejected: it would also disable CodeQL
   default-setup, violating the requirement to keep the mirror's code-scanning
   intact (ADR-0052), and it leaves the confusing workflow files in the tree.

## Decision Outcome

**Chosen: option 1.** The `pi-config` mirror ships **no source-repo CI
workflows**. The three entries are removed from the target `sources` in
`mirror/targets.yml`; the `replace`-mode sync deletes them from the mirror.

Convention going forward:

- **Source-repo CI gates are not mirrored.** A workflow whose job validates the
  source of truth, the full dev toolchain, or a source-internal contract
  (PR labels, `.review/`, branch protection) runs on `psmfd/pi_config` only. It
  is never added to a mirror target's `sources`.
- **The mirror's only CI is CodeQL default-setup** — server-side configuration,
  not a synced file, so it survives `rsync --delete` and is unaffected by this
  change (ADR-0052). Advanced-setup's committed `codeql.yml` would be erased by
  the `replace`-mode sync and is deliberately not used.
- A future *mirror-appropriate* workflow (one that validates only what the mirror
  actually contains) would be authored as a mirror overlay, not synced from the
  source `sources` — but none is warranted today (option 2).

### Consequences

- Good: the permanently-red `validate` check on `psmfd/pi-config` is gone (#411);
  the public mirror presents a clean check surface.
- Good: a clean separation consistent with ADR-0050's "wholly-derived artifact"
  framing — source gates on the source, derived-artifact scanning (CodeQL) on the
  mirror.
- Neutral: `MIRROR_SYNC_TOKEN`'s **Workflows: write** scope is still exercised by
  the one-time pruning push that deletes the mirror's workflow files, and is
  retained as margin; narrowing it to Contents-only afterward is a separate
  least-privilege follow-up ([#412](https://github.com/psmfd/pi_config/issues/412)).
- Bad / accepted: the mirror no longer runs `setup.sh` smoke validation on the
  exact shipped artifact. This was already failing on the mirror and is covered
  on the source via `setup-smoke.yml`; the marginal coverage loss is the artifact
  triple, not the install logic.
