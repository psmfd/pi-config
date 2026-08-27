---
status: Accepted
date: 2026-08-26
---

# ADR-0149: Gitflow becomes local-LLM eligible after typed-tool hardening

**Status:** Accepted
**Date:** 2026-08-26
**Related:** [ADR-0085](0085-mutation-heavy-agents-stick-to-primary.md), [ADR-0094](0094-local-llm-role-lever.md), [ADR-0123](0123-typed-read-only-github-and-git-tools.md), and #1062
**Partially supersedes:** [ADR-0085](0085-mutation-heavy-agents-stick-to-primary.md) for `gitflow-expert` only

## Context and Problem Statement

ADR-0085 grouped `gitflow-expert` with interactive agents that inherited the non-local primary because they carried `bash` and ambient Git or GitHub mutation reach. ADR-0123 later removed `bash`, GitHub tokens, and SSH-agent access from `gitflow-expert`, replacing them with mechanically read-only `git_read` and `github_read` operations. The wrapper remained untagged for local use, so its model policy no longer matched its hardened tool boundary.

The local workhorse still has weaker demonstrated instruction discipline than frontier models. Tool safety therefore permits promotion only where the wrapper cannot mutate state; it does not erase separate quality requirements such as the review trio's `capability-tier: frontier` policy.

## Considered Options

### Keep Gitflow non-local

Rejected. This preserves an exclusion whose mutation-risk premise ADR-0123 removed, consumes cloud quota for ordinary read-only workflow inspection, and makes the wrapper taxonomy disagree with the structural `bash` floor.

### Make every non-`bash` wrapper local by default

Rejected. ADR-0094's explicit `local-llm: true` opt-in keeps untagged third-party and project wrappers fail-closed and allows quality-gated first-party exceptions. Tool safety is necessary but not sufficient for every specialist role.

### Explicitly promote Gitflow while retaining existing floors and exceptions

Accepted. Add `local-llm: true` only to `gitflow-expert`. Keep wrappers with `bash` or omitted tools structurally local-forbidden, and keep the review trio frontier-tiered rather than silently treating tool safety as review-quality evidence.

## Decision Outcome

`gitflow-expert` declares `local-llm: true`, increasing the explicit first-party local-eligible set from 13 to 14. Under `extensionSettings.localLlm.role: full`, the provider matrix may select the local-first `omlx/coding-workhorse` lane. Restricted local roles continue to remove local candidates, and local/provider outages continue through the existing matrix and liveness behavior.

The eligibility test pins the complete first-party set by name and verifies that every tagged wrapper declares tools and excludes `bash`. This makes future promotions deliberate rather than allowing a count-only test to accept an unintended substitution.

The observed failure that motivated broader behavioral scrutiny was not a Gitflow tool-safety failure: a locally-routed `pi-agent-expert` returned another delegation plan instead of performing requested repository research. That single observation does not establish model causation. Issue #1062 tracks repeatable behavioral batteries across all agents and effective model lanes; results may later tighten or broaden eligibility and capability-tier policy.

## Consequences

### Positive

- Gitflow advisory and inspection work can use local capacity without gaining a mutation path.
- Git and GitHub metadata can remain on the local inference path while typed tools retain their existing network and projection controls.
- The policy distinguishes mutation safety from high-assurance reasoning quality.
- An explicit expected-agent test makes eligibility changes review-visible.

### Negative

- Gitflow now shares local model capacity and inherits known local context/discipline limitations.
- A read-only model can still produce incorrect or destructive command recommendations even though it cannot execute them.
- Documentation must distinguish the original 13-wrapper pin migration from the current 14-wrapper eligibility set.

## Supersession Scope

ADR-0085 remains authoritative for the structural rule that wrappers carrying `bash` stay local-forbidden. Its classification of `gitflow-expert` as an interactive mutation-risk agent is superseded because ADR-0123 removed that capability. ADR-0094 remains authoritative for the global role lever, explicit per-agent opt-in, matrix selection, and fail-closed defaults.
