---
status: Accepted
date: 2026-09-01
---

# ADR-0156: confine native expertise loading to a private provider capability

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** [ADR-0152](0152-local-sqlite-expertise-provider.md)
- **Related:** [#4](https://github.com/psmfd/pi-config/issues/4), [#5](https://github.com/psmfd/pi-config/issues/5), [agent-expertise-api #528](https://github.com/psmfd/agent-expertise-api/issues/528), [ADR-0146](0146-bash-tool-write-confinement.md), [ADR-0153](0153-explicit-remote-expertise-bootstrap.md), [ADR-0155](0155-tui-only-local-expertise-approval.md), [A2 feasibility evidence](../notes/local-expertise-a2-feasibility.md), [`notes/local-expertise-provider-plan.md`](../notes/local-expertise-provider-plan.md)

> **Amended by [ADR-0157](0157-provenance-checked-final-expertise-mutation-executors.md)**
> (2026-09-01): the installed-pi ownership evidence this ADR requires before A2
> can pass is defined as the P2 hard feasibility gate with final mutation
> executors. A2 remains blocked for production activation.

## Context and problem statement

ADR-0152 selected a user-level SQLite, FTS5, and sqlite-vec expertise provider
behind the stable expertise tools. It required native extension loading to be
enabled only during initialization and disabled immediately afterward. The A2
spike tested that premise in the installed pi 0.84.2 runtime, whose embedded Bun
reported version 1.3.10.

Bun's JavaScript `Database.loadExtension()` method successfully loaded the
verified sqlite-vec artifact, but Bun exposes no public API that revokes that
method afterward. SQL `load_extension()` remained unauthorized both before and
after the application-owned load. The literal ADR-0152 revocation requirement
is therefore unavailable in the selected runtime even though SQL-controlled
loading remains denied.

A direct malformed native load crashed Bun. Native identity and compatibility
checks must consequently reject unsafe candidates before Bun receives a path.
The spike proved path, type, symlink, and digest-first rejection, but it did not
implement the complete architecture and ABI gate or prove the production entry
path.

The same investigation established only Linux ARM64 component feasibility. It
did not establish generic Linux, macOS, Windows, or production support. It also
found that direct ONNX Runtime plus Tokenizers.js is a viable embedding
candidate, while the all-in-one Transformers.js path does not load in pi's
extension bundler.

## Decision outcome

Retain ADR-0152's provider boundary, stable tool contracts, user-level storage,
API-shaped records, explicit local/remote modes, no implicit network fallback,
rebuildable vectors, recovery model, and synchronization deferral. Replace its
native-loader revocation premise and platform sequencing with the controls in
this ADR.

ADR-0153 and ADR-0155 remain accepted constraints on the resulting provider.
Their references to ADR-0152 describe the decision lineage and do not weaken
this supersession.

### Capability-confined native initialization

The provider may call Bun's JavaScript `Database.loadExtension()` only from an
application-owned private initializer for a private connection. SQL
`load_extension()` must remain unauthorized. No tool, expertise record,
project-controlled input, configuration value, migration, query argument, or
public provider API may receive or control:

- the SQLite connection;
- arbitrary SQL, `ATTACH`, or migrations;
- the native loader function or a reference that can invoke it; or
- the native artifact path, manifest, or selection tuple.

This is capability confinement inside the supported provider design, not
revocation of Bun's JavaScript method and not isolation from arbitrary code
already running as the same user or inside the pi process. No documentation or
diagnostic may claim that pi or Bun disables `Database.loadExtension()` after
initialization.

### Fail-closed native preflight

Before Bun receives any native path, the production initializer must select
exactly one artifact from an installation-owned immutable manifest and verify:

1. the expected absolute path and canonical path are identical and remain under
   the trusted installation root;
2. every path component and the artifact pass `lstat` checks, with no symlink,
   reparse point, non-regular target, wrong owner, or unsafe parent permission;
3. the exact artifact bytes match the pinned cryptographic digest;
4. the file format, class, endianness, operating system, CPU architecture, and
   dynamic ABI match the approved platform tuple; and
5. the tuple pins the pi/Bun compatibility envelope, sqlite-vec version, native
   artifact identity, and supported libc or platform ABI.

Unknown, malformed, substituted, writable, mismatched, or unverifiable state
fails closed before `Database.loadExtension()` is called. Static parsing filters
incompatible artifacts; it does not prove arbitrary native-code safety. The
pinned digest identifies the reviewed artifact, and an isolated runtime test
proves that exact artifact works with the selected pi/Bun generation.

The current path-based Bun API leaves a same-user time-of-check/time-of-use
residual because it reopens a pathname rather than an already verified file
descriptor. That residual remains inside ADR-0155's explicit same-user
limitation and must not be represented as eliminated.

### Sequencing and stop gates

A2 remains Blocked as the integrated production-runtime gate until all of these
are proven through the installed production entry path:

- complete native path, type, ownership, permission, digest, architecture, ABI,
  and compatibility-manifest rejection before any load;
- malformed and wrong-platform artifacts never reaching Bun;
- effective final-execution ownership and fresh installed-state canaries for
  model-callable `write`, `edit`, and shell mutation paths under ADR-0155;
- strict shell-wrapper and operating-system confinement verification; and
- syscall or packet evidence that local embedding and provider operations make
  no runtime network attempts.

A3 may proceed while A2 is blocked, but only to establish the provider
interface, preserve the remote implementation, and add an inert or read-only
local seam/test double. A3 does not clear A2 and may not activate sqlite-vec,
open a production local store, implement local mutation or approval, or begin
A4 through A7 delivery. A4 through A6 remain gated by the applicable A2 runtime
and mutation-boundary evidence.

A7 remote bootstrap remains independently blocked on
[agent-expertise-api #528](https://github.com/psmfd/agent-expertise-api/issues/528)
until a released, fixture-verified contract can enumerate the complete
Approved and pending-review corpus with bounded snapshot or reconciliation
semantics required by ADR-0153.

### Platform and embedding scope

Linux ARM64 is the only exercised runtime. It is the first candidate production
target, but no production platform is supported until A2 passes. Linux x64,
macOS ARM64, macOS x64, and Windows remain untested or out of initial scope; the
existence or checksum of a published artifact is not runtime-support evidence.

Direct `onnxruntime-node@1.29.0` plus
`@huggingface/tokenizers@0.1.3` remains the embedding candidate. It is not yet an
adopted production dependency. Activation requires immutable package, native,
model, tokenizer, and configuration digests; install-script and supply-chain
review; golden compatibility vectors; telemetry disablement; corrupt-artifact
and dimension tests; target-binary pruning; and runtime network-attempt
instrumentation. The failed Transformers.js bundle path is rejected for this
runtime generation.

## Considered options

### Retain literal post-initialization revocation

Rejected because Bun exposes no public API to revoke the JavaScript loader
method. Documenting revocation would claim a control the runtime does not have.

### Treat SQL `load_extension()` denial as the only control

Rejected. SQL denial prevents SQL-controlled loading but does not validate the
artifact passed by application code and does not keep a malformed binary from
crashing Bun.

### Use a private initializer plus fail-closed artifact verification

Chosen. It keeps native selection outside model and expertise control, preserves
SQL denial, and rejects untrusted artifacts before entering Bun while stating
its same-user and in-process limits honestly.

### Add a helper daemon or subprocess automatically

Rejected as an implicit architecture change. A bounded helper remains an option
only after a separate stop decision and ADR; no resident service is introduced
by this decision.

### Block all work until every production gate and remote export exist

Rejected. The provider abstraction and remote-preserving seam can be developed
and tested without native loading, local mutation, or remote bootstrap. Those
later capabilities remain fail-closed at their own gates.

## Consequences

### Positive

- The architecture matches the actual pinned pi/Bun capability instead of
  claiming unavailable loader revocation.
- Native artifact selection and validation remain outside project, model, and
  expertise control.
- A3 can isolate provider behavior without prematurely activating local native
  or mutation paths.
- Runtime, platform, write-boundary, and bootstrap evidence remain explicit
  gates rather than implied support.

### Negative

- The JavaScript loader method remains callable by arbitrary same-user or
  malicious in-process code, consistent with the documented threat boundary.
- Complete native preflight, production-entry testing, mutation-tool ownership,
  and installed-state canaries add implementation work before activation.
- Initial production scope narrows from the aspirational Linux-and-macOS target
  in ADR-0152 to a Linux ARM64 candidate.
- A7 cannot ship until the upstream export contract is available and verified.

### Deferred

- Linux x64 and macOS runtime and confinement support;
- Windows production support;
- stronger same-user isolation or a separately authorized helper process;
- remote bootstrap until agent-expertise-api #528 is delivered; and
- combined retrieval and synchronization under #5.
