---
status: Accepted
date: 2026-07-10
---

# ADR-0087: Config-mirror release signing — SSH-signed annotated tags + Immutable Releases, verified at update time

**Status:** Accepted
**Date:** 2026-07-10
**Tracking issue:** #627
**Related:** [ADR-0086](0086-consumer-update-mechanism.md) (the `update.sh` whose fetch/reset path gains the verify gate), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) / [ADR-0040](0040-consume-psmfd-attested-pi-releases.md) (the pi-binary attestation chain — the parity target, and the source of the no-long-lived-key posture this ADR partially diverges from), [ADR-0055](0055-automated-mirror-releases.md) (the annotated-tag-first mirror release this signs), [ADR-0061](0061-mirror-sync-github-app-auth.md) (the `mirror-production` environment-gated-secret isolation the signing key reuses), [ADR-0066](0066-ci-release-automation.md) (the CI release path the signing step extends), #626 (installer-file checksums — the complementary control for the first-install bootstrap gap), #634 (key-rotation procedure follow-up)

## Context and Problem Statement

The public config mirror `psmfd/pi-config` is the highest-privilege artifact in
the distribution: `setup.sh` symlinks `~/.pi` to the clone and its extensions run
in-process in the pi harness. Yet its integrity chain has been weaker than the pi
*binary* it launches — the binary is sha256-verified against an attested
`SHA256SUMS` (ADR-0038/0040), while the config mirror is consumed by plain
`git clone`/`git fetch` over HTTPS, with trust resting only on TLS + GitHub auth.
`update.sh` (ADR-0086) added tag-pinning and a numeric anti-downgrade guard, which
closes version-regression but **not** origin-authenticity or same-version
content-substitution.

The four-agent research fan-out on #627 established the constraints:

- The consumer verifies via a **git-object path** (clone/fetch → checkout a tag),
  not a downloaded tarball. Artifact attestation (`gh attestation verify`, what the
  pi binary uses) is **file-scoped** — it binds a tarball digest, not a git tag or
  commit object — so it cannot protect the git-clone path without redesigning the
  consumer to download-and-verify a tarball instead of cloning. Different, heavier
  architecture; out of scope.
- The mirror release tags are **already annotated** (`sync-mirror.sh` runs
  `git tag -a` + `git push`, then `gh release create --verify-tag`), merely
  unsigned (`-c tag.gpgSign=false`). Signing is a one-flag change on existing
  machinery — an annotated→signed step, not lightweight→annotated.
- A signed **tag** object transitively pins the target commit's tree/blob SHAs, so
  signing the tag covers the commit; signing the commit additionally is redundant.
- **Bootstrap paradox:** `install.sh` is distributed over an unauthenticated
  channel ("send this file to anyone"). A verification key embedded in it is only
  as trustworthy as the installer itself, which is not yet trusted at first run.
  So cryptographic verification's real value is at **update time** (`update.sh`
  runs from an already-trusted clone that carries the pinned key) and for detecting
  post-install tampering — not at first install.

## Considered Options

| Option | Verdict |
|---|---|
| **SSH-signed annotated tags + Immutable Releases, `git verify-tag` at consume time** | **Chosen.** Fits the git-clone flow with no transport change; verification needs only `ssh-keygen` (present by default on macOS + Debian alongside `git`); one-flag producer change + an env-gated signing key; Immutable Releases adds server-side tag-repoint prevention at zero code/consumer cost. |
| Keyless Sigstore signing (`gitsign`) over the tag | Rejected. Best producer-side posture (no long-lived key, matches ADR-0038) and git-native, but the consumer must install `gitsign`/`cosign` to verify — a disproportionate install-time dependency for a "run this one file" installer. |
| `gh attestation verify` over a release tarball (ADR-0038/0040 pattern) | Rejected for this issue. File-scoped, not git-object; would require an uploaded tarball asset (the auto Source archive is documented-unattestable) AND redesigning the consumer away from `git clone` — a separate, heavier architecture the issue itself framed as the later rung. Adds a `gh` install-time dependency. |
| Signed commits instead of / in addition to signed tags | Rejected. GitHub's automatic bot-commit "Verified" badge applies only to API-constructed commits, not the local `git commit` + push the sync engine uses; and a signed tag already pins the commit SHA — signing the commit is redundant for the tag-pinned consume flow. |
| Long-lived GPG (OpenPGP) signed tags | Rejected. `gpg` is absent by default on macOS, breaking the git-only installer premise; SSH-format signing verifies with the ubiquitous `ssh-keygen` instead. |

