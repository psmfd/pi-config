---
status: Accepted
date: 2026-09-01
---

# ADR-0157: require provenance-checked final executors for expertise mutation safety

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amends:** [ADR-0155](0155-tui-only-local-expertise-approval.md), [ADR-0156](0156-capability-confined-native-expertise-loading.md)
- **Related:** [#4](https://github.com/psmfd/pi-config/issues/4), [ADR-0132](0132-guard-mutation-verification.md), [ADR-0135](0135-core-tool-override-policy.md), [ADR-0146](0146-bash-tool-write-confinement.md), [ADR-0153](0153-explicit-remote-expertise-bootstrap.md), [A2 feasibility evidence](../notes/local-expertise-a2-feasibility.md), [`notes/local-expertise-provider-plan.md`](../notes/local-expertise-provider-plan.md)

> **Amended by [ADR-0159](0159-code-owned-native-policy-pins-pi-executable-digest.md)**
> (2026-09-04): the P4 required stage `9b-p4` this ADR names is delivered; its
> evidence boundary (loader-free seam legs versus Linux ARM64 production legs)
> and the pi-executable-digest pin are recorded there.

## Context and problem statement

ADR-0155 requires the supported model-callable `write`, `edit`, and shell paths
to be mechanically unable to mutate the expertise data root. ADR-0156 keeps A2
blocked until the installed pi runtime proves effective final-execution
ownership and fresh canaries for those paths.

The existing controls do not meet that gate. `tool_call` handlers run before a
tool executes and do not own the final filesystem operation. Hashline-edit
replaces `edit`, but it has an off-switch, permits operator containment
overrides, and performs its final filesystem mutation in the pi process. No
corresponding final `write` replacement exists. Bash-confinement exports policy
state, but its effect still depends on separately configured `shellPath`; its
`auto` mode may remain advisory, and the extension cannot verify the effective
shell setting from inside pi.

Pinned pi 0.84.2 supports same-name replacements for built-in tools and exposes
effective-tool `sourceInfo` through `pi.getAllTools()`. That metadata identifies
the implementation selected by the tool registry, but it is provenance, not a
security signature and not protection against arbitrary same-user or in-process
code. Registration success alone also does not prove that the expected executor
survives extension ordering, collisions, reload, or session replacement.

A2 therefore needs a concrete final-executor architecture and an installed-pi
feasibility gate before native or local-storage implementation continues.

## Decision outcome

### P2 is a hard feasibility gate

Before implementing the installed native generation or provider runtime, P2
must prove through the real installed pi entry path that all effective
model-callable mutation tools have the intended final owners:

- `edit` is the protected hashline-edit implementation;
- `write` is a same-name protected replacement; and
- `bash` is a same-name strict replacement. P2 proves its ownership and
  contract preservation; P5 proves that the replacement invokes the pinned
  confinement wrapper and launcher rather than trusting an ambient shell
  choice. The P2 probe's shell executor is not confined.

The probe must cover startup, reload, session replacement, extension ordering,
project-extension collisions, active-tool changes, effective provenance, and
deterministic disk-effect probes for the standard `write`, `edit`, and `bash`
paths. It must preserve hashline-edit's established schema
and result/detail contract for `edit` and the pinned built-in-compatible contracts
selected for `write` and `bash`. Activating `PI_HASHLINE_EDIT=0`, the protected
write/bash replacement's required `PI_EXPERTISE_MUTATION_BOUNDARY=0` off-switch,
or any generic confinement bypass must invalidate expertise readiness and refuse
protected mutation; the probe does not require a protected owner to remain active
after an intentional off-switch. Registration or a startup notice is not evidence.
In P2 the boundary and confinement switches are honoured by the test fixture's
own registration conditional, so those two legs prove fixture semantics only;
the hashline switch is the one enforced by an installed component. P5 must move
the other two into installed components. Protected-root canaries belong to
later A2 phases.
The probe must also exercise same-name registration after load, from an
extension handler. Measured on the pinned generation: such a registration is a
silent no-op against an extension-owned tool and a silent replacement of a
built-in-owned tool. The probe therefore proves both that protected owners
survive a later registration and that a takeover of an absent owner is visible
in `sourceInfo` and refuses readiness.

If ownership is ambiguous, a later registration can replace a protected
executor, the applicable per-tool contract cannot be preserved, or the installed
entry path cannot prove the selected owners, A2 remains Blocked. The
implementation stops before P3 and presents a separately approved pi change,
isolated invocation, or helper-process design. There is no automatic fallback.

### Final mutation executors

The supported configuration keeps the standard `write`, `edit`, and `bash`
names and the model-visible contracts already established for the pinned runtime:
hashline-edit's contract for `edit` and built-in-compatible contracts for `write`
and `bash`. It replaces their final executors rather than adding a second
model-visible tool surface or relying on a pre-execution hook.

`write` and `edit` compute and validate their requests in the pi process, but
every filesystem-changing operation runs in a short-lived Landlock-confined
worker. That includes temporary-file creation, content writes, permission
changes, replacement, rename, cleanup, and error recovery. The parent pi
process does not perform the final mutation. The worker receives only bounded
operation data and no native loader, database connection, credentials, or
arbitrary command capability.

The worker grants only the canonical target workspace and private per-operation
scratch required for the requested mutation. It never grants an expertise
protected root. Existing mutation queues, atomic-write behavior, guard parity,
and secret scanning remain intact. Each executor preserves its applicable schema,
prompt metadata, and exact result/detail contract for the pinned pi generation.

The `bash` replacement invokes the canonical installed wrapper directly with a
pinned launcher. Expertise-capable mutation requires a full Landlock probe and
the strict profile. `auto`, `advisory`, `off`, a missing policy state, a missing
or substituted wrapper or launcher, a non-full probe, an unsupported platform,
or `SKIP_BASH_CONFINEMENT` makes protected local mutation unavailable. A generic
operator bypass may continue to exist for ordinary pi use only if it
simultaneously invalidates expertise mutation readiness.

ADR-0135's mandatory diagnostic off-switch remains available. The protected
write/bash replacement adopts `PI_EXPERTISE_MUTATION_BOUNDARY=0`; hashline-edit
retains `PI_HASHLINE_EDIT=0`. Either switch may restore ordinary built-in behavior
for diagnosis, but protected local mutation must remain unavailable until a fresh
post-switch installed-pi readiness check succeeds with every protected owner.

### Protected roots and grant safety

The protected set includes:

- the expertise database and every WAL/SHM or journal sidecar;
- backups, staging, import/export activation state, manifests, and audit data;
- sqlite-vec, embedding native libraries, models, tokenizers, and compatibility
  manifests; and
- the installed executor, worker, wrapper, launcher, and their dependency and
  provenance closure.

Only trusted user-level configuration selects these roots. Project content,
model input, expertise records, tool arguments, environment values writable by
the model, and remote responses cannot select or weaken them.

Every effective read/write grant is canonicalized before execution. A grant is
rejected if it is equal to, inside, or an ancestor of a protected root, or if a
symlink, mount, device, or inode alias makes disjointness unverifiable. Existing
protected regular files must have one link; multiply linked mutation targets
are rejected. Missing, relative, substituted, wrong-owner, or unsafe-permission
state fails closed.

### Digest-attested installed generation

Security-critical files are copied into a versioned, user-owned installed
generation outside repositories, worktrees, and cache roots granted to
model-callable tools. They are not live symlinks into the repository. The
generation includes an installation manifest covering the complete executable
and imported dependency closure, expected canonical paths, ownership and mode,
digests, pi/Bun compatibility, wrapper, launcher, workers, extensions, native
artifacts, and model artifacts.

The generation is described as **digest-attested and inaccessible to the
supported model-callable final executors**, not immutable against the operating
user. Installation validates the complete generation before atomically
selecting it. Any missing file, symlink, unsafe owner or mode, digest mismatch,
unapproved dependency, or generation drift invalidates protected mutation.

### Fresh provenance and readiness checks

`sourceInfo` is used only as effective-tool provenance. It is combined with:

- canonical installed paths and complete closure digests;
- the pinned pi/Bun generation and exact tool result contracts;
- the current extension/session generation;
- active-tool state after startup, reload, and session replacement;
- strict wrapper and launcher identity;
- a full Landlock probe;
- canonical, disjoint grants and protected-root identity; and
- fresh real-entry disk canaries.

Reload and session replacement invalidate prior readiness. The supported local
provider must re-establish readiness before enabling any create, import,
bootstrap, approval, migration, recovery, or other protected mutation and must
recheck the effective owners immediately before each such operation. Missing,
stale, skipped, advisory, substituted, or unverifiable evidence refuses the
mutation. Read-only local behavior remains separately gated on opening the store
without writing.

### Verification

P2 first proves override feasibility. Its probe is
`scripts/test-p2-tool-ownership.sh`, a required `scripts/validate.sh` stage
(`9b-p2`) that needs `jq`, `node`, a sha256 tool, and the pinned pi generation
in the `fetch-pi-binary.sh` cache; an unavailable environment is a validation
failure, not a skip. P3's installer suite is
`scripts/test-p3-expertise-runtime-install.sh`, the required stage `9b-p3`; it
needs `python3`, `find`, `id`, a sha256 tool, and GNU or BSD `stat`, runs on
Linux and macOS, and exercises the production manifest against the committed
release archive (ADR-0158). The production installer refuses non-Linux-ARM64
hosts. P4's `scripts/test-p4-native-preflight.sh` is required stage `9b-p4`; it
drives the shared preflight through installed pi via a loader-free test seam so
every rejected tuple records its guard code, and on Linux ARM64 drives the
production initializer to load the exact selected artifact once, refuse a
retry, and keep SQL loading denied (ADR-0159). The probe pins generation-coupled expectations (tool
metadata, result shapes, the conflict diagnostic, and lifecycle counter
semantics); a pi bump re-validates them per the checklist in
`docs/vendor-updates.md`, and a changed contract shape is a review item under
this ADR, not a silent re-pin. Later A2 phases must add deterministic
installed-pi canaries for direct, relative, missing-leaf, symlink, hard-link,
rename, interpreter, subprocess, sidecar, reload, collision, and parallel race
attempts. Tests verify resulting filesystem state, not refusal text. Guard
mutation tests must prove the named tests fail when ownership, grant rejection,
digest verification, or worker confinement is removed.

P1–P8 remain separate sessions under the durable plan. This ADR does not open a
production local store, activate native loading, implement provider selection,
create/import/bootstrap/approval behavior, or begin A3 through A7 delivery.

### Residual boundary

This architecture narrows supported model-callable mutation paths. It does not
claim resistance to malicious same-user processes, arbitrary trusted or
malicious in-process extensions, debugger access, direct operator changes, or
replacement between native pathname verification and Bun's reopen. Landlock
confines only the spawned worker or shell child; it does not scope reads,
ambient credentials, or arbitrary code already executing in pi. These limits
remain those stated by ADR-0155 and ADR-0156.

## Considered options

### Keep only `tool_call` guards and path rewriting

Rejected. They are pre-execution middleware and do not own the final filesystem
operation, extension ordering, or pathname race boundary required by A2.

### Rely on user ownership and file modes

Rejected. The provider and model-callable pi tools run as the same OS user, so
ordinary ownership and mode bits do not separate them.

### Disable all standard mutation tools

Rejected. It would remove normal coding-agent functionality instead of
preserving it under a narrower final executor.

### Use protected same-name executors plus short-lived Landlock workers

Chosen. It preserves one standard tool surface, puts final file mutation inside
the OS-enforced child boundary, and gives the installed runtime a deterministic
ownership and canary contract.

### Introduce a daemon, separate OS identity, or automatic isolated fallback

Rejected for this increment as an unapproved architecture change. A bounded
helper or isolated invocation remains a stop-gate option only if P2 fails and a
new decision authorizes it.

## Consequences

### Positive

- A2 gains a concrete, testable final-executor ownership design.
- Standard tool names and guard integrations remain stable.
- Final `write` and `edit` filesystem operations move into a kernel-enforced
  child boundary instead of relying only on pathname preflight.
- Effective ownership, installation integrity, strict shell confinement, and
  real disk behavior become independent fail-closed checks.

### Negative

- The trusted implementation and installation closure grows to include three
  final executors, workers, wrapper, launcher, manifests, and compatibility logic.
- Exact result-shape compatibility and provenance checks bind the design to the
  pinned pi generation and must be revalidated on upgrades.
- Landlock limits initial production support to a proven Linux ARM64 host.
- Hard-link, grant-alias, reload, and collision cases add substantial installed
  canary and mutation-test work.

### Deferred

- Linux x64, macOS, and Windows mutation confinement;
- stronger isolation from arbitrary same-user or in-process code;
- read and ambient-credential confinement;
- any helper-process or separate-identity architecture after a P2 stop; and
- A7 bootstrap until agent-expertise-api #528 ships a verified export contract.
