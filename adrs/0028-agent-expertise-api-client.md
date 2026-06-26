---
status: Accepted
date: 2026-06-07
---

# ADR-0028: local write-capable `agent-expertise-api` client for pi

**Status:** Accepted
**Date:** 2026-06-07
**Related:** #149, #150, [`agent-expertise-api` hosting note](../notes/agent-expertise-api-hosting.md), [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md), [ADR-0021](0021-extension-type-checking-and-linting.md)

## Context and Problem Statement

Issue #149 tracks the pi-side integration of [`psmfd/agent-expertise-api`](https://github.com/psmfd/agent-expertise-api). The refreshed hosting note from #150 records the upstream state and deployment archetypes, but it is intentionally a reference note rather than a pi_config decision.

The first integration must be useful for the authoring workflow. A read-only lookup client is not sufficient: expertise has value only if pi can write newly discovered or corrected expertise back to the local API. At the same time, the API still has unresolved upstream readiness gates for Windows service upgrades, reboot/headless behavior, release-tarball install confidence, and the broader deployment threat model. The pi client therefore needs a narrow first phase that supports local authoring without making unsupported remote/team or Windows claims.

This ADR decides the first supported topology, auth and environment handling, tool surface, write controls, and trust boundary for the future `agent/extensions/expertise-client/` implementation.

## Considered Options

- **A. Read-only local lookup client.** Rejected. It minimizes risk but does not satisfy the intended authoring workflow; without write-back, the client cannot capture new expertise discovered during pi sessions.
- **B. Local loopback read + create client.** Chosen. It provides useful write-back while keeping blast radius bounded to a local API instance and a create-only write surface.
- **C. Full local CRUD client.** Rejected for phase 1. Update/delete/archive semantics need separate safety and audit treatment. Create-only is enough to prove the integration path.
- **D. Remote/team-hosted client from day one.** Rejected for phase 1. Remote write-back requires the upstream deployment threat model, stronger auth posture, and tenant/security semantics to be settled first.
- **E. Windows included in first support.** Rejected for phase 1. Upstream Windows service upgrade and headless/reboot readiness remain open.
- **F. OIDC production flow from day one.** Deferred. OIDC is the eventual non-local posture, but the phase-1 goal is a local authoring client against a loopback API requiring an API key.

## Decision Outcome

Build the first pi integration as a **local-only, Linux/macOS-only, API-key-authenticated, write-capable client** under a future `agent/extensions/expertise-client/` extension.

### Scope

Phase 1 supports:

- Linux and macOS only.
- A locally running `agent-expertise-api` reachable only through loopback.
- Default API base URL: `http://127.0.0.1:8080`.
- Optional base URL override via `PI_EXPERTISE_API_BASE_URL`.
- Hard refusal unless the configured base URL resolves to loopback.
- API key auth for every call via `PI_EXPERTISE_API_KEY`.
- A fixed extension-local env file path: `agent/extensions/expertise-client/.env.local`.
- A committed example env file in the implementation PR: `agent/extensions/expertise-client/.env.example`.
- Environment precedence: `process.env` overrides `.env.local`, and `.env.local` overrides built-in defaults.
- Exactly two initial tools:
  - `expertise_search` for read/search behavior.
  - `expertise_create` for create-only write-back.
- `expertise_create` requires `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1` in addition to API key auth.
- Every create request sends an `Idempotency-Key` header.
- Every tool call gates on `/health/ready` before attempting the operation.
- API responses are returned only as visible tool-call output.

### Non-scope

Phase 1 does not support:

- Anonymous LocalDev calls.
- Windows support claims.
- Remote/team-hosted APIs.
- OIDC production flow.
- Update, delete, archive, or other non-create writes.
- API-mediated inference routing.
- Treating the API as authoritative for agent selection.
- Project/repo settings for endpoint or credentials.
- Arbitrary `.env` discovery from the current repository.
- Any hook or event handler that injects API content as hidden/system context.

## Tool Contract Sketch

`expertise_search`:

- Requires a loopback base URL.
- Requires `PI_EXPERTISE_API_KEY`.
- Requires `/health/ready` to pass.
- Returns bounded, provenance-framed results as tool output.
- Does not mutate API state.

`expertise_create`:

- Requires a loopback base URL.
- Requires `PI_EXPERTISE_API_KEY`.
- Requires `/health/ready` to pass.
- Requires `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1`.
- Sends an `Idempotency-Key` header generated per create request.
- Creates a new expertise entry only; it does not update, delete, archive, or approve existing entries.
- Returns the created entry metadata and any API diagnostics as bounded, provenance-framed tool output.

Both tools must keep secret material out of returned `content`, `details`, logs, errors, refusal messages, and tests.

