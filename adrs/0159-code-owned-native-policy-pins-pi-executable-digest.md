---
status: Accepted
date: 2026-09-04
---

# ADR-0159: pin the P4 native policy to the pi executable digest at the passwd-home cache path

- **Status:** Accepted
- **Date:** 2026-09-04
- **Amends:** [ADR-0157](0157-provenance-checked-final-expertise-mutation-executors.md), [ADR-0158](0158-manifest-carried-vendored-runtime-generation.md)
- **Related:** [#4](https://github.com/psmfd/pi-config/issues/4), #1102, #1105, #1107, PR #1104, [ADR-0156](0156-capability-confined-native-expertise-loading.md), [`agent/vendor/expertise-runtime/README.md`](../agent/vendor/expertise-runtime/README.md), [`scripts/fixtures/p4-native-preflight/README.md`](../scripts/fixtures/p4-native-preflight/README.md)

## Context and problem statement

ADR-0156 requires the A2/P4 preflight to pin "the pi/Bun compatibility
envelope, sqlite-vec version, native artifact identity, and supported libc or
platform ABI" before Bun receives a native path. ADR-0158 records the
compatibility tuple in the shipped manifest as provenance. PR #1104 implements
the preflight in `agent/extensions/shared/expertise-native-runtime.ts` and made
three choices that neither ADR records:

1. how the running pi is identified;
2. where the pi executable is expected to live; and
3. where the policy lives and how it is selected.

The review of PR #1104 also found that five documents described the policy as
"keyed by the canonical installed-manifest digest" while the code held a
one-entry map looked up by its own constant, and that the test suite's
"zero loader calls" evidence came from a loader-free seam rather than from the
production initializer. Those corrections need a decision record so the next
generation bump does not reintroduce the drift.

## Considered options

### Identify pi by version string

The manifest's `compatibility.pi` and `agent/vendor/pi/VERSION` both carry
`v0.84.2-psmfd.1`. Rejected as the sole identity: a version string is not the
bytes. The psmfd mirror applies security patches under the same version, the
embedded Bun cannot report the pi patch level, and a replaced executable under
the same name would pass.

### Identify pi by the SHA-256 of the executable at a fixed path (chosen)

The policy pins `piExecutableSha256` and requires
`realpath(process.execPath)` to equal
`<passwd home>/.cache/pi_config/pi-<version>/pi/pi`. The digest differs per
platform, so each supported platform needs its own measurement; only Linux
ARM64 exists today. The cost is that every pi bump requires re-measurement,
which `docs/vendor-updates.md` row 9 owns and the required stage's portable
leg (`policy_pi_version`) turns red when `VERSION` moves without the policy.

### Honour `XDG_CACHE_HOME` for the pi path

`scripts/lib/fetch-pi-binary.sh` and the P2/P4 harnesses locate the pi cache
under `${XDG_CACHE_HOME:-$HOME/.cache}`. Rejected for the trust decision:
ADR-0156 forbids environment-selected inputs to the loader path, and the P3
installer already derives the home from the passwd database rather than
`HOME`. A host that relocates the cache fails closed with
`P4_RUNTIME_PI_PATH`; the vendor README says so.

### Carry the policy in the manifest

Rejected: the installed manifest is same-user data. The tuple stays in the
manifest as provenance and the enforcing values stay in reviewed source.

### Digest-keyed policy map

A map from installed-manifest digest to policy would let several generations
be selectable. Rejected for now: one generation exists, and keyed dispatch
without the revocation floor tracked in #1102 would keep every policy that
ever shipped selectable. The code holds a single constant,
`PRODUCTION_NATIVE_POLICY`; the installed selector and manifest must hash to
the digests it pins. P4 also requires `generations/` to hold exactly that
generation, which the installer does not yet prune (#1105).

### Single code-owned constant (chosen)

As above. A second generation is a new constant plus the #1102/#1105 work.

## Decision outcome

Chosen: the pi executable digest at the fixed passwd-home cache path, held in
a single code-owned policy constant.

The evidence boundary is recorded with it. Seam legs in
`scripts/test-p4-native-preflight.sh` run the shared preflight through a
loader-free test seam and prove each refusal code; their zero loader calls are
a property of the seam. Production legs drive `loadExpertiseNativeRuntime()`
against the real installation on Linux ARM64 only and are the behavioural
evidence for exact-once loading, the attempt latch, and SQL-loader denial. The
required `validate` job runs on x86_64 and skips them; the ARM64 self-hosted
lane runs them as a hard step, and requiring that check is #1107. Two loader
guards (exact-once call, latch order) keep structural source checks as their
registered mutation expectation because no portable behavioural leg exists.

### Consequences

- A pi bump, a host glibc major upgrade, or a change to the Bun or SQLite
  embedded in pi fails stage `9b-p4` on Linux ARM64 until the policy is
  re-measured (`docs/vendor-updates.md` rows 9 and 10).
- Hosts with `XDG_CACHE_HOME` set cannot use native loading.
- The manifest's compatibility tuple and the policy can only drift in the
  direction the preflight refuses.
- Documentation must describe the constant, not a keyed lookup, until #1102
  and #1105 change the design.

### Deferred

- Digest-keyed policy selection with a revocation floor (#1102).
- Installer pruning or a relaxed inventory rule for superseded generations
  (#1105).
- A required ARM64 check (#1107) and second-uid owner coverage (#1108).
- Non-Linux-ARM64 policies.
