---
status: Accepted
date: 2026-07-13
---

# ADR-0099: Shared reusable release workflows, per-repo attestation identity, and the pi-bash-parser vendor pin

**Status:** Accepted
**Date:** 2026-07-13
**Related:** [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) (psmfd/pi build-and-attest), [ADR-0040](0040-consume-psmfd-attested-pi-releases.md) (consume attested releases), [ADR-0011](0011-toolchain-install-strategy.md) (vendor-pin pattern), [ADR-0100](0100-bash-destructive-guard-ast-second-pass.md) (the guard that consumes the binary), #506

## Context and Problem Statement

Closing the `bash-destructive-guard` hand-lexer's ANSI-C / nested-substitution
gaps (#506) requires a real shell parser. pi's runtime blocks a pure-JS/WASM
solution: the shipped binary loads extensions through jiti with `tryNative:
false`, so an extension can `import` only the packages pi bundles — a
third-party `mvdan/sh` WASM package cannot be imported at runtime. The parser
must therefore be a **subprocess binary**: first-party Go (`psmfd/pi-bash-parser`),
`mvdan.cc/sh/v3`-backed, spawned by the guard.

That binary needs a build-and-attest release pipeline. `psmfd/pi` already has
one (`psmfd-release.yml`). The question is how to share it without regressing
pi's release trust properties.

## Decision Drivers

- The attestation signer identity that `gh attestation verify --signer-workflow`
  matches is the workflow file where `attest-build-provenance` **runs**
  (`job_workflow_ref`). Any change that moves that step changes the identity.
- pi_config's `bump-pi-runtime.sh`, ADR-0040, and the release runbook all pin
  `--signer-workflow psmfd/pi/.github/workflows/psmfd-release.yml`. That must not
  break.
- Don't duplicate the fail-closed draft→verify→publish boilerplate across repos.

## Considered Options

1. **Move preflight + attest + publish into one reusable workflow** (the naive
   "share the whole tail"). Rejected: putting `attest` in the reusable workflow
   flips pi's signer identity to the reusable file, breaking every existing
   consumer's verify command — a coordinated breaking migration, not a refactor.
2. **Give pi-bash-parser a fully standalone release workflow, share nothing.**
   Rejected: duplicates the security-critical publish boilerplate.
3. **Share the identity-neutral halves only; keep `build` + `attest` local
   (chosen).**

## Decision Outcome

Two `workflow_call` reusable workflows in `psmfd/pi`:

- `psmfd-reusable-preflight.yml` — validate a tag against a caller-supplied
  format ERE + main ancestry; output tag/tag_sha. Identity-neutral.
- `psmfd-reusable-publish.yml` — verify the caller's build artifacts, draft,
  re-verify the drafted bytes' checksums **and** attestation (against a
  `signer_workflow` **input**), then undraft. Identity-neutral: it creates no
  attestations.

`build` and `attest` stay **local to each caller** (`psmfd-release.yml`,
`pi-bash-parser/release.yml`). So each repo's binaries are attested under that
repo's own workflow identity, and pi's stays exactly
`psmfd/pi/.github/workflows/psmfd-release.yml` — no consumer breakage. The
reusable publish verifies against whatever `signer_workflow` the caller passes,
so each repo verifies against its own identity. This is the more principled
model (per-repo identity, not a shared signer) and a true refactor for pi.

Verified end-to-end by cutting `pi-bash-parser v0.1.0`: the release published,
the attestation verifies against the parser's own signer identity, and a
negative control against pi's signer correctly fails — proving identity
isolation.

### Vendor consumption (pi_config)

pi_config vendors the released binary as `agent/vendor/bash-parser/{VERSION,
CHECKSUMS,README}` (the ADR-0011 pattern) with digests harvested from the
**attestation-verified** release SHA256SUMS (ADR-0040 posture — the parser is
attested under its own identity). `ih_ensure_bash_parser` (install-helpers.sh)
platform-selects one of four tarballs, sha256-verifies, and links it to
`~/.local/bin/pi-bash-parser`; `validate-bash-parser-vendor.sh` structurally
validates the pin; `setup.sh` installs it as a guard runtime dependency (a
fetch, not a symlink, so it runs outside the dev-toolchain loop).

## Consequences

- Publish boilerplate is maintained once; new psmfd release pipelines call it.
- Per-repo attestation identity is preserved — the reason `attest` is not shared.
- Reusable workflows are `workflow_call`-only, called via local `./` refs (load
  from the protected default branch), and registered in
  `.psmfd/workflow-allowlist.yml`.
- Trade-off: two reusable workflows rather than one, because the caller's
  build-and-attest jobs must interleave between preflight and publish (a single
  reusable invocation cannot host caller jobs in the middle).