## Decision Outcome

**Chosen: SSH-signed annotated tags + Immutable Releases, verified fail-closed at
update time and best-effort at install time.**

1. **Immutable Releases** enabled on `psmfd/pi-config` — locks each release's
   tag→commit server-side, preventing the force-repoint / same-version
   content-substitution attack the numeric guard does not catch. One repo setting;
   validated to not break the annotated-tag-first release order or the #430
   Phase-6 retry race before being relied on.
2. **Producer:** `sync-mirror.sh`'s `create_release()` signs the mirror tag
   (`-c gpg.format=ssh -c user.signingkey=<key> tag -s`) using a dedicated
   ed25519 key delivered as a `mirror-production`-environment-gated CI secret
   (`RELEASE_SIGNING_SSH_KEY`), isolated from the Contents:write push scope so a
   token-only compromise cannot forge a signature. The CI release path fails
   closed if the key is absent (never cut an unsigned release once live); the
   local `release.sh --tag-only` emergency fallback WARNs and cuts unsigned rather
   than blocking an emergency release.
3. **Consumer — fail-closed in `update.sh`:** between `git fetch` and
   `git reset --hard`, `git verify-tag FETCH_HEAD` (SSH format, against an embedded
   allowed-signers key) must pass or the update is refused; a missing `ssh-keygen`
   also refuses (fail-closed). Verification is skipped only for a non-semver
   `--ref` (a branch, an explicit user choice with no release tag).
4. **Consumer — best-effort in `install.sh`:** the same gate, but WARN-and-proceed
   when verification cannot run (no `ssh-keygen`) or the tag is unsigned (an older
   release) — the bootstrap paradox makes first-install verification inherently
   weaker. A **present-but-invalid** signature still refuses (an active-tampering
   signal, distinct from a bootstrap gap). Security-conscious first-installers pair
   this with the #626 installer-checksum control.
5. **Retain** `update.sh`'s numeric anti-downgrade guard — complementary:
   signatures stop content-substitution-at-a-fixed-version; the `ver_gt` guard
   stops version-regression; neither subsumes the other.
6. The signer trust anchor (the allowed-signers public key) is **pinned in the
   consumer scripts**, never resolved from the mirror — resolving it from the
   artifact being verified would be circular and defeat a GitHub-side compromise.

## Consequences

**Positive:**

- Brings the config mirror toward parity with the pi-binary chain's origin
  authenticity, on the git-object path the consumer actually uses.
- No new consumer dependency beyond `ssh-keygen` (ubiquitous with `git`).
- Immutable Releases + the numeric guard cover the two highest-probability attacks
  (tag-repoint, version-regression) independently of the signing layer.
- Reuses existing machinery: the tags are already annotated, the release already
  runs in CI, and the env-gated-secret isolation pattern already exists (ADR-0061).

**Negative / accepted:**

- Reintroduces a **long-lived signing key**, a partial divergence from ADR-0038's
  "avoid long-lived signing keys" posture. Accepted because the keyless alternative
  imposes a consumer-side tool dependency that is worse for a send-to-anyone
  installer; the key is environment-gated, rotatable, and isolated from the push
  scope. Rotation/revocation is deferred to #634.
- First-install verification is best-effort by the bootstrap paradox; #626 is the
  complementary control for users who want end-to-end first-install assurance.

**Residual risks (documented, not closed by this ADR):**

- Does not prevent a compromised CI job at signing time — forensic/detective only,
  the same residual ADR-0038 accepts for the binary chain.
- Does not prevent a malicious maintainer with legitimate release authority — out
  of scope under the solo-maintainer owner-bypass promotion model.
- Provides no freshness on its own (a valid old signature replays) — the numeric
  anti-downgrade guard remains the freshness control.
- Depends on `git ≥ 2.34` (SSH-format signing/verification) on both the CI runner
  and the consumer; older system git is a real floor to check.

## Doc-Impact

- `adrs/0087-*.md` (this), README ADR index row.
- `scripts/sync-mirror.sh`, `.github/workflows/release.yml` — producer signing.
- `install.sh`, `update.sh`, `scripts/lib/release-signers.txt` — consumer verify +
  embedded/tracked key, with a `scripts/validate.sh` lockstep check.
- `docs/psmfd-pi-release-runbook.md` / `docs/outbound-mirror-sync.md` — signing key,
  secret, Immutable Releases, rotation pointer (#634).
- `mirror/readme/pi-config.md` — consumer "Verifying a release" section.
- Follow-up #634 (rotation/revocation); #626 referenced as the complementary
  first-install control.
