---
status: Accepted
date: 2026-07-23
---

# ADR-0123: provide typed read-only GitHub and Git tools

**Status:** Accepted
**Date:** 2026-07-23
**Related:** [ADR-0001](0001-subagent-orchestration-substrate.md), [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md), [ADR-0022](0022-gh-identity-guard-extension.md), [ADR-0091](0091-report-only-guard-profile.md), #875, #876, #881.

## Context and Problem Statement

Read-only specialists often need GitHub issue, pull-request, Actions, and project metadata alongside local Git history. Their existing choices are general-purpose `bash` plus `gh`/`git`, or the unauthenticated documentation-only `web_fetch` tool. Prose can ask an agent to run only read commands, but a bash allowlist in a prompt is not mechanical enforcement: `git branch`, `git tag`, `git reflog`, and `gh api` each contain mutating forms, and a child with GitHub tokens or `SSH_AUTH_SOCK` can bypass the intended role boundary.

Routing every query to `gh-cli-expert` preserves specialization but leaves cross-domain Git workflow analysis dependent on orchestrator fan-out and can produce misleading agent-local “could not inspect” statements. Expanding `web_fetch` to `api.github.com` would duplicate GitHub authentication, weaken its documentation-host trust boundary, and still not cover Projects v2 or CLI semantics cleanly.

The solution needs to cover routine reads without introducing an arbitrary authenticated API client, without changing the vendored subagent extension, and without claiming that one safe tool sandboxes every other tool in a process.

## Considered Options

1. **Continue routing all GitHub reads to existing specialists.** Lowest implementation cost, but it does not give Git workflow analysis an enforceable inspection capability and preserves the original failure mode.
2. **Permit read-only `gh` commands through `bash`.** Rejected as the primary control. Shell parsing and the breadth of `gh api` make a complete deny classifier fragile; credential-bearing bash remains a bypass.
3. **Add `api.github.com` to `web_fetch`.** Rejected. It would mix authenticated operational data with first-party documentation fetching and erode ADR-0015's purpose-specific allowlist.
4. **Provide one arbitrary REST-GET/GraphQL-query tool.** Rejected. Caller-controlled endpoints expose unintended private/account data, and arbitrary GraphQL cannot be made read-only by HTTP method because query transport commonly uses POST.
5. **Register typed domain tools behind a small loader, plus typed local Git inspection.** Chosen. Positive operation allowlists provide a reviewable mechanical boundary while dynamic activation keeps the initial tool schema small.

## Decision Outcome

Add first-party `github-read` and `git-read` extensions.

`github-read` registers `github_read`, a loader that additively activates typed repository, issue, pull-request, Actions, Projects, security, and notification tools. Each domain exposes a fixed operation enum and constrained arguments. Package-owned builders produce fixed `gh` argv arrays; a second invariant checker rejects unknown command prefixes, mutation methods/body flags, and mutation verbs. The runner uses `spawn` with `shell:false`, an explicit environment, identity observation immediately before each operation, timeout/output bounds, and no stdin. No caller supplies a CLI flag, endpoint, HTTP method, jq/template expression, or GraphQL document.

Security-alert and notification domains require literal user-layer opt-in under `extensionSettings.githubRead`; project settings and prompt content cannot enable them. Actions support metadata only. Logs and downloads remain deferred to #882 because they combine large output with a high probability of runtime-secret exposure.

Every GitHub result is projected to operation-owned fields, stripped of control characters, screened for token-shaped data, bounded, and labeled as untrusted tool-role content. Bodies/comments are opt-in. Pagination is one bounded page per call, with no automatic `--paginate` or rate-limit retry.

`git-read` exposes fixed local inspection operations. It uses shell-free argv, disables hooks/fsmonitor/pagers/optional locks, excludes GitHub and SSH credentials from the child environment, validates revisions and paths, and has no mutation operation. `gitflow-expert` loses `bash` and credential env allowances and receives only `git_read`, `github_read`, and file/documentation inspection tools.

The guarantee is intentionally scoped: calls through these tools are mechanically read-only. Another tool granted to the same process remains a separate capability. Wrapper allowlists are therefore part of the enforcement chain.

## Consequences

- Git and GitHub reads become independently reviewable capabilities rather than conventions inside an unrestricted shell.
- `gitflow-expert` can correlate local history with remote planning and delivery metadata without inheriting GitHub tokens or SSH agent access into bash.
- `gh-cli-expert` remains the owner of arbitrary GitHub CLI mechanics and explicitly authorized mutations; `work-item-management-expert` remains the owner of issue/project semantics.
- New GitHub surfaces require a typed operation and tests rather than an arbitrary endpoint escape hatch.
- Account-wide/sensitive reads are visibly opt-in and may still fail when the active token lacks permission.
- Every GitHub call adds an uncached identity probe. The latency is accepted for auditability and to avoid stale identity observations.
- Dynamic activation adds one tool round trip but avoids loading seven domain schemas into every prompt.
- GitHub Enterprise Server is not supported; the host is fixed to `github.com` pending a separate host/identity decision.

## Verification

- Catalog-wide tests construct every operation and assert its safe command prefix and absence of mutation/body arguments.
- Adversarial tests cover option prefixes, shell metacharacters, traversal, controls, NULs, token-shaped output, malformed JSON, identity failure, timeout, output overflow, sensitive-domain opt-in, and loader capability preservation.
- Fake `gh`/`git` executables keep required suites offline and inspect the effective environment/argv.
- Wrapper and skill changes are catalog-regenerated and validated against binding branch/commit policy.
- Required gates: `scripts/test-github-read.sh`, extension type-check and lint, full `scripts/validate.sh`, aggregate code/security/linter review.
