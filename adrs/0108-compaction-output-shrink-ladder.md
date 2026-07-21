---
status: Accepted
date: 2026-07-20
---

# ADR-0108: compaction-optimizer — output-side token budget with deterministic shrink ladder

**Status:** Accepted
**Date:** 2026-07-20
**Amends:** [ADR-0019](0019-compaction-optimizer-extension.md) § Decision Outcome — deterministic builder output contract and mode taxonomy (supersession by addition: the original prose is unchanged; a forward-pointer blockquote there references this ADR)
**Related:** pi_config #254 (delivery issue), #253 (`previousSummaryMaxChars` — the Carried-Forward rung reuses its mechanism), #244/[ADR-0107](0107-compaction-hybrid-relative-token-gate.md) (input-side gate; this ADR extends the same stable-`reason` promise), #775 (`details` model-visibility verification, filed from this design), #242 (path-taken notify this ADR extends)

## Context and Problem Statement

`buildDeterministicSummary` had no output-side size check: every section
rendered at full fidelity, the dispatcher decided air-gapped-vs-LLM *before*
the builder ran, and no path existed between "deterministic" and "LLM" once
decided. With ADR-0107 relaxing the input gate to window-relative,
compactions up to the observed ~283 K tokens now reach the builder — and one
section was genuinely unbounded: `## Turn Prefix` capped chars per message
but not message count. On-host replay of the real archived payloads measured
full-fidelity outputs of 1,609–7,572 tokens, with the Turn Prefix section
alone contributing 5,761 of the worst case's 7,572 (#254 measurement,
2026-07-20). The issue's sketched budget default of 30,000 would never have
fired on observed data.

## Considered Options

1. **Single hard truncate** of the rendered markdown at N tokens — simple but
   cuts mid-section, destroying the summary's structural guarantees.
2. **Multi-pass shrink ladder** (chosen) — re-render at progressively lower
   fidelity rungs until the output fits; each rung is a complete, valid
   summary.
3. **Delegate to the LLM when large** — defeats the extension's air-gapped
   purpose for exactly the sessions it targets.

## Decision Outcome

Option 2. The builder exposes a pure `buildAtRung(input, rung)`;
`buildDeterministicSummary(input)` remains as the backward-compatible
full-fidelity wrapper. The dispatcher walks `RUNG_ORDER` first-fit against
`hybrid.maxOutputTokens` (chars/4 via the exported `estimateSummaryTokens`).

### Unconditional changes (every rung, including full)

- **`## Goal` removed** — pure duplicate of User Turns #1. Coupling
  requirement: every fidelity level of `renderUserTurns` preserves turn #1,
  which is now the sole carrier of the original ask.
- **Turn Prefix aggregate cap** — only the last `TURN_PREFIX_MAX_MESSAGES`
  (12) prefix messages render, with a deterministic elision marker. This is
  the measured dominant tail (worst case dropped 7,572 → 2,849 tokens,
  −62 %, from this cap plus the dedups).
- **Bash `(last: …)` capped** at `BASH_LAST_COMMAND_MAX_CHARS` (80).
- The former inline literals 120 (`SUBAGENT_BRIEF_EXCERPT_MAX_CHARS`) and
  1000 (`TURN_PREFIX_MSG_MAX_CHARS`) are promoted to named constants.
  **Deliberately constants, not settings** — like `RATIO_CHECK_MIN_MESSAGES`
  (ADR-0019), they are definitional renderer properties, not policy
  thresholds; #254's "expose as settings" half is rejected as
  over-configuration.
- **`## Compaction Metadata` is never dropped at any rung.** #254's dedup
  bullet proposing its removal contradicted the issue's own stub-mode spec
  (which requires it) and buys ~55 tokens; the item is resolved against
  removal.

### The rung ladder (normative, cumulative)

Each rung applies every drop of the rungs before it:

