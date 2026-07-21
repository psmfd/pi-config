---
status: Accepted
date: 2026-07-20
---

# ADR-0111: secrets-guard — vault/sensitive pattern reconciliation and fail-toward-scanning

**Status:** Accepted
**Date:** 2026-07-20
**Related:** [ADR-0071](0071-secret-pattern-lockstep-reconciliation.md) (content-pattern lockstep + §6b-bis gate — extended, not superseded), [ADR-0088](0088-cross-extension-import-boundary.md) (why the copies are deliberate duplicates), [ADR-0072](0072-guardfall-shell-injection-hardening.md) (the bash-scan bypass class this does NOT address; #505), framework ADR-095 (JWT/Bearer detectors), pi_config #796 (the review that surfaced the drift)

## Context and Problem Statement

The #796 extension review executed both secrets-guard enforcement layers
side by side and found they disagreed about what counts as a vault-named
file:

- `hooks/secrets-guard.sh` (pre-commit) matched `*vault*.yml` — 'vault'
  anywhere in the path.
- `agent/extensions/secrets-guard/index.ts` (in-session) anchored 'vault'
  at the basename start (`(^|/)vault[^/]*\.ya?ml$`).

Result: a plaintext write to `secrets/prod-vault.yml` or `myvault.yml`
passed the in-session layer (the vault-header check never fired, and
generic vault plaintext matches none of the six content patterns) and was
only caught at commit time — breaking the block-before-disk guarantee the
extension documents. The drift was invisible to CI because ADR-0071's
§6b-bis lockstep gate covers only the six content-pattern fragments, not
the vault-naming or sensitive-basename detectors (a two-file lockstep the
gate never included).

The same review found three adjacent pattern-set gaps: the FIDO2
hardware-backed key basenames (`id_ecdsa_sk`/`id_ed25519_sk`, OpenSSH
8.2+) missing from both layers' sensitive lists; the bash sensitive-path
regex blocking harmless public-key reads (`~/.ssh/id_ed25519.pub`); and a
fail-open path where a write-like tool call with a missing/empty `path`
skipped every check including the path-independent content scan.

## Considered Options

1. **Tighten the hook to the anchored form** (match the in-session layer
   and the rule doc's original `**/vault*.yml` glob).
2. **Widen the in-session layer to the hook's form** ('vault' anywhere in
   the basename), update the spec, and gate both layers.
3. Leave the drift and document it.

## Decision Outcome

**Option 2 — the looser pattern wins, plus the adjacent fixes and a new
lockstep gate.** For a security guard, reconciling downward (tightening
the hook) would *reduce* protection at the commit layer to match a
narrower in-session layer; reconciling upward widens in-session protection
to what the commit layer always enforced. False-positive risk is bounded:
any `*vault*.yml` basename is plausibly an Ansible vault, and the skip
patterns (`tests/`, `fixtures/`, `*.example`, …) plus the allowlist remain
the documented escape hatches.

Concretely:

1. `VAULT_NAME_RES[0]` becomes `/vault[^/]*\.ya?ml$/` (unanchored —
   matches 'vault' anywhere in the final path segment), agreeing with the
   hook's `*vault*.yml|*vault*.yaml` glob. The rule doc's glob updates to
   `**/*vault*.yml`.
2. `id_ecdsa_sk` and `id_ed25519_sk` join the sensitive-basename set in
   BOTH layers (they carry no `.pem`/`.key` extension, so the extension
   regex never caught them).
3. The bash sensitive-path regex drops its `(\.pub)?` alternative (public
   keys are not secrets) and gains `(_sk)?` so FIDO2 private-key reads are
   caught.
4. Write-like calls with a missing/empty `path` now run the
   path-independent content scan instead of returning allow — fail toward
   scanning, so a malformed or future write-shaped payload cannot become a
   silent bypass.
5. `validate.sh` gains **§6b-ter**: fixed-string parity fragments for the
   vault-naming and sensitive-basename detectors across the two
   enforcement layers, closing the gate gap that let the drift live.
6. The detection logic is extracted into exported checkers
   (`checkWriteLikeCall`/`checkBashCall`) with a direct test suite
   (`test/detect.test.ts`) — the previous inline handler was structurally
   untestable, which is how the drift survived unexercised.

### Consequences

- Good: the two layers now agree; the block-before-disk guarantee holds
  for every vault name the commit layer recognizes; the gate makes this
  class of drift a CI failure.
- Good: FIDO2 key material is protected; public-key reads no longer
  produce false refusals.
- Neutral: the phantom "Azure DevOps PAT" detector the rule doc claimed is
  removed from the spec as never-implemented (recorded not-a-thing in
  #796; implementing it would require all three lockstep copies plus a
  gate fragment).
- Accepted gap (unchanged): the bash scan still runs over the raw,
  unlexed command string — the ADR-0072 GuardFall class; the shared-lexer
  adoption remains deferred to #505.
