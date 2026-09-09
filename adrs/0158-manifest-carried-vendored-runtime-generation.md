---
status: Accepted
date: 2026-09-04
---

# ADR-0158: vendor the expertise native runtime as a manifest-carried generation with a committed release archive

- **Status:** Accepted
- **Date:** 2026-09-04
- **Related:** [#4](https://github.com/psmfd/pi-config/issues/4), #1102, [ADR-0009](0009-pi-runtime-acquisition-strategy.md), [ADR-0119](0119-pi-bump-full-component-scope.md), [ADR-0132](0132-guard-mutation-verification.md), [ADR-0156](0156-capability-confined-native-expertise-loading.md), [ADR-0157](0157-provenance-checked-final-expertise-mutation-executors.md), [`agent/vendor/expertise-runtime/README.md`](../agent/vendor/expertise-runtime/README.md)

> **Amended by [ADR-0159](0159-code-owned-native-policy-pins-pi-executable-digest.md)**
> (2026-09-04): the compatibility tuple this ADR records as provenance is
> enforced by A2/P4 against a single code-owned policy constant; the Deferred
> item for P4 enforcement is delivered, and the installer's non-pruning of
> superseded generations is tracked in #1105.

## Context and problem statement

ADR-0157 requires a digest-attested installed generation for the local-expertise
native runtime, installed outside repositories and caches granted to
model-callable tools. A2/P3 (PR #1101) delivers the first such generation for
sqlite-vec `v0.1.9` on Linux ARM64.

Every existing vendored surface under `agent/vendor/` (pi, nvm, gh, yq,
ShellCheck, Gitleaks, bash-parser, landlock-run, cocoindex-code) records its
pin as `VERSION` plus `CHECKSUMS` files consumed by `setup.sh`. The runtime
generation needs more than that: per-file installed paths, modes, sizes,
digests, and a compatibility tuple, all bound into one document the installer
can validate as a closed schema. The required test stage also needs the exact
release bytes without network access, which no existing vendor surface
provides. Three conventions are new here and need a record:

1. a vendored surface whose integrity lives in a JSON manifest rather than in
   `VERSION` and `CHECKSUMS`;
2. a third-party binary release archive committed to the repository as a test
   fixture; and
3. a production entry point written in Python under `scripts/`, in a tree that
   is otherwise Bash.

## Decision outcome

Accept all three for the local-expertise runtime, with these constraints.

**Manifest-carried surface.** `agent/vendor/expertise-runtime/linux-arm64-v<N>.json`
is the pin. The installer treats every such file as the trusted set, targets
the highest version, enforces an exact key set, and binds the selector to the
canonical manifest digest. A shipped manifest is never edited; a change is a new
file with a new generation string. The manifest's compatibility tuple is
installed provenance; A2/P4 enforces it against the single code-owned policy,
whose pinned digests the installed selector and manifest must match (ADR-0159).
The surface has a row in
`docs/vendor-updates.md`'s vendored-surfaces table and a pi-component bump
checklist row, so a pi or sqlite-vec bump has an owner.

**Committed release archive.** The exact archive named by the manifest is
retained under `scripts/fixtures/p3-expertise-runtime/` so the required
`validate.sh` stage installs the production manifest and bytes on every PR
without a network dependency. The archive's digest equals the manifest's
`source.sha256`; CI fails if either drifts. The archive is small (61 KB),
dual-licensed Apache-2.0 or MIT and taken under MIT, and documented at its
location. This is a fixture, not a distribution channel: production acquires
from the upstream release URL.

**Python entry point.** The installer is Python because closed JSON schema
validation, `O_EXCL|O_NOFOLLOW` extraction without `tarfile.extractall`,
`fcntl` locking, and fsync discipline are materially safer there than in Bash.
A Bash wrapper keeps the invocation shape and exit-code contract of the rest of
`scripts/`. Python files under `scripts/` are syntax-checked by the P3 suite
before every run; `__pycache__` is ignored.

**Scope.** This ADR covers the local-expertise runtime generation only. A second
platform, a non-sqlite-vec artifact, or a manifest that adds executables,
wrappers, or workers extends or supersedes it. The generation-name binding to
the first file's digest prefix is a known limitation tracked in #1102.

## Considered options

### Reuse `VERSION` plus `CHECKSUMS`

Rejected. Two flat files cannot carry per-file installed paths, modes, sizes,
roles, or a compatibility tuple, and `setup.sh`'s consumers would have to grow
a second schema anyway.

### Download in the test stage instead of committing the archive

Rejected. The stage is a required check on every PR; a network dependency makes
it flaky and lets an upstream re-release change what the test exercises.

### Write the installer in Bash

Rejected. Safe tar extraction, exact-key JSON validation, and atomic
publish-and-select with fsync are error-prone in Bash and would repeat the
guard-by-guard hardening the Python version already carries.

### Choose a manifest-carried generation with a committed archive and a Python installer

Chosen, with the constraints above.

## Consequences

### Positive

- One closed document pins everything the installer validates.
- The required stage is deterministic and offline.
- Bump ownership is explicit through the vendor-updates rows.

### Negative

- A new schema and installer to maintain alongside the `VERSION`/`CHECKSUMS`
  surfaces.
- A binary blob in git history; kept small and single-purpose.
- Two languages under `scripts/`.

### Deferred

- Generation identity bound to the full manifest with a selector migration
  (#1102).
- A revocation floor before a second generation ships.
- ~~Compatibility-tuple enforcement (P4)~~ delivered by A2/P4 (PR #1104,
  ADR-0159); non-Linux-ARM64 generations and their independent runtime
  evidence remain deferred.