| # | Rung | Drops / changes | Notify value |
|---|---|---|---|
| 1 | `full` | baseline (post-unconditional-changes) | *(no rung field)* |
| 2 | `no-file-activity` | `## File Activity` section (data survives in `details` — see #775) | `shrunk-no-file-activity` |
| 3 | `no-tools` | `## Tool Activity Summary` | `shrunk-no-tools` |
| 4 | `no-verdict-brief` | verdict table → `\| Agent \| Verdict \| Ref \|` (REPORT_FILE or `—`; excerpt dropped) | `shrunk-no-verdict-brief` |
| 5 | `no-prefix` | `## Turn Prefix (split turn)` | `shrunk-no-prefix` |
| 6 | `no-carried-forward` | `## Carried-Forward Context` (forces the #253 cap-0 path) | `shrunk-no-carried-forward` |
| 7 | `trimmed-turns` | User Turns → turn #1 + last 9 at 500 chars each, elision marker | `shrunk-trimmed-turns` |
| 8 | `stub` | User Turns → turn #1 + last 2; verdict table → `\| Agent \| Verdict \|`; instructions footer dropped. Guaranteed sections: User Turns (as trimmed), Subagent Verdicts, Compaction Metadata | `shrunk-stub` |

Byte-determinism: `buildAtRung` is pure — identical `(input, rung)` yields
byte-identical output, the same contract the full render has always carried;
`generatedAt` is pinned once per compaction so rung retries render the
identical timestamp.

### Terminal behavior per mode

- **`hybrid`** — when even `stub` exceeds the budget, return `undefined`
  (fall through to pi's LLM summarizer) with the info notify
  `shrink ladder exhausted at stub rung, falling through to pi LLM
  summarizer (…)`. Hybrid's contract already tolerates an LLM call.
- **`deterministic`** — the mode is an air-gap guarantee (ADR-0019): no LLM
  fallback exists. An over-budget stub is **emitted anyway** with a warning
  notify naming the condition. The path-taken notify fires only after the
  rung-or-fallback decision is final (a pre-check notify would misreport the
  path, regressing #242).
- **`llm-only-with-dump`** — unaffected; the builder never runs.

### Settings and vocabulary

- `hybrid.maxOutputTokens` — default **8000**, project-layer clamp
  `[2000, 100000]`, allowlisted like the other `hybrid.*` thresholds.
  Grounded in measurement: post-change full-fidelity outputs on the real
  corpus run 1,382–2,849 tokens, so all observed real compactions stay at
  full fidelity and the ladder engages only on genuine pathology. Always-on
  by design — no `0 = disabled` sentinel (`0` already means "omit" in the
  adjacent `previousSummaryMaxChars`).
- **`HybridResult.reason` is unchanged**, extending ADR-0107's stability
  promise. Rung outcomes surface only through the path-taken notify
  (`rung=shrunk-<rung>` on the deterministic line, plus the two terminal
  messages above).

### Invariants and contract notes

- `CompactionEntry.details.readFiles/modifiedFiles` are computed from
  `fileOps` directly, never derived from the rendered markdown — rungs that
  drop the File Activity *section* do not affect them. Whether `details` is
  ever re-surfaced to the model (which would make the rung-2 drop a pure
  dedup, promotable to unconditional) is unverified against pi's compaction
  render path; tracked as #775.
- The archive writer consumes the raw pre-cut snapshot, not the rendered
  summary — a shrunk summary does not change what is archived.

## Measured effect (with vs without, real archived compactions)

| Compaction (`tokens_before`) | Before (old full render) | After (new full render) | Δ | Rung selected at default 8000 |
|---|---|---|---|---|
| 153,066 | 1,609 t | 1,382 t | −14 % | full |
| 184,341 | 1,672 t | 1,656 t | −1 % | full |
| 186,268 | 2,129 t | 2,038 t | −4 % | full |
| 283,475 | 7,572 t | 2,849 t | **−62 %** | full |

Per-rung degradation on the worst case: 2,849 (full) → 2,398 → 2,351 →
1,818 → 728 → 581 → 365 → 325 (stub).

## Consequences

- The mode taxonomy reframes from a binary pre-build dispatch to a
  graceful-degradation ladder; the pre-build `decideHybrid` gates are
  unchanged.
- Deterministic-mode summaries are now bounded in ordinary operation and
  loudly-unbounded only in the (vanishingly rare) stub-over-budget case,
  preserving the air gap.
- Doc-sync: extension README (modes/heuristic prose, deterministic-schema
  section, notify table, settings + clamp tables), `settings.schema.json`,
  the builder and dispatch test suites, and the `security/scanning-decisions.md`
  line-shift note were updated in lockstep with this ADR.
