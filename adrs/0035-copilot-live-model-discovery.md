---
status: Accepted
date: 2026-06-11
---

# ADR-0035: auto-router live GitHub Copilot model discovery

**Status:** Accepted
**Date:** 2026-06-11
**Tracking issue:** #343
**Related:** #330 / [ADR-0031](0031-auto-router.md) (auto-router), #327 (suite), [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md) (network-capable extensions + the `web_fetch` allowlist), [ADR-0026](0026-copilot-models-forward-fix-via-models-json.md) (Copilot models + tier gating), [`agent/rules/no-mcp-servers.md`](../agent/rules/no-mcp-servers.md) (no-MCP / injection policy)

## Context and Problem Statement

The auto-router builds its candidate menu from `ctx.modelRegistry.getAvailable()` — pi's **static** catalog filtered by credential. That over-reports: it lists `github-copilot` models the subscription cannot actually serve (tier-gated or picker-disabled), which then 400/403 when routed. **Reproduced live** during #338 probing: the router routed a simple prompt to `github-copilot/gpt-5.4-nano`, which the Copilot integration (`vscode-chat`) does not serve → `400 The requested model is not available for integrator "vscode-chat"`. The bug surfaces *after* routing (at provider-request time), so the router's existing classifier-failover cannot recover it.

GitHub Copilot exposes the truth at `GET {base}/models`, where each model carries `model_picker_enabled` and `policy.state`. The fix: filter `github-copilot` candidates to the genuinely-available set, while never breaking routing on any failure.

## Considered Options

1. **Manual allowlist only** — rely on the existing `getCandidates` allowlist (user lists working models). Rejected: static, per-host maintenance; doesn't track tier changes (e.g. the June 1 2026 AI-Credits shift that gated Opus to Business/Enterprise).
2. **`copilot_internal/user` → `endpoints.api` base resolution** (as #343 specced). Rejected: needs the OAuth `ghu_` refresh token, which `getApiKeyAndHeaders` does not expose; adds a roundtrip.
3. **Live `/models` discovery, base parsed from the JWT** (chosen).

## Decision Outcome

**Chosen: option 3 — a Copilot discovery module (`auto-router/copilot-discovery.ts`) that queries `/models`, filters by `model_picker_enabled === true && policy.state !== "disabled"`, and drops `github-copilot` candidates absent from that live set.**

- **Auth + base:** reuse pi's managed short-lived Copilot **JWT** via `ctx.modelRegistry.getApiKeyAndHeaders(<any available copilot model>)` (the same credential the classifier sends; the returned `headers` already carry `Copilot-Integration-Id: vscode-chat` etc.). The `/models` **base is parsed from the JWT's `proxy-ep=` field** (`proxy.individual.…` → `api.individual.…`) — exactly as pi's own `getGitHubCopilotBaseUrl` does — eliminating the `copilot_internal/user` roundtrip.
- **Integration:** `shared/candidates.ts` gains an optional `copilotFilter: ReadonlySet<string> | null`. A copilot candidate absent from a **non-empty** set is dropped; non-copilot candidates are untouched; it AND-composes with the existing `allowlist`.
- **Fail-open by contract:** every failure — no JWT, bad base, non-2xx, oversized/malformed body, redirect, **or a zero-enabled result** — returns `null`, and the static menu is used unchanged. A non-null return is always non-empty, so a failed/empty discovery can never empty the menu (the corrected design trap). When the live filter legitimately drains an all-Copilot menu, a distinct `copilot-filtered` reason drives an actionable toast ("gated by your subscription tier — use /model") instead of the misleading "no credentialed models."
- **Cache:** model-id sets only (never the JWT), module-level, 20-min wall-clock TTL (inside the ~25-min JWT lifetime), cleared on `session_start`.

### Security posture

- **No-MCP / injection: compliant.** The `/models` response only *filters a routing menu* — model ids never enter the model's context as instructions. This is not the ADR-046 injection vector; it is the same class as the classifier's existing provider call (`no-mcp-servers.md`).
- **ADR-0015 scope clarified (the gate the security review required):** ADR-0015's `ALLOWED_HOSTS` governs the **`web_fetch` TOOL** — agent-driven, prompt-synthesized URLs (the prompt-injection threat). It is **not** a repo-wide egress policy. This `/models` call is a first-party API call whose URL is assembled entirely in extension source from a JWT-derived base; no prompt or user string reaches the URL. It therefore does **not** route through the `web_fetch` allowlist, consistent with the classifier already calling the provider directly. This ADR is the explicit record ADR-0015's precedent clause asked for.
- **Host-pinning (defense-in-depth regardless of ADR-0015):** HTTPS-only; the base host must be one of exactly `api.individual.githubcopilot.com` / `api.business.githubcopilot.com` / `api.enterprise.githubcopilot.com`; `redirect: "error"` so a redirect can never carry the Bearer token off-host (the canonical SSRF credential-exfil vector).
- **Credential hygiene:** the JWT is sent only to those hosts, never logged, never persisted; only model-id strings are cached. Response handling caps the body (256 KB), validates the schema, and treats each id as an opaque, pattern-validated filter key.

## Consequences

- **Good:** the router stops offering phantom/tier-gated Copilot models; the `gpt-5.4-nano` 400 cannot recur (`nano` is not `model_picker_enabled`, so it never enters the menu). Routing never breaks (fail-open). No new dependency; the discovery module is injectable and fully unit-tested with a mocked `/models`.
- **Bad / costs:** one extra `/models` request per session (cached 20 min). Assumes the `/models` `id` matches pi's catalog id for `github-copilot` (they share the upstream source); an id-naming divergence would over-drop → drained-menu toast (recoverable via `/model`), never a crash. Non-`github-copilot` providers are unaffected (out of scope by design).
- **Neutral:** no cost-table change — Copilot has no per-model token-pricing API (usage-based AI Credits); routing among Copilot models stays capability-driven.

## More Information

- `agent/extensions/auto-router/copilot-discovery.ts`; the filter in `agent/extensions/shared/candidates.ts`; wiring in `auto-router/{route,policy,index}.ts`.
- Live repro + API verification: #343 (and the #330 research comment, 2026-06-09).
- Mechanics confirmed against pi v0.79.0's `getApiKeyAndHeaders` / `github-copilot` provider source.
