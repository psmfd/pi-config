---
status: Accepted
date: 2026-06-08
---

# ADR-0029: expertise-client stands down when a project ships its own expertise tools

**Status:** Accepted
**Date:** 2026-06-08
**Related:** [ADR-0028](0028-agent-expertise-api-client.md) (client design and tool-name contract), [#149](https://github.com/psmfd/pi_config/issues/149), [`agent-expertise-api`](https://github.com/psmfd/agent-expertise-api)

## Context and Problem Statement

ADR-0028 specified the `expertise-client` extension with exactly two tools, `expertise_search` and `expertise_create`, and that decision fixed those names. The client is installed globally under `~/.pi/agent/extensions/`, so it loads for every pi session regardless of the working directory.

The upstream [`agent-expertise-api`](https://github.com/psmfd/agent-expertise-api) repository ships its own **project-local** pi extension at `.pi/extensions/expertise-api/` that registers the same two tool names (plus `expertise_get`, `expertise_update`, `expertise_approve`, `expertise_reject`, `expertise_delete`, `expertise_search_semantic`) directly against the in-process API.

pi requires tool names to be globally unique across all loaded extensions. Launching pi inside the `agent-expertise-api` repo therefore loads both the global client and the project-local extension, and the second-loaded one fails:

```text
Error: Failed to load extension ".../expertise-client/index.ts": Tool "expertise_search" conflicts with ".../agent-expertise-api/.pi/extensions/expertise-api/index.ts"
Error: Failed to load extension ".../expertise-client/index.ts": Tool "expertise_create" conflicts with ".../agent-expertise-api/.pi/extensions/expertise-api/index.ts"
```

This breaks `pi` startup in exactly the one repository where the in-process extension is the more capable, authoritative surface. ADR-0028 did not anticipate the name overlap with the API repo's own extension.

## Considered Options

- **A. Namespace the client tools** (`expertise_client_search` / `expertise_client_create`). Rejected for now. It lets both coexist everywhere, but it reverses the explicit tool-name contract in ADR-0028, changes the tool names every other project sees, and forces an ADR-0028 amendment for a problem that only manifests in one repo.
- **B. No-op the client when the project ships a conflicting extension.** Chosen. The global client is redundant inside a repo that already defines the same tools in-process; standing down lets the project-local extension win with the smallest blast radius and no change to tool names elsewhere.
- **C. Investigate a pi-native per-project disable mechanism.** Rejected as the primary fix. pi exposes no per-directory extension-disable hook at factory load time; relying on one would couple the fix to unshipped platform behavior.

## Decision Outcome

The `expertise-client` factory performs a **load-time coexistence check** before registering any tool. It stands down (registers nothing, leaving the project-local extension to claim the names) when either:

1. `SKIP_EXPERTISE_CLIENT` is truthy in the environment (explicit operator override), or
2. the current project ships a conflicting extension — detected by scanning `<cwd>/.pi/extensions/<dir>/index.ts` for a registration of `expertise_search` or `expertise_create`.

Detection is implemented in `agent/extensions/expertise-client/lib/coexist.ts` and:

- reads only the project-local extension discovery path (`<cwd>/.pi/extensions`), never parent directories or arbitrary repo files;
- covers both pi project-extension discovery forms (`docs/extensions.md`): the subdirectory form `<dir>/index.ts` and the single-file form `<name>.ts`;
- matches on the conflicting tool names rather than a hardcoded `expertise-api` directory name, so it remains correct if the upstream extension is renamed;
- caps each scanned file at 512 KB and the number of inspected extension directories at 100, bounding startup cost against a crafted project tree;
- **fails open** (registers normally) on any read error, so a detection failure degrades to the prior behavior rather than silently disabling the client.

When the client does stand down it emits a single line to stderr naming the reason, so an absent `expertise_search`/`expertise_create` is explainable rather than mysterious.

### Relationship to ADR-0028

This decision does not change the ADR-0028 tool-name contract, the loopback/API-key trust boundary, the create write-gate, or the env/credential handling. It adds a registration precondition only.

### Trust boundary note

The scan is a local conflict-avoidance check, not a configuration or credential source. It returns a boolean and a human-readable reason; it never reads endpoint or credential values from project files (which ADR-0028 § Trust and Security Controls prohibits) and never injects scanned file content into agent or system context.

## Consequences

- `pi` starts cleanly inside the `agent-expertise-api` repo: the project-local extension provides the full expertise tool surface and the global client steps aside.
- In every other project the client behaves exactly as ADR-0028 specified.
- `SKIP_EXPERTISE_CLIENT=1` gives operators a one-shot, shell-visible way to force the client off without removing it.
- The detection heuristic is source-text based. If a future project registers the conflicting names through indirection the regex cannot see — for example a template literal (`` name: `expertise_search` ``) or a name assembled at runtime — the client would not detect it and the original collision could recur; the `SKIP_EXPERTISE_CLIENT` override remains the fallback. Conversely, the regex also matches a tool-name registration that appears only inside a comment or string literal, which would cause a (harmless, fail-safe) stand-down; this is accepted because the project-local extension winning is the desired outcome whenever the name is present in the entry point.

## Verification

- `agent/extensions/expertise-client/test/coexist.test.ts` covers the override, the no-conflict case, conflict detection for both tool names and both quote styles, the subdirectory and single-file discovery forms, the unrelated-tool case, the scan-cap and entry-cap fail-open paths, and the empty-directory case.
- `./scripts/test-expertise-client.sh`, `./scripts/typecheck-extensions.sh`, `./scripts/lint-extensions.sh`, and `./scripts/validate.sh` must pass.
