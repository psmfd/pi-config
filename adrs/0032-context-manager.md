---
status: Accepted
date: 2026-06-09
---

# ADR-0032: context-manager extension (custom cache-safe pruning)

**Status:** Accepted
**Date:** 2026-06-09
**Tracking issue:** [#334](https://github.com/psmfd/pi_config/issues/334)
**Related:** [#327](https://github.com/psmfd/pi_config/issues/327) (suite), [#328](https://github.com/psmfd/pi_config/issues/328) (Phase 0), [#331](https://github.com/psmfd/pi_config/issues/331) (workstream), [#332](https://github.com/psmfd/pi_config/issues/332) (`pi-dcp` trial), [#333](https://github.com/psmfd/pi_config/issues/333) (`pi-context-prune` trial), [#335](https://github.com/psmfd/pi_config/issues/335) (`/prune`), [ADR-0030](0030-shared-foundation.md) (`shared/`), [ADR-0031](0031-auto-router.md) (build precedent), [ADR-0021](0021-extension-type-checking-and-linting.md) (no per-extension `package.json`)

## Context and Problem Statement

The Pi Extension Suite ([#327](https://github.com/psmfd/pi_config/issues/327)) owns "tokens per turn" through the context-manager workstream. The plan ([`notes/pi-extension-suite-plan.md`](../notes/pi-extension-suite-plan.md) § "Workstream B") is **adopt-first**: trial two maintained extensions and build custom only on a documented failure of both. The workstream carries one **binding** invariant:

> Prune **append-side** and **batch** prunes — never rewrite the cached prefix region. Provider prompt caching prices cached input ~10× below fresh; every-turn prefix rewrites can cost more than they save.

Both candidates were assessed against their **published npm tarballs** (not repo HEAD) at inspection level — sufficient because both fail by design, with no live trial needed.

## Considered Options

1. **Adopt `@davecodes/pi-dcp@0.2.0`** (AGPL-3.0) — "mechanical zero-mutation" pruning.
2. **Adopt `pi-context-prune@0.10.0`** (MIT) — LLM summarization of tool-call trees.
3. **Build a custom `context`-event extension** (chosen) — sticky, intrinsic-size elision that never rewrites the cached prefix.

### Why both candidates fail the binding invariant (inspection evidence)

| Candidate | Verdict | Evidence (published tarball) |
|---|---|---|
| `@davecodes/pi-dcp@0.2.0` | **FAIL** | Dedup (`lib/strategies/deduplication.ts:62`) and purge-errors (`lib/strategies/purge-errors.ts:54`) walk the **full** message array, rewriting any aged duplicate or aged (>2-turn) errored tool-call outside a 3-turn recency window. pi.dev's own docs state this "invalidates cached prefixes from that point forward." Hooks 8 events — `before_agent_start` collides with auto-router, `agent_end` is benign vs indexing. Its `compress`/nudge path **spends LLM tokens** (default-on above a 30k-token floor). License AGPL-3.0 is tolerable only under vendor-pin (deferred). |
| `pi-context-prune@0.10.0` | **FAIL (harder)** | Prefix rewriting *is* the mechanism — "summarized tool outputs **replace raw tool results in future context**." Default `pruneOn: "agent-message"` (`src/types.ts:184`) batches but still busts cache per cycle; its own help calls `every-turn` "worst for prompt cache churn." The summarizer makes an **LLM call** (`stream()`, `src/summarizer.ts:104`) → spends tokens. Same 8-hook collision profile, plus open injection-adjacent issue #20. |

Neither can be configured append-side-only; rewriting earlier context is intrinsic to both. This is the documented dual failure that [#331](https://github.com/psmfd/pi_config/issues/331)/[#334](https://github.com/psmfd/pi_config/issues/334) require to justify a build. The trials ([#332](https://github.com/psmfd/pi_config/issues/332)/[#333](https://github.com/psmfd/pi_config/issues/333)) were resolved at **inspection** rather than live measurement, because a candidate that violates the invariant *by design* cannot be rescued by favorable numbers.

It also corrects two prior assumptions: the plan's "Strong cache posture — zero-mutation" for `pi-dcp` (true only for the on-disk JSONL, not the provider cache) and [#328](https://github.com/psmfd/pi_config/issues/328) item 7's "`pi-dcp` hooks only `{session_start, context}`, coexists cleanly" (the published 0.2.0 hooks 8 events).

## Decision Outcome

**Build** `agent/extensions/context-manager/`, consuming `shared/` for the usage signal, notify, and state.

### Mechanism (verified v0.79.0)

- **Hook: `context` only** (`docs/extensions.md:609` — fires before each LLM call, hands a deep copy of `messages`, returns `{ messages }`). No `before_agent_start`, no `agent_end` → **zero collision** with auto-router or indexing — the clean coexistence neither candidate achieves.
- **Cache-safe elision.** Oversized `toolResult` message text (default cap 12 KB/block) is shortened by keeping a head + tail excerpt and replacing the middle with a deterministic placeholder. Only the result *content* is rewritten; the message and its `toolCallId` stay, so tool-call/result pairing is never broken.
- **Sticky, frozen-at-first-sight decisions.** Each `context` event re-derives a deep copy of the *original* messages (the session JSONL is never mutated), so a naive prune that re-evaluates every message against *current* usage would flip a message full→pruned mid-session and rewrite the cached prefix — the exact failure of both candidates. Instead, each tool-result's decision is **frozen the first turn it is seen** in an in-memory `toolCallId → full|pruned` map: a result first seen with headroom stays full forever; one first seen while usage is at/above the prune threshold *and* oversized is pruned and stays pruned. The sent prefix therefore never flips → cache stays hot.
- **Usage gate via `shared/signals.ts`.** The freeze decision gates on `getUsage(ctx).level >= "prune"` (`PRUNE_AT = 0.70`), so full fidelity is preserved while there is headroom. Unknown usage (`getUsage` returns `null` — `tokens` may be undefined, #328 finding F) freezes the decision as `full` (conservative; never prunes on an unknown signal). Thresholds are read from `shared/`, never hardcoded.
- **`/prune [on|off|status]`** toggles automatic elision and reports state + live usage; `--prune` enables for one session. State (`enabled`, `maxResultBytes`) persists via `shared/state.ts`.

### Why this honors the invariant where the candidates do not

A message's sent form is a pure function of its own content and its frozen decision — independent of position, age, what else is in context, and (after first sight) of usage. Identical inputs across turns ⇒ byte-identical prefix ⇒ no cache invalidation. The extension reclaims *new* oversized output as it arrives; the *old* prefix is left to Pi's built-in compaction (a rare, bounded cache event at the compaction boundary). Division of labor: context-manager = continuous cache-safe tail-shaping; built-in compaction = infrequent prefix reduction.

### Testability

`prune.ts` (detect/elide/placeholder), `policy.ts` (freeze decision + size/level gate), and `state.ts` are pure or structurally typed against the slice of the message/`ExtensionContext` shape they read, so they unit-test offline without a live pi runtime — the ADR-0030/0031 pattern. Live behavior (real token reduction, sustained cache-hit ratio per provider) is measured separately in [#338](https://github.com/psmfd/pi_config/issues/338) via `message_end`'s normalized `usage.cacheRead`/`cacheWrite` — the correct hook, superseding [#328](https://github.com/psmfd/pi_config/issues/328) amendment E's `after_provider_response`-headers approach, which fires before the response body (and thus usage) is read.

## Consequences

- **Positive:** the only design that satisfies the binding cache invariant; spends **zero** extra tokens (pure mechanical elision, no LLM call); collides with nothing (single read-mostly `context` hook); deterministic, offline-testable core; reuses `shared/`.
- **Negative / trade-offs:** strictly less aggressive than the rejected candidates — it caps *new* bloat but cannot reclaim *old* prefix bloat (that would bust cache; built-in compaction owns it). A `/reload` resets the in-memory freeze map, so the first post-reload `context` re-decides messages against current usage and may prune once (a single bounded cache event; tool-call/result pairing is always preserved — the [#331](https://github.com/psmfd/pi_config/issues/331) criterion). Persisting the freeze map per session id is a possible refinement.
- **Deferred (post-v1):** the optional `session_before_compact` lever (domain-aware compaction) — kept out until the built-in summary proves too lossy; a cache-busting "deep reclaim" mode for `/prune` (dedup/age-based) — rejected for v1 precisely because it reintroduces the candidates' invariant violation.

## More Information

- Candidate evidence + inspection method: issues [#332](https://github.com/psmfd/pi_config/issues/332), [#333](https://github.com/psmfd/pi_config/issues/333); workstream table in [#331](https://github.com/psmfd/pi_config/issues/331).
- Plan of record: [`notes/pi-extension-suite-plan.md`](../notes/pi-extension-suite-plan.md) (rev 2) § "Workstream B — context-manager".
