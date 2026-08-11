---
status: Accepted
date: 2026-07-27
---

# ADR-0127: Separate work-item credentials from package-agent consent

**Status:** Accepted
**Date:** 2026-07-27
**Superseded (in part) by:** [ADR-0128](0128-stage-package-agent-authorization.md) — only the assignment of grant creation to the approval broker (#916); #916 now persists inert, non-authorizing review drafts and #917 creates active grants under a distinct schema and digest domain. All other decisions here remain live
**Superseded (in part) by:** [ADR-0129](0129-package-agent-active-grant-authenticity.md) (Proposed) — §4's durable grant store, catalog-epoch-as-authority, and reload-to-activate model; §5's `grant revision` digest field (replaced by a runtime-scoped approval identifier); and §6's durable-epoch equality check and headless-grant-consumption allowance. Active-grant authority becomes runtime-scoped (bounded by the pi process, not the logical session) and in-memory. §4's prohibited-approval-channel enumeration, all other §5 digest contents, §6's collision/isolation/attestation/dispatch-revalidation rules, and §§1–3 and §7 remain live
**Amends:** [ADR-0042](0042-standalone-extension-distribution.md) (permits this package-specific multi-resource mirror)
**Related:** #913 (parent), #914 (this decision), #915 (typed work-item client), #916 (approval broker), #917 (provenance and dispatch enforcement), #918 (package distribution), #919 (aggregate validation), #920 (deferred canonical-public repository)

## Context and Problem Statement

Work-item management currently depends on specialists invoking `gh` or `az`
through the operator's ambient CLI sessions. The active identity and effective
scope can change independently of the agent invocation, and a broadly
credentialed shell offers more authority than the requested issue, project, or
board operation. The desired replacement is a standalone extension whose
remote authority is limited by a dedicated GitHub or Azure DevOps credential
and whose callable surface contains only reviewed, typed operations.

The extension should also be distributable with its skill, prompt, and optional
companion agent. Pi packages natively declare extensions, skills, prompts, and
themes, but not subagent wrappers. Teaching a package extension to register its
own wrapper automatically would make package installation silently alter the
orchestrator's routing surface. Project trust would not answer the separate
question of whether the operator accepts that agent's prompt, tools,
environment, and guard policy.

These are related but distinct boundaries:

1. **remote authority** — which GitHub or Azure DevOps operations a dedicated
   credential can perform;
2. **tool authority** — which typed operations the parent extension exposes;
3. **agent authority** — whether a package-provided wrapper may enter the
   subagent catalog; and
4. **package execution trust** — whether the operator accepts executable pi
   package code running with their OS permissions.

Conflating any two of them would create a misleading security claim.

## Considered Options

1. **Continue using ambient `gh` and `az` sessions.** Rejected. CLI state is a
   mutable, broadly reusable identity source and cannot mechanically restrict
   the extension to its own credential or typed operation set.
2. **Wrap generic shell, REST, or GraphQL access.** Rejected. Caller-controlled
   commands, methods, URLs, API paths, or GraphQL documents defeat positive
   operation allowlists, host pinning, response projection, and useful scope
   review.
3. **Install the extension but register its companion agent automatically.**
   Rejected. Installation is not informed consent to an agent definition, and
   an update could silently widen tools or alter its prompt.
4. **Approve agents by name, package version, or mutable reference.** Rejected.
   Those identifiers do not bind the exact executable and policy bytes that
   were reviewed.
5. **Expose approval as a model-callable tool or infer it from conversation.**
   Rejected. Model output, project instructions, package content, and
   extension-injected user messages are not operator authorization.
6. **Approve or activate agents in headless or RPC sessions.** Rejected for the
   initial design. An RPC peer can answer extension dialogs, but that proves
   protocol control rather than direct TUI operator input. Existing exact
   grants may be consumed headlessly only after full revalidation.
7. **Activate immediately in the approval handler.** Rejected. Dynamic
   registration would change the routing surface in the approving call frame
   and make activation harder to observe and revoke predictably.
8. **Make a new public repository canonical now.** Rejected for this phase.
   `pi_config` remains canonical and ADR-0042's derived-mirror model applies.
   Promotion of the package mirror to a canonical public repository is
   deferred to #920 and requires a future ADR.
9. **Treat package installation as sandboxing.** Rejected. Pi documents that
   extensions execute arbitrary code with the user's full system permissions.

## Decision Outcome

Adopt a **parent-owned typed work-item extension** and a separate **trusted
package-agent consent broker**. The optional companion agent is credentialless
and proposal-only. `pi_config` remains the canonical source and distributes the
combined resource set through a pinned, derived Git mirror under ADR-0042.

### 1. Standalone typed work-item extension

A first-party parent extension will register fixed operations for GitHub Issues,
GitHub Projects v2, and Azure DevOps Boards. It remains useful without any
companion agent.

Each operation owns its request method, path or static GraphQL document,
parameter schema, response schema, and projection. Callers may supply typed
identifiers and bounded field values, but never an absolute URL, host, HTTP
method, arbitrary API path, GraphQL document, CLI flag, or shell fragment.

The clients must:

- use HTTPS against enumerated first-party origins and supported API versions;
- construct destinations from validated organization, project, repository,
  and resource identifiers;
- disable redirects, or revalidate an unavoidable redirect before forwarding
  authorization;
- bound request and response sizes, pagination, and timeouts;
- validate content type, status, schema, and returned resource identity;
- project operation-owned fields, remove control characters, and scan output
  for token-shaped data; and
- fail closed on destination, identity, credential, response, or scope
  ambiguity, with no fallback transport or identity.

Mutating operations require an exact, visible TUI confirmation immediately
before dispatch. The confirmation displays provider, authenticated principal,
destination, operation, target, and security-relevant payload fields. JSON,
print, and RPC modes do not perform mutations in the initial implementation.

### 2. Dedicated credential boundary

GitHub and Azure DevOps use separate credentials dedicated to this extension.
GitHub should use a repository-limited fine-grained personal access token, or a
narrow GitHub App installation token when lifecycle requirements justify it.
Azure DevOps uses an organization-limited, minimum-scope, short-lived PAT until
a narrower supported identity is adopted. Provider-side repository, project,
and organization permissions remain authoritative.

Credentials come only from operator-owned fixed configuration or an explicit
absolute mounted-token file contract. Literal token environment variables,
project configuration, repository `.env` discovery, CLI credential stores,
browser sessions, Git credential helpers, and implicit cloud identities are
not credential sources. Ambiguous or partial configuration is an error.
Mounted credentials inherit ADR-0121's bounded file-consumption controls. The
path is absolute and operator-provided. Resolution walks every component
relative to an already-open directory descriptor (`openat`-style), with
no-follow semantics and directory/ownership checks at each step; separate
path-based prechecks such as `access` or `lstat` are prohibited. The final
opened descriptor is verified as a regular file and size-capped at 64 KiB.
Pre- and post-read `fstat` values — file identity, size, and highest-resolution
available modification/change metadata — must match before the trimmed value is
accepted. A platform unable to provide an equivalent race-resistant primitive
fails closed. Missing, empty, unreadable, oversized, changed-during-read,
symlinked, or non-regular sources fail without disclosing the path. Resolution
and open repeat per operation so an atomic regular-file replacement is
observed.

The extension must never place credentials or credential-file pointers in tool
parameters, results, prompts, transcripts, logs, telemetry, package files,
command arguments, or child environments. An authentication failure terminates
the operation; it never falls back to `gh`, `az`, another token, or an ambient
session. Rotation and revocation are operator actions, and error guidance must
not reveal credential values or sensitive paths.

The extension probes the authenticated principal through the same dedicated
client immediately before each mutation and binds the confirmation to that
observed identity. This is identity observation, not a claim that token scopes
can always be enumerated locally; the remote provider still enforces effective
scope.

### 3. Package layout and distribution

The derived `psmfd/pi-work-item-client` mirror will be installable as a pinned
Git pi package and contain:

```text
extensions/   standalone typed work-item client
skills/       work-item management guidance
prompts/      optional work-item workflow
agents/       inert broker-specific agent descriptor
package.json  native pi manifest for extensions/skills/prompts only
```

The package must not claim an unsupported `pi.agents` resource. Its versioned
`agents/` descriptor is inert data until the trusted broker validates and
approves it. Package filtering may disable native resources, but filtering is
not agent consent.

The source and release flow remains:

```text
pi_config canonical source
  -> outbound mirror staging and validation
  -> immutable mirror tag and release
  -> pinned `pi install git:...@<tag>` consumer entry
```

This decision **amends ADR-0042** with one package-specific content-shape
exception: a single derived mirror may combine one extension with its native
skill and prompt resources plus inert broker data when those resources form one
independently installable capability. ADR-0042's canonical-source, Git-install,
provenance, validation, and derived-mirror rules otherwise remain unchanged.
Issue #920 tracks a possible later promotion to a canonical public repository.
Until that decision lands, direct mirror edits are derived-state drift.

### 4. Explicit package-agent consent

The trusted subagent broker discovers package descriptors as **pending
proposals**, never active registrations. It exposes user-facing commands for
listing, inspecting, approving, rejecting, revoking, and showing status. The
approval path is not registered as a model-callable tool.

A new or changed proposal can be approved only in TUI mode through an explicit
operator command followed by a real confirmation over the complete effective
definition. Conversation text such as "approved," project trust, package
installation, a tool call, an RPC prompt, and extension-injected user messages
do not create a grant. Non-TUI modes fail closed for approval and alias changes.
Status and rejection remain non-authorizing, and revocation may proceed because
it can only narrow existing authority.

Approval persists an operator-owned grant but does not activate the agent in
the current runtime. The broker keeps two independent counters:

- a durable monotonic **catalog epoch**, advanced by every approval,
  invalidation, alias change, or revocation; and
- a monotonic **per-agent grant revision**, changed only when that qualified
  agent's grant changes and included in that grant's digest.

An approval transaction writes the new grant revision and advances the catalog
epoch atomically. The current runtime retains its earlier epoch snapshot and
therefore cannot activate the agent. The command reports that reload is
required. Reload reconstructs broker state at the durable epoch, then discovery
and validation run again. A later unrelated approval makes existing runtimes
stale until reload but does not invalidate other agents' grants; their stable
per-agent revisions remain valid in the new epoch. A handler that invokes
`await ctx.reload()` treats reload as terminal and returns immediately; it does
not use stale extension state after the call.

### 5. Content-bound grants

A grant is not a name allowlist. It binds a domain-separated canonical digest
covering at least:

- schema and policy versions;
- qualified package identity and source;
- resolved immutable revision and package integrity/tree digest;
- descriptor and wrapper bytes;
- complete system prompt;
- finite tool allowlist plus each effective tool's provenance, definition,
  parameter schema, prompt metadata, and implementation-content digest;
- child runner identity, version/content digest, argv policy, and the ordered,
  content-addressed extension/module closure;
- environment, model/capability, guard, and context-file policies;
- qualified agent identity and operator-selected local alias;
- the qualified agent's grant revision; and
- nonce and expiry.

Any relevant content, provenance, or policy change invalidates the grant and
returns the proposal to pending. Missing, stale, expired, ambiguous, or reused
approval evidence fails closed.

Grant state lives in an operator-owned subagent data directory, separate from
packages and projects. Directories and files use restrictive permissions;
symlinked, corrupt, or unexpectedly owned state is refused. Transactions write
a replacement file, `fsync` it, atomically rename it, and `fsync` the parent
directory before returning, so a completed revocation cannot roll back after a
crash. An audit record makes proposals, approvals, invalidations, and
revocations visible without recording secrets.

### 6. Collision, isolation, and dispatch revalidation

Package agents use qualified internal identities. A local alias requires
explicit approval. Protected-name, duplicate-alias, case-normalization, path,
and package-identity collisions are refused rather than resolved by load order.
A package agent must declare a finite tool allowlist; an omitted or unrestricted
surface is invalid. Package-agent children disable automatic user, project, and
package extension discovery. The broker loads only the ordered extension/module
closure explicitly approved and copied into its immutable snapshot. Built-in
tools are bound to the approved runner digest; extension tools are additionally
bound to source provenance, complete registered definition and schema, prompt
metadata, implementation bytes, and transitive runtime module closure. A child
startup attestation must show that the effective tools and event-handler
extension set exactly match the grant before any model turn or tool execution;
unknown, duplicate, overridden, dynamically added, or modified entries fail
closed.

Immediately before every spawn, the broker must reconstruct the **entire
canonical grant payload** from current state: schema and policy versions,
qualified package source and immutable revision, package/tree integrity,
descriptor and wrapper bytes, complete prompt, effective finite tools and
their definitions/provenance/implementation digests, runner identity and
digest, ordered extension/module closure, environment/model/guard/context
policies, qualified identity and alias, the per-agent grant revision, nonce,
and expiry. It recomputes the domain-separated
digest and requires an exact match to the durable grant. It also requires the
runtime's catalog-epoch snapshot to equal the durable epoch and consumes or
checks nonce state as defined by the operation.

Validation and process creation are one linearized dispatch transaction under
a cross-process broker lock. The broker writes a complete canonical grant
manifest — including provenance, schema/policy versions, qualified identity and
alias, grant revision, nonce, expiry, runner identity, tool definitions, and the
ordered extension/module closure — plus the verified in-memory wrapper, prompt,
descriptor, effective policy, runner, and approved extension/module bytes into
a broker-owned immutable snapshot. Canonical hashing of that manifest and those
exact files must equal the approved grant digest. The broker `fsync`s the
snapshot and spawns the child
exclusively from those bytes, never from a package-controlled path. The lock is
held through successful process creation or failure. Mutable,
unresolved, symlink-escaped, changed, widened, expired, replayed, stale, or
revoked inputs are refused. Work-item token values and token-file pointers are
stripped from children regardless of wrapper requests.

Revocation obtains the same exclusive lock, removes the grant, advances the
catalog epoch, durably commits both changes, and only then returns. This gives
dispatch and revocation a defined order: a child created before revocation's
linearization point may already be active, but no child can be created after
that point from the revoked grant. Active-child termination is best-effort and
is not the authorization guarantee. Retries, parallel tasks, and chain steps
acquire the lock and repeat the epoch plus full-digest comparison at dispatch;
they cannot rely on an earlier catalog lookup.

### 7. Credentialless companion agent

The optional package agent may inspect bounded, untrusted work-item context and
produce a schema-validated proposal. It cannot obtain extension credentials or
perform work-item mutations through `gh`, `az`, shell, arbitrary network tools,
or the parent extension's secret-bearing client.

The supported flow is:

```text
credentialless package agent
  -> typed proposal returned to the parent
  -> parent invokes the typed work-item extension
  -> extension observes identity, confirms exact mutation, and dispatches
```

This separation prevents package-agent approval from becoming implicit remote
mutation authority.

## Trust Boundary and Non-goals

Pi package extensions run in the same user security context and may execute
arbitrary code. Therefore, "extension-only credential" means the supported
configuration, tool, logging, and child-spawn paths do not expose the token. It
does **not** cryptographically isolate a credential from malicious executable
code running as the same OS user. A package that includes executable extension
code still requires the normal package-source review and trust decision.

This decision also does not:

- sandbox unrelated extensions or operating-system processes;
- guarantee that an operator-approved mutation is semantically wise;
- replace provider-side scope, expiration, rotation, or revocation;
- authorize arbitrary GitHub or Azure DevOps API access;
- make the package-agent broker specific to work-item management; or
- promote the derived mirror to a canonical public repository.

A stronger adversarial boundary would require a separate process or OS identity,
authenticated IPC, and filesystem/network isolation; that is outside #913.

## Consequences

- Remote authority becomes the intersection of provider token scope and a
  closed typed tool surface rather than the operator's ambient CLI session.
- The extension can be installed and used without accepting its companion
  agent.
- Package updates cannot silently widen an approved agent; changed bytes or
  policy require reapproval and reload.
- Headless automation is intentionally read-only in the initial design.
- The broker and package manifest form a versioned compatibility boundary that
  must be covered by contract fixtures and aggregate tests.
- Keeping `pi_config` canonical preserves the existing live development and
  mirror release machinery, while retaining mirror-sync and cross-repository
  provenance costs. #920 records the option to change that later.

## Verification

Implementation issues #915-#919 must collectively prove:

- credential source ambiguity, leakage, redirect, host, schema, output, and
  no-fallback failures are blocked;
- authenticated-principal observation and exact mutation confirmation occur
  immediately before dispatch;
- package descriptors remain inert before approval;
- model, extension-message, RPC, JSON, and print paths cannot create grants;
- digest changes, upgrades, collisions, symlink/path aliases, and reload
  generations invalidate stale authority;
- child environments contain no work-item token or credential-file source;
- revocation blocks queued retries, parallel tasks, and chain steps; and
- the staged mirror package contains only reviewed resources and installs from
  an immutable pin.
