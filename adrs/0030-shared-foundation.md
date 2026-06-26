---
status: Accepted
date: 2026-06-09
---

# ADR-0030: `shared/` foundation library for the Pi Extension Suite

**Status:** Accepted
**Date:** 2026-06-09
**Tracking issue:** #329
**Related:** #327 (suite), #328 (Phase 0 verification), [ADR-0019](0019-compaction-optimizer-extension.md) (per-extension `~/.pi/agent/extensions/<name>/` data subtree + `extensionSettings.<name>.*` namespace), [ADR-0021](0021-extension-type-checking-and-linting.md) (per-extension `tsconfig.json` + lint/typecheck discovery)

## Context and Problem Statement

The Pi Extension Suite (#327) builds three extensions — auto-router, context-manager, indexing — that must read the **same** signals: how full the context is, which credentialed models are available, what each model costs, and how to persist their own state. Duplicating that logic across three extensions would drift (three different thresholds, three cost tables) and violate the suite's "one signal source" design.

Phase 0 (#328) verified against the shipped **pi v0.79.0** distribution that the runtime exposes the needed surfaces: `ctx.getContextUsage()`, `ctx.model.contextWindow`, `ctx.modelRegistry.getAvailable()` (credentialed-only), and per-model `cost { input, output, cacheRead, cacheWrite }`.

Two questions need a recorded decision before the suite extensions consume the shared code:

1. **Where does shared code live, and how is it imported** across extension boundaries?
2. **What is the per-extension state convention** (location, format, versioning)?

## Considered Options

1. **Per-extension duplication** — copy signal/cost/state helpers into each extension's `lib/`. Rejected: guaranteed drift; the suite explicitly wants one source of truth.
2. **A published npm/git package** — extract `shared/` to its own distributable. Rejected as premature: internal-only, churns with the suite, and adds release overhead during active development. ADR-0021's npx-pinned no-install tooling assumes in-repo extensions.
3. **An in-repo `shared/` library dir under `agent/extensions/`, imported by relative path** — co-located with consumers, covered by existing typecheck/lint discovery, carried by `setup.sh`'s tree link. Chosen.
4. **A top-level `shared/` (outside `agent/extensions/`)** — would fall outside `typecheck-extensions.sh` / `lint-extensions.sh` discovery and outside the path the consuming extensions resolve relative imports against post-install. Rejected.

## Decision Outcome

**Chosen: option 3 — an in-repo, non-loadable `shared/` library dir at `agent/extensions/shared/`.**

### Layout and loading

- `shared/` contains `signals.ts`, `candidates.ts`, `cost.ts`, `notify.ts`, `state.ts`, a `tsconfig.json`, a `README.md`, and `test/*.test.ts`. **It deliberately has no `index.ts`.**
- pi auto-discovers extensions at `~/.pi/agent/extensions/*.ts` and `~/.pi/agent/extensions/*/index.ts` (pi v0.79.0 `docs/extensions.md` § Extension Locations). A directory **without** `index.ts` is therefore never loaded as an extension — so `shared/` ships alongside the loadable extensions (carried by `setup.sh`'s existing tree link) and is importable by them, without itself registering anything at runtime.
- Consumers import modules by **relative path with explicit `.ts` extension** — `import { getUsage } from "../shared/signals.ts";` — consistent with the existing intra-extension `./lib/*.ts` convention and ADR-0021's `allowImportingTsExtensions`. **No workspace linking, no per-extension `package.json`** (deps remain in the `extension-deps` cache).

### "Non-loadable library dir" as a convention

`agent/extensions/*/` may now contain either a **loadable extension** (`index.ts` present) or a **library** (`index.ts` absent, `tsconfig.json` + `README.md` present). `scripts/validate.sh` is updated to recognize the library form rather than erroring on the missing `index.ts`. `typecheck-extensions.sh` (discovers by `tsconfig.json`) and `lint-extensions.sh` (globs `**/*.ts`) already cover libraries with no change.

### State convention

- One JSON state file per extension at `~/.pi/agent/extensions/<namespace>/state.json`, matching ADR-0019's per-extension data subtree.
- Envelope is **schema-versioned**: `{ "v": 1, "data": … }`. A version mismatch or unparseable/missing file yields the caller's fallback (no v1 migration path). `STATE_SCHEMA_VERSION` is bumped only alongside a migration.
- **No extension writes another extension's state** — every `state.ts` call is namespaced. Cross-extension communication happens only through `shared/` pure functions and the live `ctx`, never via side-channel files.

### Thresholds (single source)

`signals.ts` owns `PRUNE_AT=0.70`, `ESCALATE_AT=0.85`, `FORCE_COMPACT_AT=0.90`. Router and context-manager read these; they never hardcode. `getUsage()` returns `null` when usage or window size is unavailable (pi's `getContextUsage()` may be undefined) — callers treat `null` as "unknown", never "empty".

## Consequences

- **Positive:** one signal/cost/state implementation; pure, structurally-typed functions that unit-test without a live runtime; zero new tooling (existing typecheck/lint/test patterns extend cleanly); the no-`index.ts` rule makes "not an extension" unambiguous to both pi and `validate.sh`.
- **Negative / trade-offs:** introduces a second dir-kind under `agent/extensions/` (library vs extension), which `validate.sh` must now distinguish — a small added rule, documented here and in `CONTRIBUTING.md`. Relative cross-extension imports (`../shared/…`) couple consumers to the sibling layout; acceptable for an internal, co-released library.
- **Follow-ups:** the cost table's per-model numbers come from the registry; the router (#330) may refine hints. The append-side/prefix-churn discipline that `shared/` enables is verified suite-wide in #338.

## More Information

- Phase 0 verification record + citations: issue #328.
- Plan of record: [`notes/pi-extension-suite-plan.md`](../notes/pi-extension-suite-plan.md) (rev 2) § "Shared Foundation".
