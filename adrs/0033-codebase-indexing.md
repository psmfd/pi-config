---
status: Accepted
date: 2026-06-10
---

# ADR-0033: codebase-indexing extension (custom, cocoindex-code engine)

**Status:** Accepted
**Date:** 2026-06-10
**Tracking issue:** #336
**Related:** #327 (suite), #328 (Phase 0 + amendment A), #337 (FTS5 fallback), [ADR-0030](0030-shared-foundation.md) (`shared/`), [ADR-0031](0031-auto-router.md) (build precedent), [ADR-0032](0032-context-manager.md) (reject-both-build-custom precedent), [ADR-0009](0009-pi-runtime-acquisition-strategy.md) (pin-not-copy), [ADR-0021](0021-extension-type-checking-and-linting.md) (no per-extension `package.json`), [`agent/rules/no-mcp-servers.md`](../agent/rules/no-mcp-servers.md) (no MCP)

## Context and Problem Statement

The Pi Extension Suite (#327) owns "tokens per retrieval" through the indexing workstream: give the agent a semantic `search_codebase` tool returning `file:line` snippets, so it locates relevant code by meaning instead of reading whole files. The plan ([`notes/pi-extension-suite-plan.md`](../notes/pi-extension-suite-plan.md) § "Workstream C") is **adopt-first**: adopt `pi-cocoindex` + the `cocoindex-code` (`ccc`) engine, building custom only if adoption fails.

Phase 0 (#328) found the plan's `pi-cocoindex` (elpapi42) **stale** and recorded **amendment A**: evaluate the active **`@pi-unipi/cocoindex`** as the adopt target instead. This ADR records the adoption decision after inspecting both candidates against their **published artifacts** (npm packages) and the shipped pi v0.79.0 docs.

Binding suite invariants in scope: **no MCP** (`agent/rules/no-mcp-servers.md`), **CLI tool-call path only** (results enter context as untrusted tool output), **no hook collisions** with auto-router (`before_agent_start`), context-manager (`context`), or compaction-optimizer (`session_before_compact`).

## Considered Options

1. **Adopt `@pi-unipi/cocoindex` v2.0.13** (MIT, active) — the amendment-A target.
2. **Adopt `pi-cocoindex` v1.0.2** (elpapi42, MIT) — the original plan target.
3. **Build a thin custom extension** that shells out to the `ccc` CLI (chosen).

### Why both candidates fail (inspection evidence)

| Candidate | Verdict | Evidence (published package) |
|---|---|---|
| `@pi-unipi/cocoindex` v2.0.13 | **Reject — wrong engine** | Targets the **`cocoindex` framework + LanceDB**, not `ccc`/`cocoindex-code`. Registers tools on `session_start`; **no `agent_end` background re-index** (manual `/unipi:cocoindex-update` only). Carries an unresolved **LanceDB AGPL-contamination caveat** (lancedb#1197) in its store closure. Adopting it would require re-building the `agent_end`/idle wiring anyway and switching engines away from the one #336 specifies. |
| `pi-cocoindex` v1.0.2 | **Reject — stale + incompatible** | Correct engine (`ccc`) and correct architecture (`agent_end` + `ccc status` idle gate). But **no activity since 2026-04-26**, and built on the abandoned **`@mariozechner/*`** package namespace (pre-rebrand) — incompatible with pi v0.79.0's `@earendil-works/*`; every file would need surgery. |

The **engine** (`cocoindex-code` `ccc` v0.2.35, Apache-2.0, 12 contributors, actively released) is healthy and is the real value. The pi-side wrapper is small. Building it custom — using `pi-cocoindex`'s MIT source as the reference for the `ccc` interface — eliminates the upstream-maintenance dependency, avoids the LanceDB AGPL risk entirely (`ccc` uses `sqlite-vec`), and satisfies every suite convention by design. This mirrors the [ADR-0032](0032-context-manager.md) outcome (reject both candidates → build custom).

## Decision Outcome

**Chosen: option 3 — a custom `agent/extensions/indexing/` extension over the `cocoindex-code` (`ccc`) CLI.**

### Design (verified against `ccc` 0.2.35 live + pi v0.79.0 docs)

- **`search_codebase` tool** (`pi.registerTool`, `extensions.md:1257`) shells out to `ccc search QUERY… --limit N [--lang L] [--path G]`. Always available; queries whatever index exists.
- **`agent_end` background re-index** (`extensions.md:530`) via `ccc index`, gated by `ctx.isIdle()`/`ctx.hasPendingMessages()` (`:936`), **single-flight** (in-flight lock) and **cooldown-throttled**. `ccc index` is incremental (a no-op when unchanged).
- **Git root** is the project boundary (`git rev-parse --show-toplevel`).
- State: one schema-versioned JSON file (`shared/state.ts`); `enabled` governs only the background re-index.

### Empirically verified behaviors that shaped the build

- `ccc search` **auto-starts the daemon** — the extension needs no daemon lifecycle management.
- `ccc` emits **no ANSI** when piped; the runner additionally sets `TERM=dumb`/`NO_COLOR=1`.
- **`ccc search` returns exit 0 even when uninitialized** (prints `Error: Not in an initialized project directory.`), so output content — not exit code alone — drives classification.
- Search output is a **fixed text format** (no `--json`); `ccc` is Alpha-status, so the parser is version-pinned and tolerant.

### Security gates (from the security review; baked into the design)

- **No MCP:** `cocoindex-code` ships an MCP server (`ccc mcp`, and the `cocoindex-code` console entry point). `assertCliInvocation` fails closed unless the binary basename is `ccc` and the subcommand is not `mcp`.
- **Untrusted output:** results are framed with an explicit untrusted-content header and hard-capped per-result and per-call (indexed files can carry injection strings).
- **Path containment:** a `--path` glob is rejected if absolute or containing `..`.
- **Pinned model + CVE floor:** the embedding model is pinned by HuggingFace revision (`d8c86521…`) + weights SHA-256 (TOFU mitigation); `transformers >= 5.3.0` (CVE-2026-4372). Telemetry disabled (`COCOINDEX_DISABLE_USAGE_TRACKING=1`).

### Toolchain pin (pin-not-copy, ADR-0009)

`ccc` is acquired out-of-band (`pipx install --python python3.13 'cocoindex-code[full]'`, Python ≥ 3.11), not by `setup.sh`. The pin under `agent/vendor/cocoindex-code/` is therefore a **verifiable record** (engine version + model revision + model file SHA-256), mirrored in `agent/extensions/indexing/pin.ts`, with a dedicated structural validator (`scripts/validate-cocoindex-code-vendor.sh`). The `[full]` extra runs embeddings locally (`snowflake-arctic-embed-xs`), so **no cloud key** is required.

## Consequences

- **Good:** semantic retrieval with no upstream-extension maintenance risk; full suite-convention compliance; no MCP; the LanceDB AGPL risk is avoided by construction.
- **Bad / costs:** a real external runtime dependency (Python ≥ 3.11, a ~500 MB–1 GB pipx venv, a ~90 MB one-time model download) — the first suite phase requiring an out-of-band install. The `ccc` text output is an Alpha-status, undocumented contract; the version pin + a tolerant parser mitigate drift.
- **#337 (FTS5 fallback):** the install footprint is non-trivial but is a one-time cost on a developer host with local embeddings working cleanly — **not** judged "too heavy" at adoption. #337 remains conditional and unbuilt; revisit only if the embedding footprint proves prohibitive in real use.
- **Neutral:** pi auto-loads the extension from `agent/extensions/indexing/index.ts`; no `settings.json` registration. `SKIP_INDEXING=1` stands it down for a project shipping its own `search_codebase`.

## More Information

- `agent/extensions/indexing/` — the implementation; `agent/vendor/cocoindex-code/` — the pin.
- [`notes/pi-extension-suite-plan.md`](../notes/pi-extension-suite-plan.md) § "Workstream C".
- Liveliness (2026-06-10): `cocoindex-code` **Active** (v0.2.35, Apache-2.0, multi-contributor, Low risk); `@pi-unipi/cocoindex` Active but Medium (single maintainer, young, wrong engine); `pi-cocoindex` **Stale** (High).
