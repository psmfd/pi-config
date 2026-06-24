# shared/ — Pi Extension Suite foundation

A small internal **library** consumed by the Pi Extension Suite extensions
(auto-router, context-manager, indexing). It is **not a loadable pi extension**:
it has no `index.ts`, so pi's auto-discovery (`~/.pi/agent/extensions/*/index.ts`)
skips it. Consumers import its modules by relative path, e.g.
`import { getUsage } from "../shared/signals.ts";`. See [ADR-0030](../../../adrs/0030-shared-foundation.md).

It is the single source of truth for context-usage signals, the credentialed
candidate-model menu, the cost table, notification formatting, and the
per-extension state convention — so no extension re-derives these or hardcodes
thresholds.

## Modules

| Module | Exports | Purpose |
|---|---|---|
| `signals.ts` | `getUsage`, `classify`, `THRESHOLDS`, `NormalizedUsage`, `UsageLevel` | Normalized view over `ctx.getContextUsage()` (`{ tokens, window, pct, level }`, `null` when unknown) + the suite thresholds `PRUNE_AT=0.70`, `ESCALATE_AT=0.85`, `FORCE_COMPACT_AT=0.90`. |
| `candidates.ts` | `getCandidates`, `Candidate`, `CandidateOptions` | Credentialed-model menu from `ctx.modelRegistry.getAvailable()`, optionally filtered by a `provider/id` allowlist. |
| `cost.ts` | `buildCostTable`, `lookupCost`, `normalizeCost`, `modelKey`, `ModelCost`, `ZERO_COST` | One per-model cost table (`input`/`output`/`cacheRead`/`cacheWrite` per MTok); local models priced at zero. |
| `notify.ts` | `notify`, `formatMessage`, `NotifyLevel` | `[pi-suite:<scope>]`-tagged notifications over `ctx.ui.notify`, guarded on `ctx.hasUI`. |
| `state.ts` | `loadState`, `saveState`, `stateFile`, `stateDir`, `STATE_SCHEMA_VERSION`, `VersionedState` | Schema-versioned per-extension JSON state under `~/.pi/agent/extensions/<namespace>/state.json` (ADR-0019 data subtree). No extension writes another's state. |

## Design contracts

- **Structural typing.** Each function types against the minimal slice of
  `ExtensionContext` it needs (e.g. `UsageContext`, `CandidatesContext`), so the
  pure logic unit-tests without a live pi runtime.
- **`null` means unknown.** `getUsage` returns `null` when usage or window size
  is unavailable (pi's `getContextUsage()` may be undefined) — callers must not
  treat `null` as "empty context".
- **Append-side / prefix-safe.** Nothing here rewrites the cached message prefix;
  consumers must prune the message tail (suite invariant — see the plan and #338).
- **No cross-extension state writes.** `state.ts` is namespaced per extension.

## API provenance

All runtime shapes verified against **pi v0.79.0** during Phase 0 (issue #328):
`ctx.getContextUsage()`, `ctx.model.contextWindow`, `ctx.modelRegistry.getAvailable()`,
and the model `cost` fields (`docs/extensions.md`, `docs/models.md`, `docs/sdk.md`).

## Tests

```sh
./scripts/test-shared.sh          # node:test via tsx; run from repo root
VERBOSE=1 ./scripts/test-shared.sh
```

Type-checking and linting are covered by the repo-wide `scripts/typecheck-extensions.sh`
and `scripts/lint-extensions.sh` (ADR-0021), which discover `shared/` automatically.
