---
status: Accepted
date: 2026-07-23
---

# ADR-0121: consume mounted OIDC tokens through an explicit file contract

**Status:** Accepted
**Date:** 2026-07-23
**Related:** [ADR-0103](0103-upstream-expertise-static-oidc-consumption.md) (upstream bearer profile and parent-owned credential boundary), [ADR-0095](0095-deterministic-expertise-fanout-gate.md) (shared client stack and deterministic search), [ADR-0001](0001-subagent-orchestration-substrate.md) (vendored subagent extension).

## Context and Problem Statement

ADR-0103 accepts a pre-provisioned upstream bearer only as the literal
`EXPERTISE_API_TOKEN` value. The operator now mounts a rotating OIDC token as a
mode-0600 file and configured the fixed consumer env file with shell command
substitution (`$(cat …)`). The minimal env parser intentionally treats values
literally and never executes shell, so the command text—not the token—became the
Authorization bearer and the API correctly returned 401.

Copying the current token into `secrets.env` would restore access but defeat the
mount's rotation semantics. Executing arbitrary env-file shell syntax would
broaden the credential trust boundary and introduce command execution into every
expertise tool call.

## Considered Options

1. **Explicit mounted-token file variable (chosen).** Add
   `EXPERTISE_API_TOKEN_FILE`; require an absolute operator-provided path, read a
   regular file through one descriptor on every config build, cap the read at
   64 KiB, trim surrounding whitespace, and fail closed on missing, empty,
   unreadable, oversized, relative, or ambiguous configuration.
2. **Evaluate `$(cat …)` or general shell syntax.** Rejected: env files are data,
   not executable configuration. General evaluation creates a command-execution
   surface and makes failures and auditing nondeterministic.
3. **Copy the mounted token into `EXPERTISE_API_TOKEN`.** Rejected as the durable
   design because rotation would not be observed until another process copied
   the replacement.
4. **Read one conventional mount path automatically.** Rejected: host-specific
   discovery would silently widen filesystem access and conflict with
   ADR-0103's fixed operator-source boundary.

## Decision Outcome

The upstream profile requires `EXPERTISE_API_BASE_URL` plus exactly one bearer
source:

- `EXPERTISE_API_TOKEN` for a literal pre-provisioned bearer; or
- `EXPERTISE_API_TOKEN_FILE` for an absolute mounted-token path.

Setting both sources is an error rather than a precedence rule. Token files are
read at the start of each tool/gate/audit operation, so atomic projected-secret
rotation is observed without restarting pi. Opening before type/size checking
keeps validation and the bounded read on one descriptor. Errors name only the
configuration variable and failure category; they never disclose the path or
credential.

The mounted path is credential-adjacent and remains parent-owned. The subagent
spawn sanitizer strips both `EXPERTISE_API_TOKEN` and
`EXPERTISE_API_TOKEN_FILE`, then replaces `EXPERTISE_API_SECRETS_FILE` with the
existing `/dev/null` sentinel so children cannot rediscover either bearer
source. Canonical expertise remains parent-fetched and user-role injected.

Shell interpolation and command substitution remain unsupported in env files.
This ADR extends rather than replaces ADR-0103's HTTPS, no-redirect,
operator-owned-source, and no-secret-output controls.

## Consequences

- **Positive:** mounted OIDC rotation works without token copying or process
  restart; the tool, fanout gate, and audit runner retain one shared parser.
- **Positive:** the configuration contract is explicit and testable, with no
  shell execution and bounded filesystem reads.
- **Neutral:** operators using literal tokens are unchanged.
- **Negative:** a rotated file that is briefly absent or empty causes a visible
  fail-closed refusal for that call; callers may retry after the mount settles.
- **Constraint:** token mounts must expose a regular file through an absolute
  path and remain readable by the pi process.
