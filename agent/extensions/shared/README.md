# shared/ — Pi Extension Suite foundation

A small internal **library** consumed by the Pi Extension Suite extensions
(auto-router, context-manager, indexing, subagent) and the bash-guard family
(bash-destructive-guard, via `shell-lex.ts`). It is **not a loadable pi extension**:
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
| `shell-lex.ts` | `lex`, `preprocessCommand`, `deglueWordSubstitutions`, `stripEnvAssignments`, `hasMinusC`, `Segment`, `Redirect` | Quote-aware shell-command lexer for the bash-guard family (ADR-0072): segments a raw command on unquoted control operators, joins quote-adjacent words, normalizes `$IFS`, captures stdin/pipe-sink/redirection, and degluing word-internal empty command substitutions. Parsing only — the consuming guard owns policy. **Not** a POSIX parser; value-dependent expansion is out of scope by design. |
| `task-types.ts` | `MATRIX_TASK_TYPES`, `MatrixTaskType` | Closed task taxonomy shared by classifier parsing and strict matrix validation, preventing lockstep drift. |
| `routing-matrix.json` | — (data, no code) | Hand-authored capability floor per task type (#350/#363): which models clear the bar for each classifier-emitted task-type label. Seeded with the `omlx/coding-workhorse` row; human-reviewed, never auto-written. **Consulted by auto-router's `resolveByTaskType` since #352** (ADR-0078) when matrix routing is enabled — closed-world for matrix picks. Structure/staleness is guarded by the strict loader, tests, and `validate.sh` (`9b-routing-matrix-bis`). |
| `routing-matrix.ts` | `defaultMatrixPath`, `loadRoutingMatrixResult`, `loadRoutingMatrix` | Strict typed loader for matrix metadata/rows (#747): stable diagnostics distinguish missing, unreadable, invalid JSON/schema/version, and stale policy, while retaining each reviewed rationale for the read-only proposal report (#750). The compatibility adapter preserves fail-soft `null` routing behavior. Schema/lifecycle reference: [standalone matrix lifecycle v1](https://github.com/psmfd/pi-auto-router/blob/main/MATRIX_LIFECYCLE_V1.md). |
| `model-ranking.ts` | `costRank`, `orderRankedCandidates`, `resolveCapabilityPick` | Shared deterministic model ranking primitives (#658): capability floor first, then local-first lane when local use is allowed, then cheapest-capable ranking (`input + k·output`, k=1), then context-window and `provider/id` tie-breaks. Used by auto-router and subagent provider policy. |
| `availability-snapshot.ts` | `buildAvailabilitySnapshot`, `getAvailabilitySnapshot`, `peekAvailabilitySnapshot`, `clearAvailabilitySnapshot`, `AvailabilitySnapshot` | ADR-0104 canonical registry + Copilot/Anthropic/oMLX availability generation shared by parent and subagent. One registry read, immutable sorted candidates/filter evidence, stable SHA-256, session-frozen cache with prior-generation cancellation; read-only peek never starts discovery; no credentials or capability mutation. |
| `copilot-discovery.ts` | `resolveCopilotFilter`, `getEnabledCopilotModels`, `clearCopilotCache`, … | Live GitHub Copilot `/models` tier discovery (ADR-0035; moved here from auto-router in #536). Fail-open, host-pinned, five-second bounded, 20-min cache of model-id strings only — never the JWT. Cache epochs reject stale in-flight writes after clear. Consumed through the canonical snapshot. |
| `anthropic-discovery.ts` | `resolveAnthropicFilter`, `getServedAnthropicModels`, `clearAnthropicCache`, … | Live Anthropic `/v1/models` discovery (#538; moved to shared by ADR-0104): filters retired ids, host-pinned, five-second bounded and fail-open, with a 20-min model-id-only cache. Cache epochs reject stale in-flight writes after clear. Consumed through the canonical snapshot. |
| `omlx-discovery.ts` | `resolveOmlxFilter`, `getServedOmlxModels`, `clearOmlxCache`, … | Live oMLX `/v1/models` probe (#364, ADR-0081). Loopback-only, key never cached, 60s model-id cache; **authoritative even when empty** (confirmed-down drops all omlx), null when inconclusive/not applicable. Cache epochs reject stale in-flight writes after clear. Consumed through the canonical snapshot. |
| `secret-scan.ts` | `SECRET_PATTERNS`, `scanRawString` | Canonical TS secret-detection pattern set + a raw-string scanner returning category names only (never the matched text). One of the three ADR-0071 lockstep copies (with `secrets-guard/index.ts` + `hooks/secrets-guard.sh`), verified by `validate.sh` §6b-bis. Moved here from `expertise-client` (ADR-0088, #635) so both `expertise-client` (`scanForSecrets`) and the config-mirror-shipped `expertise-indexer` consume it without a cross-mirror import. |
| `expertise-api-config.ts` | `buildClientConfig`, `loadUpstreamSecrets`, `resolveUpstreamSecretsPath`, `isLoopbackHost`, env parsers, `ClientConfig`, `ConfigResult`, `ENV_*` | Dual-profile agent-expertise-api configuration (ADR-0103): retained loopback/API-key `PI_EXPERTISE_*` plus upstream pre-provisioned bearer/static-OIDC `EXPERTISE_API_*`. Remote bearer origins require HTTPS; fixed operator files only, no repo discovery. Shared by the tool, fanout gate, and audit runner. |
| `expertise-api-http.ts` | `apiGet`, `apiPost`, `errorDetail`, `ApiResponse`, `MAX_BODY_BYTES`, agent header constants | Bounded HTTP: protected calls carry bearer + `X-Actor-Class: agent`; all carry stable pi `User-Agent`; anonymous readiness omits auth. Redirects refused, 256 KB cap, injectable `fetchImpl`. |
| `expertise-api-health.ts` | `checkReady` | `/health/ready` preflight against the configured local or upstream API origin. |
| `expertise-api-search.ts` | `searchExpertise`, `SEARCH_PATH`, `SearchParams`, `SearchResult`, `LIMIT_MIN`/`MAX` | Read-only semantic search (`GET /expertise/search/semantic`, `q` + clamped `limit`). 429s return a refusal with `rateLimited: true` + parsed `retryAfterSeconds` so programmatic callers (the fanout gate's session backoff) need not sniff prose. Moved from `expertise-client/lib/search.ts` (ADR-0095). |

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
