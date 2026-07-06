---
status: Accepted
date: 2026-07-05
---

# ADR-0077: Routing-policy session tagging for A/B spend comparison, and the oMLX streaming-usage correction

**Status:** Accepted
**Date:** 2026-07-05
**Tracking issue:** #521
**Related:** [ADR-0073](0073-token-meter-extension.md) (the token-meter this extends), [ADR-0076](0076-model-tier-policy-and-precedence-guard.md) (the tier policy whose A/B this measures; its Q4a registration facts are amended by the streaming-usage correction below), local-llm ADR-009/010 (the serving architecture), local-llm#34 (the template-side fix).

## Context and Problem Statement

Comparing **all-frontier vs mixed frontier+local** spend (#517's motivating question) requires grouping sessions by the routing posture active when they ran. token-meter (ADR-0073) records per-turn usage per session but has no policy dimension — `--all-time` lumps every session together. Separately, the comparison's local side had no signal at all: every oMLX turn recorded zero tokens. That was believed to be an oMLX limitation; live verification (2026-07-05) showed otherwise — oMLX serves full usage (including `prompt_tokens_details.cached_tokens`) in the final stream chunk when `stream_options.include_usage` is requested, and pi requests it unless the model's `compat.supportsUsageInStreaming` is exactly `false`. Our own registration set exactly that, telling pi not to ask.

## Considered Options

### Q1 — How a session gets its policy tag

| Option | Verdict |
|---|---|
| **Q1.A — Explicit operator label: `TOKEN_METER_POLICY_TAG` env var, normalized once per process at `session_start`, plus a `/token-meter policy <tag>` in-session command.** | **Chosen** (the issue's own "simplest honest first cut"). The env var rides the exact inheritance channel `TOKEN_METER_SESSION`/`TOKEN_METER_ENABLED` already use — the subagent extension's `spawn()` passes no `env` key, so the whole descendant tree carries one label with zero new plumbing. A registered `--policy-tag` pi flag would need the identical env write-back to reach children (nothing forwards arbitrary registered flags to child argv), so env is the real carrier either way; the flag is deferred sugar. |
| Q1.B — Auto-derive the tag from observable state (router enabled? local model registered/reachable?). | Deferred, not rejected. Honest auto-derivation needs the matrix path (#352) and a reachability probe to be meaningful; it can layer on top of the recorded field without schema change. |

### Q2 — Where the tag is recorded

| Option | Verdict |
|---|---|
| **Q2.A — A `policy` field on every per-turn record (token-meter `TurnRecord` AND auto-router's `TaskTypeRecord`).** | **Chosen.** Every consumer treats the JSONL as a flat homogeneous stream (`fromjson? // empty` folds); a session-header record would need skip-first-line special-casing in each. A per-record field makes policy × tier / policy × model plain composite `group_by`s and gives task-type × policy joins directly — closing the near-duplicate-schema asymmetry between the two recorders instead of leaving `task-types.jsonl` untaggable. |
| Q2.B — Session-header record or sidecar file. | Rejected — special-cases every reader for no capability gain. |

### Q3 — The absent-tag sentinel

**`"untagged"`, never dropped** — a deliberate deviation from this codebase's two other absence conventions: the `"unknown"` literal (model/provider fallbacks) and the null-skip fold (`providerKey` returning null drops junk lines). Pre-#521 log lines have no `policy` field at all and MUST still appear in policy rollups, so `policyKey` never returns null. The literal is defined once (`UNTAGGED` in `record.ts`), the CLI's jq default must match it, and a unit test asserts the lockstep — the drift (TS writing `"untagged"`, jq defaulting `"unknown"`, or vice versa) would silently split one bucket into two.

### Q4 — Comparison surface

**Dedicated composite views in `scripts/token-meter.sh`** — `--by-policy`, `--by-policy-tier`, `--by-policy-model`, plus `--compare-policies` rendering both cross-tabs in one report — following the script's existing one-flag-per-view idiom rather than a generic `--by a,b` list parser (which would rewrite `keyof` for N-ary keys for no present need). Composite keys render as `"<policy> / <tier|model>"` row names. The in-session `token_usage` tool deliberately gains only a status readout (`policy` in `details` and the `/token-meter` notify): a single session normally carries one tag, so a policy table inside one session would render one row — the A/B comparison is inherently a multi-session CLI concern.

### Q5 — The streaming-usage correction (retro-recorded)

`supportsUsageInStreaming` flips to `true` for the oMLX registration everywhere it appears: the live operator `~/.pi/agent/models.json` (done 2026-07-05, verified — a workhorse turn records `{input:239, cacheRead:9728, output:29}`), the commented example in `agent/models.example.json`, and local-llm's `templates/pi-models-omlx.json` (local-llm#34 — the template had drifted behind the hand-patched live file). This amends the #518 registration facts ADR-0076 ratified and removes the A/B comparison's biggest caveat: the local side now has real token counts, not zeros.

## Decision Outcome

1. Explicit env tag (Q1.A), per-record `policy` field in both recorders (Q2.A), `"untagged"` lockstep sentinel (Q3), composite CLI views + `--compare-policies` (Q4), streaming-usage flip (Q5).
2. Auto-derivation (Q1.B) and a `--policy-tag` launch flag remain open extensions, both additive.

## Consequences

- **Positive:** A/B runs are one env var away (`TOKEN_METER_POLICY_TAG=mixed-local pi -p …`); whole subagent trees inherit the label; pre-existing logs stay aggregable (`untagged`); local-turn measurement is real, so the frontier-vs-local comparison can use tokens *and* observe cache behavior on both sides.
- **Negative / accepted:** the tag is an env **snapshot** — a mid-session `export` or `/token-meter policy` change never reaches already-spawned children (the same ADR-0073 caveat as `TOKEN_METER_ENABLED`); a session retagged mid-flight records mixed labels (visible, not corrected). Costs on the Copilot tier reflect registry list prices, not quota economics (ADR-0076 caveat carries over).
- **Neutral:** "policy" here is a measurement label — distinct from auto-router's candidate-selection policy (`policy.ts`) and ADR-0076's tier policy; the token-meter README carries the disambiguation.

## Doc-Impact

| Surface | Classification | Reason |
|---|---|---|
| `adrs/0077-*.md` | in-scope | this ADR |
| `README.md` ADR list | in-scope | new row |
| `agent/extensions/token-meter/README.md` | in-scope | env var, sentinel, new CLI flags, snapshot semantics, disambiguation |
| `agent/extensions/auto-router/README.md` (#351 section) | in-scope | `policy` field on TaskTypeRecord |
| `agent/models.example.json` | in-scope | Q5 flip + comment |
| local-llm `templates/pi-models-omlx.json` | out-of-scope — tracked & delivered | local-llm#34 / PR local-llm#35 |
| `token_usage` tool policy table | not-a-thing | single-tag sessions render one row (Q4 rationale) |

## More Information

- Live verification transcript facts: oMLX final-chunk usage probe and the post-flip workhorse turn are recorded on #521 (2026-07-05 comment).
