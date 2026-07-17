---
status: Accepted
date: 2026-07-15
---

# ADR-0103: consume the upstream expertise bearer contract for static-OIDC clients

**Status:** Accepted
**Date:** 2026-07-15
**Supersedes:** [ADR-0028](0028-agent-expertise-api-client.md)
**Amends:** [ADR-0095](0095-deterministic-expertise-fanout-gate.md)
**Related:** #645, upstream [`agent-expertise-api` ADR-015](https://github.com/psmfd/agent-expertise-api/blob/dev/adrs/015-embedded-static-jwks.md)

## Context and Problem Statement

ADR-0028 deliberately limited the first pi client to a loopback API protected by
a Development API key. Upstream `agent-expertise-api` now ships the supported
LAN consumption solution: an operator generates per-client RS256 keys and
short-lived JWTs offline with `scripts/mint_token.py`, the API validates their
public keys from an embedded JWKS file, and clients consume the resulting bearer
through `EXPERTISE_API_BASE_URL` / `EXPERTISE_API_TOKEN` in
`~/.config/expertise-api/secrets.env`.

pi_config did not consume that contract. Its tool and deterministic fanout gate
understood only `PI_EXPERTISE_*`, rejected every non-loopback endpoint, and the
gate assumed the separately-installed client was a sibling extension. Direct
local search could work while canonical research fanouts silently skipped.
Building an OAuth login/refresh subsystem in pi would duplicate rather than
consume the upstream static-OIDC design.

## Considered Options

- **Keep loopback/API-key only.** Rejected. It prevents LAN VMs from consuming a
  host A2 deployment and leaves #645 unresolved.
- **Implement MSAL, PKCE, device login, and refresh in pi.** Rejected. Static
  OIDC already defines offline minting and rotation as operator actions; an
  in-client issuer is unnecessary and would expand credential custody.
- **Install upstream's full project-local pi extension globally.** Rejected.
  It collides with this distribution's `expertise_search`/`expertise_create`
  names and does not wire the deterministic fanout gate or existing approval
  controls.
- **Consume upstream's bearer/config contract in the shared client stack.**
  Chosen. It reuses the existing JWT issuance solution while preserving the
  hardened bounded transport, deterministic gate, and create approval model.

## Decision Outcome

The shared expertise client stack supports two explicit profiles:

1. **Local development (retained).** `PI_EXPERTISE_API_BASE_URL` plus
   `PI_EXPERTISE_API_KEY`, process env over the extension-owned `.env.local`.
   The endpoint remains loopback-only and may use HTTP.
2. **Upstream bearer (new).** `EXPERTISE_API_BASE_URL` plus
   `EXPERTISE_API_TOKEN`, process env over
   `~/.config/expertise-api/secrets.env`; `EXPERTISE_API_SECRETS_FILE` is the
   explicit operator override. A non-loopback endpoint must use HTTPS. Either
   upstream variable selects this profile and a partial pair fails closed.

The upstream token is pre-provisioned. For LAN static OIDC, the operator mints
it with upstream `scripts/mint_token.py`; pi does not mint, refresh, rotate, or
write credentials. A normal read-only agent token carries `expertise.read` and
`expertise.agent` (the minter shorthand is `read,agent`). A 401 returns redacted
replacement guidance rather than a generic authentication error.

Every request preserves the bounded body and no-redirect controls. Protected
requests send `Authorization: Bearer <credential>` plus
`X-Actor-Class: agent`; all requests send
`User-Agent: pi-coding-agent/pi-expertise-client`. The documented anonymous
`/health/ready` preflight intentionally omits the bearer.

The tool, fanout gate, and audit runner use the same parser. The gate checks the
source-tree and git-package locations for the legacy client file and consumes
the upstream fixed secrets file directly, removing the package-layout gap. Its
result projection accepts upstream's response-hygiene `{ value, ... }` wrappers
for `title` and `body`, so a successful modern API response is not projected to
an empty canonical block. `expertise_search`'s prompt contract directs pi to query prior knowledge before
non-trivial coding work; research-shaped fanouts remain mechanically prefetched
under ADR-0095.

Create remains create-only and requires
`PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1`, secret scanning, and (where the gate is
loaded) its single-use human-approval ledger. Supporting a bearer with broader
server scopes does not broaden the pi tool surface.

## Trust and Security Controls

- API-key mode remains loopback-only; bearer mode requires HTTPS off loopback.
- URL userinfo is refused and redirects remain disabled.
- Tokens are never returned in tool content/details, diagnostics, telemetry,
  or artifacts.
- `EXPERTISE_API_TOKEN` is stripped from every spawned subagent environment.
  `EXPERTISE_API_SECRETS_FILE` is replaced with `/dev/null` so a child extension
  cannot rediscover the default token file. Canonical expertise is fetched by
  the parent and injected as untrusted user-role task content.
- Operator files are fixed paths or explicit process-env overrides; project
  settings and repository `.env` discovery remain prohibited.
- Static-JWKS signing-key custody, token TTL, rotation, and revocation follow
  upstream ADR-015 and its LAN runbook. Private signing keys never belong in
  pi_config or the API host.

## Consequences

- LAN consumers can use the upstream supported static-OIDC JWT without a new pi
  identity subsystem.
- Local installations and `install-expertise.sh` keep their existing API-key
  behavior.
- The upstream environment names become a compatibility contract shared by the
  standalone tool and deterministic fanout gate.
- Access-token refresh remains out of scope. Operators replace expired static
  tokens according to the upstream runbook.
- The existing two-tool/create-only scope remains narrower than upstream's full
  project-local extension by design.

## Verification

- Config tests cover profile selection, precedence, partial-pair refusal,
  HTTPS-only remote use, loopback development, URL-userinfo refusal, and the
  upstream secrets-path override.
- HTTP tests verify bearer, actor-class, and User-Agent headers plus token-free
  401 guidance.
- Fanout tests prove static-OIDC HTTPS config and hygiene-wrapped results produce canonical injection.
- Subagent sanitizer tests prove the token and default secrets file do not reach
  children, even through hostile allowlists.
- Required gates: expertise-client, fanout-gate, subagent and shared tests;
  extension type-check/lint; `scripts/validate.sh`.
