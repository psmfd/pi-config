# agent/extensions/

Pi extensions installed at `~/.pi/agent/extensions/` via `setup.sh`. Each extension is a subdirectory containing an `index.ts` entry point and a `README.md` describing scope, hooks, and overrides. Extensions are loaded by pi at session start and run in the same process as the parent agent.

A subdirectory **without** an `index.ts` is a non-loadable **library** module, not an extension — pi auto-discovers only `*/index.ts`, so libraries ship alongside extensions (for relative `../shared/*.ts` imports) without being loaded. See [`shared/`](shared/README.md) — the Pi Extension Suite foundation (ADR-0030).

## Index

| Extension | Source | Snapshot | Purpose |
|---|---|---|---|
| [`subagent/`](subagent/README.md) | **Vendored** — `@earendil-works/pi-coding-agent@0.78.0` `examples/extensions/subagent/` ([upstream](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)) | pi `0.78.0` + 1 local patch | Delegates tasks to specialized subagents (single / parallel / chain) in isolated `pi` subprocesses. Substrate for the orchestrator-protocol routing in `agent/AGENTS.md`. |
| [`secrets-guard/`](secrets-guard/README.md) | **First-party** to this repo | n/a | Blocks `write` / `edit` / `bash` tool calls that would commit or surface secrets (PEM keys, AWS access keys, GitHub PATs, unencrypted vault files, sensitive paths). Runtime layer paired with the `hooks/secrets-guard.sh` git pre-commit hook. |
| [`bash-destructive-guard/`](bash-destructive-guard/README.md) | **First-party** to this repo | n/a | Denies `bash` tool calls invoking destructive verbs (`rm`, `mv`) against paths outside a configurable safe list. Companion to `secrets-guard`. |
| [`artifact-handoff/`](artifact-handoff/README.md) | **First-party** to this repo | n/a | Registers the `artifact_review` tool that writes Tier 3 review-artifact payloads under `.review/` (ADR-0006, ADR-0007). Path-confined to `.review/`; secrets-guard explicitly covers the tool name. |
| [`web-fetch/`](web-fetch/README.md) | **First-party** to this repo | n/a | Registers the `web_fetch` tool used by research-specialist subagents to corroborate findings against an operator-curated allowlist of first-party documentation hosts (ADR-0015). HTTPS-only, manual redirect re-validation, 256 KB body cap. |
| [`auto-router/`](auto-router/README.md) | **First-party** to this repo | n/a | Per-prompt model selection: a cheap classifier on `before_agent_start` picks a credentialed model and applies it via `pi.setModel` (with total fallback). Pi Extension Suite Workstream A; consumes [`shared/`](shared/README.md) (ADR-0031). |
| [`context-manager/`](context-manager/README.md) | **First-party** to this repo | n/a | Cache-safe, zero-token context pruning: the `context` hook elides oversized tool output, freezing each decision per `toolCallId` so the cached prefix never churns. Pi Extension Suite Workstream B; consumes [`shared/`](shared/README.md) (ADR-0032). |
| [`indexing/`](indexing/README.md) | **First-party** to this repo | n/a | Semantic `search_codebase` tool over the `cocoindex-code` (`ccc`) CLI engine, with an idle-gated, single-flight `agent_end` background re-index. CLI tool-call path only (no MCP); untrusted-output framing; pinned engine + embedding model. Pi Extension Suite Workstream C (ADR-0033). |
| [`cache-meter/`](cache-meter/README.md) | **First-party** to this repo | n/a | Read-only `message_end` recorder for the suite-wide prefix-churn / cache-ratio gate: appends per-turn token usage to JSONL when `CACHE_METER_CONFIG` is set (inert otherwise), analyzed offline by `scripts/analyze-cache-ratio.sh`. Never returns a replacement message. Pi Extension Suite cross-cutting (ADR-0034). |

## Conventions