## Trust and Security Controls

Loopback is a network locality boundary, not an authentication boundary. The client therefore requires an API key even for local calls and refuses anonymous operation.

The implementation must enforce these controls:

- Refuse non-loopback base URLs in phase 1.
- Refuse missing or empty `PI_EXPERTISE_API_KEY` for all calls.
- Refuse `expertise_create` unless `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1`.
- Refuse to load endpoint or credential values from project/repo settings.
- Load only the fixed extension-local `.env.local` file; never search parent directories or arbitrary repo `.env` files.
- Never echo the API key or Authorization header.
- Treat all returned expertise content as untrusted.
- Cap response size and number of returned results.
- Frame returned content as advisory tool output, not authoritative routing instruction.
- Never emit API responses as `systemMessage`, system-role content, hidden context, or any equivalent network-sourced system-context injection.
- Use `/health/ready` only as readiness evidence, not as proof of authentication.

## Upstream Readiness Gates

The local phase-1 scope intentionally avoids several broader claims while upstream work remains open:

| Gate | Upstream issue | Applies when | Phase-1 posture |
|---|---|---|---|
| Windows upgrade while service is running | [`agent-expertise-api#140`](https://github.com/psmfd/agent-expertise-api/issues/140) | Windows support | Windows deferred. |
| Headless/reboot survival | [`agent-expertise-api#145`](https://github.com/psmfd/agent-expertise-api/issues/145) | Always-on/reboot-survival support claims | Do not promise reboot survival. |
| Service install readiness sweep | [`agent-expertise-api#230`](https://github.com/psmfd/agent-expertise-api/issues/230) | Author-ready native-service install claims | Keep setup docs conservative. |
| Signed release-tarball install / `--from-release` smoke | [`agent-expertise-api#249`](https://github.com/psmfd/agent-expertise-api/issues/249), [`#260`](https://github.com/psmfd/agent-expertise-api/issues/260) | Release-tarball install as supported path | Defer release-install claims. |
| Linux dependency bootstrap | [`agent-expertise-api#246`](https://github.com/psmfd/agent-expertise-api/issues/246), [`#247`](https://github.com/psmfd/agent-expertise-api/issues/247) | Automatic host dependency installation | Document prerequisites rather than promising bootstrap. |
| Install-smoke diagnostics/reliability | [`agent-expertise-api#262`](https://github.com/psmfd/agent-expertise-api/issues/262), [`#263`](https://github.com/psmfd/agent-expertise-api/issues/263) | Supportability claims | Keep troubleshooting guidance limited. |
| Deployment threat model | [`agent-expertise-api#226`](https://github.com/psmfd/agent-expertise-api/issues/226) | Remote/team or production trust posture | Remote/team support deferred. |

Closed upstream install-smoke evidence from [`agent-expertise-api#166`](https://github.com/psmfd/agent-expertise-api/issues/166) is useful background, but it does not expand this ADR's phase-1 support boundary.

## Implementation Acceptance Criteria

The future implementation PR must include:

- `agent/extensions/expertise-client/` with the standard TypeScript extension structure and per-extension `tsconfig.json`.
- `expertise_search` and `expertise_create` registered as separate tools.
- Env loading for `agent/extensions/expertise-client/.env.local` plus `process.env` precedence.
- `agent/extensions/expertise-client/.env.example` committed.
- The real `.env.local` ignored.
- Loopback-only base URL validation.
- API key requirement for all calls.
- `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1` requirement for create calls.
- `Idempotency-Key` generation for create calls.
- `/health/ready` preflight behavior.
- Bounded response handling.
- Tests for config precedence, loopback refusal, missing key refusal, health failure, search success, create opt-in refusal, create idempotency header, and secret non-disclosure.
- Integration into `scripts/validate.sh` through the extension typecheck/lint/test workflow required by ADR-0021.
- README documentation for refusal policy, env file handling, tool contract, and trust boundary.

## Consequences

- The first integration is useful for local expertise authoring because it can create entries.
- The first integration does not claim team, remote, Windows, OIDC, or production-readiness support.
- API keys remain local operator secrets and are not committed through project settings.
- The extension-local `.env.local` file is convenient but intentionally not discovered from arbitrary repositories.
- Remote/team support will require a new decision or ADR amendment covering OIDC, tenant/auth semantics, threat model updates, and non-loopback network policy.
- Update/delete/archive operations require a later capability split and review.

## Verification

This ADR is planning-only. Implementation verification is deferred to the future #149 implementation PR. At minimum, that PR must pass:

- The expertise-client unit test wrapper added for the extension.
- `./scripts/typecheck-extensions.sh`.
- `./scripts/lint-extensions.sh`.
- `./scripts/validate.sh`.
