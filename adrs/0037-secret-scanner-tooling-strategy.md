---
status: Accepted
date: 2026-06-11
---

# ADR-0037: secret-scanner tooling strategy

**Status:** Accepted
**Date:** 2026-06-11
**Tracking issue:** [#358](https://github.com/psmfd/pi_config/issues/358)
**Related:** [#357](https://github.com/psmfd/pi_config/issues/357) (public-flip readiness), [ADR-0010](0010-setup-install-trust-posture.md) (setup install trust posture), [ADR-0011](0011-toolchain-install-strategy.md) (developer toolchain install strategy), [`agent/rules/secrets-guard.md`](../agent/rules/secrets-guard.md), [`hooks/secrets-guard.sh`](../hooks/secrets-guard.sh)

## Context and Problem Statement

The pi mirror work requires a pre-public full-history secret scan before the private `psmfd/pi` mirror can safely become public. `pi_config` already has two prevention layers:

- the `secrets-guard` pi extension, which blocks in-session tool calls that would write or surface common credential patterns;
- the optional `hooks/secrets-guard.sh` pre-commit hook, which blocks the same high-risk patterns at commit time.

Those layers are intentionally fast and local, but they are not a full repository/history scanner. The mirror public-flip gate needs a repeatable scanner that can audit working trees and git history, and `setup.sh` should install it the same way it installs the rest of the required maintainer toolchain.

## Considered Options

1. **Keep only the custom `secrets-guard` layers.** Rejected. They remain necessary, but they do not provide broad history scanning or a standard report format for public-flip evidence.
2. **Adopt Gitleaks as the canonical setup-installed scanner.** Chosen. Gitleaks is a single static binary with macOS/Linux release assets, supports redacted reports, supports working-tree and git-history scans, runs offline, and has straightforward exit-code handling.
3. **Adopt TruffleHog as the canonical setup-installed scanner.** Rejected for the default path. TruffleHog is valuable for verified-secret scans, but its verification mode performs network calls, its default output requires extra care to avoid logging secrets, and its role is better suited to explicit deep audits.
4. **Adopt both Gitleaks and TruffleHog as default required scanners.** Rejected for now. Two required scanners double setup/vendor/update surface and create triage ambiguity. The second scanner should have a distinct enforced role before becoming part of setup.

## Decision Outcome

**Chosen: option 2 — install Gitleaks as the canonical `pi_config` secret scanner.**

- Add `agent/vendor/gitleaks/` with `VERSION`, `CHECKSUMS`, and `README.md` using the same sha256-pinned release-asset pattern as the existing binary toolchain.
- Add `ih_ensure_gitleaks` to `scripts/lib/install-helpers.sh` and include it in `setup.sh` §1b.
- Add `scripts/validate-gitleaks-vendor.sh` and wire it into `scripts/validate.sh` as a required structural check.
- Add `scripts/scan-secrets.sh` as the repo wrapper for redacted working-tree and history scans.
- Keep TruffleHog optional/deferred for deep public-flip audits. If it later becomes required, record a follow-up ADR or amend by supersession.

### Role split

| Layer | Role |
|---|---|
| `secrets-guard` extension | Blocks in-session tool calls before secrets hit disk or logs. |
| `hooks/secrets-guard.sh` | Fast optional pre-commit guard for staged content. |
| Gitleaks | Setup-installed scanner for working tree and git history audits. |
| TruffleHog | Optional deep/verified scan for public-flip or release gates. |

## Consequences

### Positive

- The public-flip readiness process gets a reproducible scanner with redacted output.
- Fresh machines receive the scanner through the existing setup/toolchain path.
- The scanner is checksum-pinned and review-gated through CODEOWNERS like other trust-root tooling.
- Gitleaks can run offline, which keeps the default validation path deterministic and avoids provider-verification side effects.

### Negative / costs

- Another vendored binary pin must be maintained and bumped.
- Upstream Gitleaks has described itself as feature-complete / maintenance-oriented; this repo should re-evaluate the scanner choice if detector coverage stagnates or a successor tool becomes the maintained path.
- Regex/entropy scanners can produce false positives that need documented allowlists or baseline decisions.
- Gitleaks does not verify whether a credential is live; high-stakes audits may still need a TruffleHog pass.

### Non-goals

- This ADR does not replace the `secrets-guard` extension or git hook.
- This ADR does not make full-history scanning a mandatory `scripts/validate.sh` gate yet. The wrapper exists first; gating follows after an initial baseline decision.
- This ADR does not vendor or require TruffleHog.

## More Information

- `agent/vendor/gitleaks/`
- `scripts/lib/install-helpers.sh` (`ih_ensure_gitleaks`)
- `scripts/validate-gitleaks-vendor.sh`
- `scripts/scan-secrets.sh`
- Public-flip readiness evidence: [#357](https://github.com/psmfd/pi_config/issues/357)
