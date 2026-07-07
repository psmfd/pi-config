# ADR-0083: Split orchestrator routing policy from subagent model pins

**Status:** Accepted
**Date:** 2026-07-07

## Context and Problem Statement

ADR-0076 established the role mapping for the model tier ladder: the parent/orchestrator should run on the session-default frontier tier, read-only specialist fan-out should use the local `omlx/coding-workhorse`, and the review trio should use Copilot-pinned opus. ADR-0078/ADR-0079 then made auto-router's deterministic capability matrix active by default.

Those two decisions interact poorly for operators who enable auto-router in the parent session. The committed routing matrix contains a local `omlx/coding-workhorse` row for common task types (`simple-qa`, `code-edit`, `code-review`, `agentic-loop`). With matrix routing enabled, a parent/orchestrator prompt classified into one of those task types can be routed to the local workhorse, even when the operator expects the primary session to remain on Copilot/frontier models and reserve the local model for subagent fan-out.

Subagent behavior is already protected by frontmatter pins and the explicit `--model` precedence guard: pinned children are spawned with `--model`, and auto-router is inert inside those child processes. The missing policy surface is therefore not in subagent spawning; it is an orchestrator-only routing restriction for the parent auto-router candidate menu.

## Considered Options

* **Option A — Explicit primary/orchestrator provider restriction in auto-router.** Add a persisted provider allowlist that only narrows auto-router's parent-session candidate menu. Leave subagent frontmatter pins and fallback behavior unchanged.
* **Option B — Disable auto-router whenever a local model is registered.** Prevents accidental local-primary routing but removes useful routing entirely for hosts that want dynamic Copilot/frontier selection.
* **Option C — Add Copilot rows to the routing matrix.** Lets Copilot compete in matrix routing, but still leaves a cost-ranked local row eligible for primary sessions and conflates parent policy with subagent fan-out policy.
* **Option D — Move model policy into the subagent extension only.** Preserves child behavior but does not address parent auto-router routing decisions.
* **Option E — Hard-code Copilot as the parent provider.** Satisfies one operator preference but removes portability for Anthropic/OpenAI/frontier-only users.

## Decision Outcome

Chosen option: **A — explicit primary/orchestrator provider restriction in auto-router**.

Auto-router gains a persisted `orchestratorAllowedProviders` state field. When non-empty, the parent session's routing candidate menu is restricted to those provider ids before classification and matrix routing. For example:

```text
/auto primary copilot
```

restricts parent routing candidates to `github-copilot/*`. The local `omlx/coding-workhorse` matrix row then cannot override the classifier for the parent session because it is not in the parent candidate menu. If the restriction leaves no credentialed candidates, routing keeps the current model and reports the provider-restriction miss instead of falling through to local.

The split is intentionally scoped to auto-router's parent-session `pi.setModel()` path. The subagent extension continues to own child process model selection: wrapper frontmatter pins are still resolved by the spawn-time gate, local pins still use `omlx/coding-workhorse` when available, the review trio remains pinned to `github-copilot/claude-opus-4.7`, and dropped non-Copilot pins still try the Copilot fallback rung from ADR-0080 before conceding to the session default.

The default restriction is empty, preserving existing behavior for operators who do not opt in.

## Consequences

* Good: Operators can enable auto-router while keeping the primary/orchestrator on Copilot or another chosen provider tier.
* Good: Local workhorse fan-out remains available to pinned read-only specialists without teaching auto-router a child-role taxonomy.
* Good: The change composes with the existing matrix routing implementation by narrowing the candidate menu before matrix override.
* Good: Backward compatibility is preserved because state loading merges old state files over the new default field.
* Bad: Unpinned child agents still inherit the active/default model. This is existing behavior and remains intentional; agents that must run outside the primary provider restriction need explicit frontmatter pins.
* Bad: Provider restrictions are coarser than model restrictions. Operators that need exact-model control should continue using the existing concrete `allowlist` or explicit `--model`.
* Neutral: The routing matrix remains unchanged. This ADR changes which candidates the parent session exposes to the matrix, not the matrix's capability claims.

## More Information

Implementation surfaces:

* `agent/extensions/auto-router/state.ts` — adds `orchestratorAllowedProviders` with default `[]`.
* `agent/extensions/shared/candidates.ts` — supports provider-level candidate filtering.
* `agent/extensions/auto-router/route.ts` — passes the primary provider restriction into candidate construction and reports an explicit empty-restriction outcome.
* `agent/extensions/auto-router/index.ts` — adds `/auto primary ...` controls and status output.
* `agent/extensions/auto-router/README.md` — documents the split and the commands.

Related ADRs: ADR-0031, ADR-0076, ADR-0078, ADR-0079, ADR-0080, ADR-0081, ADR-0082.