- Every extension subdirectory MUST contain `index.ts` (the extension entry point) and `README.md` (purpose, hooks, overrides, refusal policy where applicable). A **library** subdirectory (no `index.ts`; e.g. [`shared/`](shared/README.md)) MUST instead contain `README.md` + `tsconfig.json`; `validate.sh` recognizes this form (ADR-0030).
- Vendored extensions MUST record the source pi version in their README, in the relevant commit message when bumped, and (if patched) in a "Local patches" table. See [`subagent/README.md`](subagent/README.md) for the canonical shape — patch description, file, line range, rationale, upstream issue link.
- First-party extensions MUST include a `## Refusal policy (per-rule)` section in the README when they implement pre-flight blocking, classifying each rule as **hard refusal** or **continue-eligible** per the pattern adopted from [issue #69](https://github.com/TheSemicolon/pi_config/issues/69). See `secrets-guard/README.md` and `bash-destructive-guard/README.md` for the table shape.
- Override mechanisms MUST be enumerated in the README (`SKIP_*=1` env vars, allowlist files, etc.) with scope and visibility properties.
- Architectural decisions affecting the extensions layer go in [`adrs/`](../../adrs/) per `agent/rules/adr-required.md`. Current ADRs touching this layer: [ADR-0001](../../adrs/0001-subagent-orchestration-substrate.md) (substrate decision for `subagent/`), [ADR-0005](../../adrs/0005-tool-call-journal-and-restore.md) (Proposed — future `tool-journal/` extension), [ADR-0006](../../adrs/0006-artifact-handoff-and-review-format.md) + [ADR-0007](../../adrs/0007-tier-3-payload-path.md) (substrate for `artifact-handoff/`), [ADR-0008](../../adrs/0008-tier-3-as-sole-intra-session-inter-agent-channel.md) (affirms Tier 3 as the sole intra-session inter-agent channel; supersedes ADR-0002).

## Snapshot-bump workflow (for `subagent/`)

The only vendored extension is `subagent/`. When bumping its snapshot:

1. Copy the new upstream source over `agent/extensions/subagent/index.ts` and `agents.ts` (do NOT touch the local `README.md`).
2. Re-apply the local patch listed in `subagent/README.md` § Local patches, verifying the line range still matches. Any patch that has been merged upstream can be dropped from the table.
3. Update the snapshot version in `subagent/README.md` (the opening blockquote near the top of the file, currently of the form `> **Vendored from pi <version>** ...`).
4. Commit with message `chore(extensions): bump subagent snapshot to pi <new-version>` per `agent/rules/conventional-commits.md`.
5. Run `scripts/validate.sh` and `/review` per `agent/rules/post-implementation-review.md` before opening the PR.

This procedure preserves the patch provenance across upstream changes and keeps the merge-conflict surface localized to the documented local patch zone.

## Deferred / future extensions

One extension is designed but not yet implemented; the follow-up issue is gated on ADR promotion:

- **`tool-journal/`** — pre-image snapshot + `restore` tool for write/edit/destructive-bash rollback. Design sketch in [ADR-0005](../../adrs/0005-tool-call-journal-and-restore.md).

### Decided against (do not relitigate)

- **`coms/`** (orchestrator-mediated filesystem journal for subagent-to-subagent evidence exchange) — superseded by [ADR-0008](../../adrs/0008-tier-3-as-sole-intra-session-inter-agent-channel.md), which affirms Tier 3 artifact handoff (`.review/` + `artifact_review` in [`artifact-handoff/`](artifact-handoff/README.md)) as the sole sanctioned intra-session inter-agent channel. Design archive: [ADR-0002](../../adrs/0002-agent-to-agent-channel.md) (Superseded) and [`agent/rules/agent-to-agent-channel.md`](../rules/agent-to-agent-channel.md) (Withdrawn). Re-evaluation trigger is recorded in ADR-0008.

See also [`notes/upstream-deferred.md`](../../notes/upstream-deferred.md) for the full triage record of upstream patterns evaluated and not adopted.
