---
status: Accepted
date: 2026-05-22
---

# ADR-0015: Network-capable extensions and the first-party-docs allowlist

**Status:** Accepted
**Date:** 2026-05-22
**Tracking issue:** #151
**Related:** [ADR-0001](0001-subagent-orchestration-substrate.md) (substrate for `agent/extensions/`), [`agent/rules/no-mcp-servers.md`](../agent/rules/no-mcp-servers.md)

## Contents

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [Consequences](#consequences)
- [Rejected: `web_search` companion tool](#rejected-web_search-companion-tool)
- [More Information](#more-information)

## Context and Problem Statement

Research-specialist subagents (`security-review-expert`, `code-review-expert`, `shell-expert`, the cloud and infrastructure specialists, language specialists, container/orchestration specialists, `docs-expert`) advertise in their descriptions that they corroborate findings against first-party documentation. Prior to this ADR, they could not: pi 0.75.4 ships only `read`, `bash`, `edit`, `write` built-ins, and the bare `web` tool listed in those wrappers' `tools:` frontmatter was a silent no-op (the subagent extension's `--tools` plumbing drops unknown tool names without warning — root cause tracked in #152). The result was opus-pinned reviewers citing from cached model knowledge and flagging claims as "not corroborated" when challenged.

The fix requires a pi extension that registers an HTTPS-capable tool. This is the first network-egress extension in `agent/extensions/` — every prior extension (`subagent/`, `secrets-guard/`, `bash-destructive-guard/`, `artifact-handoff/`) is local-only. The decision therefore is not just "ship `web_fetch`" but "what security boundary governs network egress from our extensions, and is that boundary policy-shaped enough to warrant an ADR rather than pattern-following?"

The decision is policy-shaped: the boundary chosen here will be the precedent every future network-capable extension references.

## Considered Options

1. **Tight host allowlist, hardcoded in the extension source.** Adding a host requires a PR. HTTPS-only. Manual redirect handling with per-hop allowlist re-validation.
2. **URL-pattern allowlist in a separate config file** (`agent/extensions/web-fetch/allowlist.yml` or similar). Adding a host edits config rather than code; potentially supports glob patterns and path prefixes.
3. **Validate scheme + size cap only, no host restriction.** Trust the operator-typed URL. Cheapest to implement; relies entirely on absence of prompt-injection-driven URL synthesis.
4. **Allowlist + URL signing.** Operator signs URL templates ahead of time; extension only fetches signed URLs. Strongest but operationally heavyweight for a docs-citation use case.
5. **Vendor an MCP-style web-fetch server.** Rejected pre-discussion under [`agent/rules/no-mcp-servers.md`](../agent/rules/no-mcp-servers.md).

The orchestrator's design-implications fan-out for #151 (3 parallel subagents: `pi-agent-expert`, `security-review-expert`, `docs-expert`) converged on tight-allowlist as the load-bearing security control. The agents independently identified prompt-injection-driven URL synthesis as the dominant threat and operator-curated allowlist-at-edit-time as the only defense that bounds it without relying on continuous reasoning-side discipline.

## Decision Outcome

**Chosen: Option 1 — tight host allowlist, hardcoded in `agent/extensions/web-fetch/index.ts`, HTTPS-only, manual redirect handling with per-hop re-validation.**

The implementation:

- `ALLOWED_HOSTS` is a `Set<string>` in the extension source. Adding a host requires a PR; the PR is the review surface.
- `https:` scheme is enforced as a hard refusal; `http:`, `file:`, `data:` and others refused with a clear error.
- 3xx redirects are followed manually (`fetch(..., { redirect: "manual" })`). Each hop's host is re-validated against `ALLOWED_HOSTS` before following. This defeats open-redirect bypass on hosts that allowlist a redirector parameter (e.g. `learn.microsoft.com/redirect?url=...`).
- Response bodies are read in full and truncated to 256 KB per the #151 acceptance criteria. Truncation is reported in the tool result `details`.
- No override mechanism. No `SKIP_WEB_FETCH_ALLOWLIST=1`. The allowlist is the policy surface and the only way to expand it is a reviewed PR.

The allowlist starts with ~20 hosts covering the documented domains of the 17 research specialists that will be granted the tool (see `agent/extensions/web-fetch/README.md` § Allowlist).

### Why allowlist-in-source, not allowlist-in-config

Option 2 (config-file allowlist) was considered and rejected for v1. A config file decouples the host list from the extension's git history in a way that makes "who added this host and why" harder to audit. Hardcoding in `index.ts` ensures the host list moves through the same code-review pipeline as the extension logic and shows up in `git blame`. The cost is a TypeScript edit per host addition; the benefit is that allowlist changes are visible in normal diffs without a separate config-file review surface.

If the allowlist grows past ~50 entries or starts needing path-prefix patterns (see `agent/extensions/web-fetch/README.md` § Note on `github.com`), revisit this decision.

### Why ADR-eligible despite extension-shape precedent

The pattern-following exemption in `agent/rules/adr-required.md` applies to extensions whose shape mirrors existing ones. `web_fetch` mirrors the shape of `artifact_review` (single registered tool, `typebox` schema, refusal-table README) but introduces a new substrate property: **network egress**. That property has no precedent in `agent/extensions/` and the policy boundary chosen here will be referenced by every future network-capable extension. The ADR exists to record that boundary explicitly, not the extension shape.

## Consequences

### Positive

- Research specialists can corroborate findings against authoritative sources; the "first-party-doc-backed" claim in `security-review-expert`'s description becomes structurally enforceable rather than aspirational.
- The allowlist is a single, auditable security surface. Threat-model conversations have a concrete artifact to point at.
- No credential storage, no API keys, no third-party-provider relationship. The extension is fully self-contained.
- Manual redirect handling defeats a class of open-redirector bypass attacks that auto-redirect modes do not.

### Negative

- Allowlist completeness is a moving target. Users will hit refusals for hosts we haven't listed; each addition is a PR. We accept this friction as the cost of the security boundary — silent allow-all would be cheaper but undermines the entire posture.
- The 256 KB body cap is sometimes wrong (longer doc pages are truncated mid-content). Mitigation: the cap is reported in `details.truncated` and `details.originalBytes` so the agent can warn the user; the agent can also fetch sub-paths if the documentation supports them.
- `github.com` is a high user-content-surface host on the allowlist (needed for upstream pi source, ADR references). This is a known trade-off documented in `agent/extensions/web-fetch/README.md` § Note on `github.com`. Path-prefix restriction is the upgrade path if abuse surfaces.
- This is the first extension with outbound network. Future incidents that involve network egress will reference this ADR.

### Neutral

- The extension does not interact with `secrets-guard`. `web_fetch` is read-only — it cannot write content to disk and cannot commit. The host allowlist bounds what content reaches the model.
- The extension does not interact with `bash-destructive-guard` (no shell invocation).
- Subagent wrappers that previously listed bare `web` are migrated to `web_fetch`; wrappers that do not need citation (`gh-cli-expert`, `gitflow-expert`, `work-item-management-expert`, `linter`, `checkmarx-expert`) drop the bare `web` declaration entirely.

## Rejected: `web_search` companion tool

A `web_search(query)` tool was scoped during the design-implications fan-out and **explicitly rejected for now**. The three-agent fan-out (`pi-agent-expert`, `security-review-expert`, `docs-expert`) unanimously identified the same load-bearing problem: search collapses the allowlist's primary guarantee. With `web_fetch` alone, an attacker must already control content at an allowlisted host to steer the agent. With `web_search`, the search provider becomes a URL-discovery oracle whose ranking attackers can influence via SEO/result poisoning. Mitigations exist (host-filter search results before the agent sees them, treat snippets as untrusted navigation only, choose a non-training-reuse provider, extend `secrets-guard` for provider API keys, add query-token-class filter and per-spawn query budget) but the combined surface is materially larger than `web_fetch` alone.

Specific rejections for v1, each of which would need to be revisited if `web_search` is ever proposed:

1. **Allowlist erosion** — search results not filtered through the same host allowlist degrade the allowlist to advisory.
2. **Query exfiltration asymmetry** — natural-language queries routinely contain class names, paths, project identifiers from the code under review; these leave the boundary even when results are host-filtered.
3. **Citation-replay break** — search results are time-varying and personalized; review verdicts cease to be reproducible from a stored query alone. This undermines [`agent/rules/structured-review-format.md`](../agent/rules/structured-review-format.md) and [`agent/rules/consensus-by-replication.md`](../agent/rules/consensus-by-replication.md).
4. **Credential surface** — every viable search provider (Brave, Kagi, Google PSE) requires an API key. This would be the first credential-bearing extension in `agent/extensions/` and would require `secrets-guard` SECRET_PATTERNS to be extended in lockstep.
5. **Policy interaction with [`no-mcp-servers.md`](../agent/rules/no-mcp-servers.md)** — search-provider responses are externally-authored content that flow into the agent's context window. The rule permits this as tool-result content (not system context) but the carve-out should be explicit before such a tool ships.

The agent fan-out outputs are summarized in this ADR's tracking issue. If `web_search` is ever revived, the design must address all five rejections and likely warrants its own ADR.

## More Information

- Tracking issue: #151
- Implementation: [`agent/extensions/web-fetch/`](../agent/extensions/web-fetch/)
- Related follow-ups: #152 (subagent unknown-tool diagnosability — the defect that masked the bare-`web` no-op for the lifetime of this repo), #153 (research-subagent issue-body access)
- Policy rule referenced: [`agent/rules/no-mcp-servers.md`](../agent/rules/no-mcp-servers.md)
