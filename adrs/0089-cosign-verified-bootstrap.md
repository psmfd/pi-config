---
status: Accepted
date: 2026-07-10
---

# ADR-0089: Verified cosign bootstrap on Debian — "old cosign verifies new cosign"

**Status:** Accepted
**Date:** 2026-07-10
**Related:** [ADR-0067](0067-expertise-local-installer.md) (the installer this extends), [ADR-0070](0070-install-expertise-debian-parity.md) (the Debian path this keeps working), [ADR-0069](0069-ext-ref-pin-drift-automation.md)/[ADR-0075](0075-per-extension-install-pins.md) (the pin conventions the new pin joins), upstream [agent-expertise-api#402](https://github.com/psmfd/agent-expertise-api/issues/402) (the root-cause bug), #646 (pin-drift follow-up)

## Context and Problem Statement

`agent-expertise-api` v1.4.1 migrated its release signing from detached cosign
signatures to the Sigstore bundle format and raised `verify-release.sh`'s
`COSIGN_MIN_VERSION` to `3.0.0` (upstream #400). Debian 13's apt archive ships
cosign **2.5.0**, trixie-backports carries no cosign package at all, and 3.x
exists only in `sid`/`forky` (blocked from testing migration by a Go dependency
issue). Upstream's own `bootstrap-debian.sh` (behind `install.sh
--install-deps`) apt-installs 2.5.0 — so a fresh Debian install of v1.4.1+
self-breaks: the bootstrap installs a cosign that the verify step then rejects.
Filed upstream as agent-expertise-api#402; `install-expertise.sh` (ADR-0067/0070)
needs Debian installs working now.

The hard question is trust: cosign is the release *verifier*, so how do we
obtain a newer cosign without a blind, unverified download — in a script whose
posture everywhere else is fail-closed and signature-verified?

## Considered Options

1. **"Old cosign verifies new cosign" bootstrap** — apt-install cosign 2.5.0
   (trusted via Debian's archive signature chain), use it to keylessly verify
   the pinned cosign 3.x release's signed checksums manifest
   (`cosign verify-blob --bundle cosign_checksums.txt.sigstore.json` with the
   certificate identity pinned to `keyless@projectsigstore.iam.gserviceaccount.com`
   and OIDC issuer `https://accounts.google.com` — cosign's release CI signs
   from GCP, not GitHub Actions), then `sha256sum --check` the downloaded
   binary against the now-verified manifest and install to `/usr/local/bin`.
2. **`gh attestation verify`** — verify via GitHub artifact attestations.
3. **`go install github.com/sigstore/cosign/v3/cmd/cosign@vX`** — Go module
   proxy + sum.golang.org checksum transparency.
4. **Wait for Debian** (trixie-backports / point release), fail closed with
   manual remediation text in the meantime.
5. **Unverified download** (curl the binary, trust TLS alone).

## Decision Outcome

**Option 1**, implemented as `_ensure_cosign_ge3()` in `install-expertise.sh`,
called only on the Debian/apt branch before delegating to the upstream
installer, with option 4's fail-closed behavior as the universal backstop: any
verification failure (missing bundle, identity mismatch, sha256 mismatch,
unparseable version) dies with exit 2 — the script never falls back to an
unverified binary or a weaker check.

Why option 1: it adds **no new trust root** — apt's cosign is already trusted
via Debian's archive signatures, and 2.5.x shares Sigstore's public-good
Fulcio/Rekor roots with 3.x. That 2.5.0 parses the v3 bundle format was
confirmed empirically (verify OK against the real v3.1.1 release assets, with
negative controls: a tampered checksums file and a wrong identity both fail).
A network MITM can withhold the release files (availability failure → die), but
cannot forge the identity-bound signature or its Rekor inclusion proof.

Rejected:

- **Option 2**: empirically 404s — sigstore/cosign publishes no GitHub-native
  attestations for its release assets (it signs via its own Fulcio/Rekor flow),
  and `gh` as an install-time dependency contradicts this repo's existing
  installer-dependency posture.
- **Option 3**: verifies *source* integrity only (no binary provenance), runs
  build-time code, and drags a Go toolchain onto a host that otherwise needs
  none.
- **Option 4 alone**: leaves every fresh Debian install broken until Debian
  packaging catches up, for no security gain over option 1.
- **Option 5**: violates the repo's signature-verified posture; never on the
  table.

Implementation constants and their rationale:

- `COSIGN_PIN_VERSION="v3.1.1"` — exact-version pin (house style, cf.
  `EXT_REF`); dynamic "latest" adds an API failure mode with no security
  upside since the identity pin bounds what any tag can contain. Never pin
  below **v3.0.2**: v3.0.0 was never published and v3.0.1 shipped with missing
  artifact-key signatures per cosign's own release notes.
- Identity pinned as an **exact string, not a regexp** — narrower is safer; if
  sigstore rotates the identity the bootstrap breaks loudly and the pin gets
  reviewed, never silently bypassed.
- Install target `/usr/local/bin/cosign` — upstream's `_debian_ensure_cosign`
  explicitly skips its apt path when a cosign on PATH is not dpkg-managed, so
  re-runs and the delegated upstream install both honor the bootstrapped
  binary.

## Consequences

- Fresh Debian 13 installs of agent-expertise-api ≥ v1.4.1 work again, with a
  chain of trust anchored in the Debian archive plus Sigstore's public-good
  infrastructure — no TOFU, no blind download.
- A new hand-maintained pin (`COSIGN_PIN_VERSION`) joins the pin set; #646
  tracks extending the pin-drift automation (ADR-0069/0075) to watch it.
  Staleness is version lag, not security decay — a stale pin fails safe.
- The pinned identity is a new external coupling: a sigstore release-signing
  migration breaks Debian installs until the pin is updated (deliberate,
  fail-closed).
- If upstream #402 lands an equivalent bootstrap in `bootstrap-debian.sh`,
  `_ensure_cosign_ge3()` becomes a harmless no-op path (its ≥3 check skips)
  and can be retired in a follow-up once the minimum supported upstream
  version includes the fix.
- Keyless verification requires network reachability to Fulcio/Rekor
  infrastructure; fully air-gapped installs cannot complete the bootstrap —
  correct fail-closed behavior, remediated manually (upstream #256 tracks
  air-gapped verify).
