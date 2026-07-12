---
status: Accepted
date: 2026-07-11
---

# ADR-0092: Automated pi runtime bump on new psmfd/pi releases — poll, verify, PR; human merge retained

**Status:** Accepted
**Date:** 2026-07-11
**Related:** [ADR-0040](0040-consume-psmfd-attested-pi-releases.md) (the attested-release consumption this automates), [ADR-0069](0069-ext-ref-pin-drift-automation.md) (the pin-drift automation precedent whose posture this follows), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md)/[ADR-0039](0039-mirror-sync-cadence-and-provenance.md) (the trust boundary and its documented residual gaps), #449 (the feature)

## Context and Problem Statement

Consuming a new `psmfd/pi` release (`vX.Y.Z-psmfd.N`, attested per ADR-0040)
was an entirely manual runbook (`docs/vendor-updates.md` § Pi runtime):
attestation-verify `SHA256SUMS`, write `VERSION`/`CHECKSUMS`, self-test,
re-verify, align two runtime-coupled pins, audit the vendored-subagent
pairing gap, open a PR. Executed by hand for v0.80.6-psmfd.1, the loop took
the better part of a session. #449 asks for the bump-and-validate loop to be
automatic and the release step to remain explicitly gated. Five design
questions were open: trigger mechanism, human-gate placement, subagent
re-pair coupling, exit criteria, and attestation-failure handling.

## Considered Options

1. **Scheduled poll + auto-PR to `dev`, human merge (shape b)** — a daily
   workflow polls `psmfd/pi`'s latest release; on drift it runs the full
   verification pipeline and opens a bump PR; a maintainer merges.
2. **`repository_dispatch` from `psmfd/pi`'s release workflow** — near-real-
   time, but requires a fine-grained PAT or App installation token with
   `Contents: write` on pi_config stored as a secret in `psmfd/pi`, plus a
   producer-side workflow change. Rejected: ADR-0069 already declined to
   widen cross-repo credentials for the sibling pins; hours of latency is
   acceptable; a poll needs zero new secrets.
3. **Auto-merge to `dev` on green (shape c)** — rejected for launch. The PR
   review is the one control the attestation chain cannot supply: a valid
   attestation binds *workflow identity*, not *source safety* (ADR-0038's
   documented residual: compromised source building through the legitimate
   release workflow attests green). Also mechanically hollow: bot-opened
   PRs' required checks start in the "Approve workflows to run" state, so a
   human click remains in the loop regardless, and `allow_auto_merge` is off
   repo-wide. Revisit only after shape (b) runs cleanly.
4. **Fully automatic through release promotion (shape d)** — rejected
   outright; `scripts/release.sh` promotion is deliberately manual by prior
   decision and out of #449's scope.

## Decision Outcome

Chosen option: **1 (shape b)**, as `scripts/bump-pi-runtime.sh` +
`.github/workflows/pi-runtime-bump.yml`.

- **Script** (`bump-pi-runtime.sh`): `--tag|--latest`, `--check` (poll
  primitive), `--dry-run` (full verification, zero writes),
  `--no-exec-self-test`, `--repo` (test fixtures). Exit 0/1/2 per repo
  convention; an API failure during `--latest` resolution is exit 2, never a
  silent "no new version". Fail-closed **by ordering**: everything network-
  and-verify-side stages into a `mktemp` scratch dir; `VERSION`/`CHECKSUMS`
  are untouched until the SHA256SUMS attestation (hard stop, no bypass flag
  exists) and staged checksum-shape gates pass; promotion is atomic `mv -f`.
  The tag is regex-gated (`^v\d+\.\d+\.\d+-psmfd\.\d+$`) before touching any
  shell/file/URL; plain upstream tags (the emergency-rollback shape) are
  refused; downgrades are refused with a psmfd.N-aware compare; the
  README pin header is rewritten via anchored patterns that fail closed on
  prose drift.
- **Workflow**: daily poll (no cross-repo credential), default
  `GITHUB_TOKEN`, two-job split — `verify` executes the fetched binary with
  **no write permissions**; `bump` holds the write token but never executes
  the binary (`--no-exec-self-test`; the attestation + checksum gates re-run
  there regardless). Per-version branches (`chore/bump-pi-runtime-<tag>`)
  with explicit supersession (older open bump PRs are commented and closed)
  instead of pin-drift-check's fixed force-pushed branch: at several
  releases per week a force-push would clobber an in-review PR and
  invalidate its workflow-approval state. No `actions/cache` over the fetch
  path — `fetch_pi_binary` skips re-verification on cache hits (#109), so
  cross-run caching would bypass checksum verification on re-runs. Within a
  single write-mode run the script deliberately populates the REAL cache
  root (`$XDG_CACHE_HOME/pi_config`): the manifest regeneration below
  resolves the new tag's upstream snapshot there, and a scratch cache would
  strand every fresh CI runner on the manual-intervention path (review
  finding); `--dry-run` keeps a zero-footprint scratch cache.
- **Subagent re-pair coupling**: the script emits an audit signal, never a
  fix — it compares the two upstream base tags on `earendil-works/pi` via
  the compare API scoped to the subagent example path. **Hybrid manifest
  policy** for the two gates that would otherwise fail every automated
  bump: (i) the README pin-header citation is mechanically rewritten
  (anchored, fail-closed); (ii) `PATCH_MANIFEST.json`'s `pinnedPiVersion` is
  regenerated **only when** the audit proves the upstream subagent source
  unchanged AND no vendored subagent file is dirty — a pure pin refresh,
  outside the documented regenerate-after-source-edits anti-pattern. When
  the audit reports *changed* or *unresolvable*, the manifest is left
  stale, `validate.sh` fails the PR by design, and the PR body carries a
  Procedure B warning — the human decision the anti-pattern rule protects.
- **Exit criteria** ("no real issues"): blocking = tag resolution, download,
  either attestation, checksum shape, `validate-pi-vendor.sh`, fetch/self-
  test, README anchor. Advisory WARN = runtime-coupled pin fix failures
  (pin-drift-check independently re-fixes them) and every subagent-audit
  outcome.

### Consequences

- Good: the entire mechanical consumption loop — proven by a live scratch-
  worktree run reproducing the manual v0.80.6 bump diff exactly — runs
  unattended; the maintainer's remaining touchpoints are the workflow-run
  approval click and the merge, which are precisely the two judgment points.
- Good: security posture is unchanged from the manual runbook (same signer
  pin, same two verify points), and improved in one respect: the binary
  never executes holding a write-capable token.
- Neutral: `upstream-pi-watch.yml` stays — it watches *upstream*
  (feeds the mirror-sync decision); this watches *psmfd/pi* (feeds the
  consumer bump). Complementary signals.
- Bad (accepted): a same-base `-psmfd.N` rebuild or a subagent-source-
  changed release produces a deliberately-red PR requiring manual
  completion; the signer-workflow string is a hardcoded coupling to
  `psmfd/pi`'s workflow filename (documented in both the script and
  workflow headers).

## More Information

Designed from a three-agent fan-out (gh-cli-expert: live repo-settings and
Actions mechanics; security-review-expert: trust-boundary analysis and the
job-split requirement; shell-expert: script decomposition and the two-gate
blocker finding). The branch-strategy disagreement (fixed vs per-version)
was resolved for per-version + supersession on cadence/trust-bar grounds.
