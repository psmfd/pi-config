---
status: Accepted
date: 2026-06-23
---

# ADR-0047: script the dev→main release promotion, with a manual merge gate

**Status:** Accepted
**Date:** 2026-06-23
**Related:** [ADR-0036](0036-dev-integration-main-stable-branch-model.md) (dev integration / main stable promotion model), [ADR-0046](0046-psmfd-pi-main-ruleset-migration.md) (psmfd/pi main ruleset; analogous bypass model), [`agent/rules/github-flow.md`](../agent/rules/github-flow.md) (promotion / merge strategy), [`agent/rules/conventional-commits.md`](../agent/rules/conventional-commits.md) (commit types that drive the version bump), [`scripts/lib/gh-verify-user.sh`](../scripts/lib/gh-verify-user.sh) (identity probe), [`hooks/gh-identity-guard.sh`](../hooks/gh-identity-guard.sh) (pre-push identity guard)

## Context and Problem Statement

pi_config releases are fully manual: there is no `semantic-release` automation
(unlike the ecosystem default). A release is, per ADR-0036, a `dev` → `main`
promotion **merge commit** followed by an annotated `vX.Y.Z` tag cut from
`main`. The maintainer cut v1.0.0–v1.0.3 by hand, with two recurring problems:

- **Inconsistency.** v1.0.0 is annotated; v1.0.1–v1.0.3 are lightweight tags,
  violating the semver-tagging rule that manual tags be annotated.
- **Error-prone ritual.** The correct sequence (identity check, sync check,
  Conventional-Commits version inference anchored at the last tag, promotion
  PR, required-check wait, owner-bypass merge, annotated tag, optional Release)
  is long and easy to get wrong — and the host's gh identity drifts, so a wrong
  account can attribute or block a mutation.

The question: can the release be scripted, and if so, where is the boundary
between what a script may safely do and what must stay a deliberate human act?

## Considered Options

1. **No script — keep the manual runbook.** Rejected. The ritual is long and
   the lightweight-tag drift shows the manual path does not reliably hold the
   conventions.
2. **Fully scripted, including the merge via `gh pr merge --merge --admin`.**
   Rejected as the default. The inherited enterprise ruleset on `main` requires
   an approving review, last-push approval, and **linear history**. A promotion
   is a merge commit (non-linear by definition), so the only path is the owner's
   per-merge GitHub bypass. Whether `--admin` bypasses the *enterprise*
   `required_linear_history` constraint via the API is unverified and rejected
   by GitHub in at least some enterprise configurations; baking an unattended
   `--admin` merge into the script would be a blunt instrument that could fail
   opaquely or, worse, succeed in a way that erodes the audited-bypass property.
3. **Scripted, with a manual merge gate (chosen).** The script automates every
   step *except* the merge: it runs preflight + identity + version inference,
   opens the promotion PR, waits for required checks, then **pauses and polls**
   until the maintainer merges via the web-UI owner bypass, and resumes to
   create and push the annotated tag and the GitHub Release. The irreversible
   merge stays a deliberate, audited human action; everything mechanical around
   it is automated and idempotent.
4. **Hybrid: attempt `--admin`, fall back to polling for a manual merge.**
   Deferred. Viable once option 2's enterprise-bypass behavior is verified once
   against a real promotion PR; until then the extra code path guards an
   unproven capability. Revisit if the manual gate proves to be a bottleneck.

## Decision Outcome

Add **`scripts/release.sh`** implementing option 3, plus
**`scripts/retag-annotated.sh`** to remediate the existing lightweight tags.

Key properties of `release.sh`:

- **Preflight (fail closed, exit 2):** `git`/`gh`/`jq` present; active gh login
  matches `.pi/expected-identity` via the shared `gh_verify_user` probe; clean
  tracked tree; no merge in progress; on `dev`; `dev`/`main` in sync with
  origin; `dev` ahead of `main`; target tag absent locally and on origin.
- **Version inference** anchored at `git describe --tags --abbrev=0 main` (the
  last *tag*, not `main` HEAD — `main` can carry untagged commits), classifying
  Conventional Commits in `<last-tag>..dev` into MAJOR/MINOR/PATCH, with a
  mandatory confirmation gate and a `--tag` override.
- **Idempotent promotion PR:** reuse an open `dev`→`main` PR if present, else
  create one with a Conventional-Commits title and templated body.
- **Manual merge gate:** wait on required checks (`gh pr checks --required
  --watch --fail-fast` + a `statusCheckRollup` assertion), print the PR URL,
  poll `state` until `MERGED` (abort on `CLOSED`).
- **Annotated tag + optional Release:** `git tag -a`, explicit
  `git push origin <tag>` (never `--tags`), then
  `gh release create --verify-tag --notes-start-tag <last-tag> --generate-notes`
  unless `--no-release`.
- `--dry-run` prints every intended mutation and exits; `--yes` enables a
  non-interactive path but fails closed when stdin is not a TTY.

`retag-annotated.sh` is dry-run by default and force-pushes rewritten tags only
under `--apply --force-push` with an explicit confirmation, because
force-updating a published tag rewrites a ref other clones already hold.

### Consequences

- Good: the release ritual is encoded once, with fail-closed identity and sync
  checks and annotated-tag enforcement; re-runs are safe (idempotency guards).
- Good: the irreversible merge stays an audited human bypass — the script never
  holds standing bypass privilege, consistent with the no-standing-bypass-actor
  posture in ADR-0036/0046.
- Bad (accepted): the merge gate means a release is not single-command
  hands-off; the operator must perform the web-UI merge mid-run.
- Bad (accepted): `release.sh` duplicates the Conventional-Commits → bump
  mapping that semver-tagging defines in prose — a lockstep surface to keep in
  sync if the mapping changes.
- Follow-up: verify the enterprise `--admin` bypass behavior once, then decide
  whether to adopt option 4's hybrid auto-merge. Retire the lightweight tags
  with `retag-annotated.sh` as a separate, owner-confirmed action.

## More Information

The scripts live under `scripts/` and follow the inline-helper output
conventions used by the rest of the repo's utilities (this repo has no
`scripts/lib/log.sh`). Branch-protection and ruleset configuration referenced
here is repository/enterprise configuration, not tracked source.
