---
status: Superseded
date: 2026-09-01
---

# ADR-0152: add a user-level local SQLite expertise provider

- **Status:** Superseded by [ADR-0156](0156-capability-confined-native-expertise-loading.md) on 2026-09-01, the same day it was accepted.
- **Date:** 2026-09-01 (original acceptance; ADR-0152 to ADR-0157 were recovered from an archive snapshot and renumbered after ADR-0151, so their dates precede ADR-0151's)
- **Related:** [#4](https://github.com/psmfd/pi-config/issues/4), [#5](https://github.com/psmfd/pi-config/issues/5), [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md), [ADR-0029](0029-expertise-client-coexistence.md), [ADR-0067](0067-expertise-local-installer.md), [ADR-0095](0095-deterministic-expertise-fanout-gate.md), [ADR-0103](0103-upstream-expertise-static-oidc-consumption.md), [`notes/local-expertise-provider-plan.md`](../notes/local-expertise-provider-plan.md)

Superseded by ADR-0156 after the A2 spike found that the pinned Bun runtime exposes
no post-initialization native-loader revocation, which this ADR required. The
historical body below is preserved unchanged.

## Context and problem statement

The existing expertise integration is an HTTP client for
`agent-expertise-api`. ADR-0103 supports local-development API-key use and an
upstream bearer-token profile, while ADR-0095 consumes the same API through a
canonical research-fanout path. This remains the supported shared and remote
provider.

A user also needs expertise that is available across repositories without a
hosted resource, resident service, listener, or project-controlled data path.
The local option must be materially lighter than the current API deployment,
work at user/application scope, and retain enough application-level
compatibility that local and remote records can later be exchanged deliberately.
It must not turn "local" into an implicit network fallback or weaken the
existing write-approval, secret-scanning, and untrusted-content boundaries.

The feasibility research compared the current API, SimpleVecDB, other local
vector-store projects, stock SQLite, and SQLite with sqlite-vec. Small standalone
vector stores reduce initial code but add a second persistence contract and do
not provide SQLite's transactional migration, full-text search, backup, and
recovery base. SQLite plus sqlite-vec has the smallest credible operational
shape for this repository: one user-private database, no daemon, FTS5 keyword
retrieval, and exact vector retrieval in the pi process. Its native-extension
and pre-v1 status make a real Bun/runtime feasibility gate mandatory before
production implementation.

## Decision outcome

Add an internal expertise-provider boundary behind the existing
`expertise_search` and `expertise_create` tools. The first implementation has
two explicit modes:

- `remote`, preserving the current `agent-expertise-api` HTTP behavior; and
- `local`, using a user-level SQLite database with FTS5 and sqlite-vec, with no
  expertise network path reachable after explicit dependency/model install.

The tools keep their existing names and input schemas. Provider selection is an
operator decision from a trusted user-level source. A cloned repository cannot
select the provider, database, model, or native extension. There is no `auto`
mode, implicit fallback, dual write, or synchronization triggered by database
open, search, or create.

### User-level storage

The default database is outside every repository:

| Platform | Default |
|---|---|
| Linux | `$XDG_DATA_HOME/agent-expertise/expertise.db`, falling back to `~/.local/share/agent-expertise/expertise.db` |
| macOS | `~/Library/Application Support/agent-expertise/expertise.db` |
| Windows | `%LOCALAPPDATA%\agent-expertise\expertise.db` |

Initial production support is Linux and macOS, subject to the feasibility gate.
The schema reserves Windows-compatible paths and metadata, but no Windows
production claim is made until tested.

On POSIX, the data directory is `0700` and database, WAL, SHM, backup,
manifest, and lock files are `0600`. Every open revalidates the database and its
parents for ownership, regular-file type, symlinks/reparse points, and unsafe
permissions. A corrupt database is preserved and writes stop; it is never
silently replaced with an empty store.

### API-shaped canonical records

Text and provenance are canonical. Local entries retain the remote API's
application-level fields for identity, domain/tags, title/body, entry type,
severity, source/version, lifecycle, tenant/visibility, author, integrity,
review, and origin. Local-only metadata records schema and provider versions,
canonical content hash, local revision, embedding-pipeline identity, and future
remote mappings, tombstones, and cursors.

A local create that passes pi's existing human-approval and secret-scan gates is
stored as locally `Approved` and `Private` with local provenance. A future
remote push creates a remote `Draft`; local approval never confers remote
approval.

Embeddings are derived state. Their model, tokenizer, pipeline, dimension,
normalization, and distance metric are versioned. Missing or corrupt vector
state cannot make canonical text unavailable and can be rebuilt without
changing entry identity.

### Retrieval

Local search combines:

1. bounded FTS5 keyword retrieval;
2. one bounded local query embedding and exact sqlite-vec retrieval; and
3. reciprocal-rank fusion with API-compatible filtering and deterministic
   tie-breaking.

The target compatibility pipeline is `jina-embeddings-v2-small-en` at 512
dimensions, including compatible title/body construction, normalization, and
cosine behavior. The exact model, tokenizer, runtime, and artifact digests are
not selected by this ADR; the feasibility and retrieval phases must pin and
verify them before activation. Search and create may not download a model,
update it, emit telemetry, or fall back to a remote embedding service.

If semantic state is unavailable, keyword-only behavior is an explicit degraded
state. It is not represented as successful semantic retrieval. Exact vector
search is the initial choice because the expected corpus is small; approximate
nearest-neighbor indexing needs separate benchmark evidence and a later
decision.

### Native sqlite-vec boundary

Prefer application-registered or statically linked sqlite-vec support where the
runtime permits it. Otherwise load exactly one pinned native extension from an
absolute installation-owned path after checking owner, regular-file status,
parent permissions, architecture, ABI, version, and cryptographic digest.
Relative paths, current-directory lookup, search paths, symlinks, reparse
points, and writable parents are rejected. Extension loading is enabled only
during initialization and disabled immediately afterward.

The tool surface never exposes extension loading, arbitrary SQL, migrations, or
`ATTACH`. Values use parameterized statements; identifiers and operators come
from fixed allowlists. Vector type, dimension, byte length, and finite values
are checked before native calls. SQLite connections verify
`foreign_keys=ON` and `trusted_schema=OFF`; defensive and query-only modes are
used where the selected binding exposes them.

A real pi/Bun spike is a stop/go gate. It must prove safe loading, FTS5,
512-dimensional exact search, concurrent local behavior, offline embedding, and
initial Linux/macOS packaging. If that premise fails, implementation stops for
a separate decision. It does not silently introduce a Python process, HTTP
service, or other resident daemon.

### Recovery and portability

Migrations are application-owned, monotonic, transactional, and preceded by a
consistent backup. Backup uses SQLite's supported backup mechanism or a
transactionally consistent export, not a live copy of only the main file while
WAL is active. Multiple private generations use checksummed manifests. Restore,
interrupted writes, disk-full behavior, corruption, and complete vector rebuild
are required tests.

A versioned NDJSON application-record format provides import/export portability
and the substrate for future synchronization. Imports are untrusted, bounded,
transactional, idempotent, and subject to the same schema, secret, hygiene, and
write-approval controls. Imported vectors are not trusted by default; local
embeddings are recomputed. Credentials, approval tokens, migrations, native
binaries, local absolute paths, and private diagnostics are excluded.

### Synchronization boundary

Combined local/remote search and synchronization are deferred to #5. Future
synchronization must be explicit and previewed, with stable origin IDs, content
hashes, revisions, tombstones, mappings, cursors, authority rules, and conflict
handling. It may not use last-write-wins for security metadata, provenance,
visibility, approval, or deletion. Opening, searching, or creating local
expertise never synchronizes by side effect.

## Considered options

### Keep only `agent-expertise-api`

Rejected as the only option. It remains the remote/shared provider and the
compatibility reference, but even a local deployment requires a service,
authentication, installation, and lifecycle management that exceed the desired
user-level local footprint.

### Adopt SimpleVecDB

Rejected as the persistence foundation. Its small local API is attractive, but
it would establish a project-specific storage and migration contract while
still requiring this repository to add metadata filtering, full-text search,
transactions, backup/recovery, integrity handling, and API-compatible record
semantics.

### Adopt another standalone local vector database

Rejected for the first increment. A more active vector-only project may improve
maintenance signals but does not remove the operational or compatibility gaps,
and several alternatives introduce a server or heavier runtime.

### Use stock SQLite and FTS5 without vectors

Rejected as the complete solution. It is the safe degraded path and preserves
canonical records, but keyword-only retrieval is not sufficiently compatible
with the current semantic expertise behavior.

### Use SQLite, FTS5, and sqlite-vec

Chosen, subject to the runtime gate. It provides one transactional user-level
store, mature SQLite lifecycle facilities, built-in full-text retrieval, and a
small exact-vector extension without a listener or managed resource.

### Add a helper subprocess or local daemon

Rejected as an automatic design choice. A bounded CLI subprocess is one option
for a later stop decision if Bun cannot load sqlite-vec safely, but a resident
service would recreate the operational shape this decision is meant to avoid.

### Ship combined local/remote mode immediately

Rejected for sequencing and trust clarity. Explicit isolated modes make network
behavior auditable. Portability lands first; merging and synchronization follow
under #5 with independent authority and conflict semantics.

## Consequences

### Positive

- Expertise can follow the user across repositories without a hosted resource
  or standing service.
- Existing tool contracts and remote API behavior remain stable.
- SQLite supplies transactions, migrations, FTS5, integrity checks, and mature
  backup primitives in one local file set.
- Canonical records remain useful when embeddings are absent and can later be
  exchanged with the remote provider.
- Explicit mode selection makes the network boundary visible and testable.

### Negative

- sqlite-vec adds pinned native code, ABI/platform packaging, digest
  verification, and pre-v1 compatibility risk.
- The embedding model may dominate installed size and memory even though the
  database is light.
- The local provider adds schema, migration, recovery, and model-lifecycle code
  that the remote API currently owns.
- Local `Approved` and remote `Draft` are intentionally different lifecycle
  states and need mapping in future synchronization.
- Stock SQLite does not provide encryption at rest; this ADR makes no such
  claim.

### Deferred

- combined local/remote retrieval and bidirectional synchronization (#5);
- remote API changes;
- encryption at rest;
- approximate-nearest-neighbor indexing; and
- Windows production support unless the feasibility work clears it explicitly.
