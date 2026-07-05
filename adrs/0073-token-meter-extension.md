---
status: Accepted
date: 2026-07-04
---

# ADR-0073: token-meter — a per-session, per-model token-usage counter extension

**Status:** Accepted
**Date:** 2026-07-04
**Related:** [ADR-0034](0034-cache-ratio-measurement.md) (cache-meter, the observational-`message_end`-recorder prior art), [ADR-0019](0019-compaction-optimizer-extension.md) (per-extension `~/.pi/agent/extensions/<name>/` data subtree, `extensionSettings.<name>.*` + project-layer trust boundary), [ADR-0042](0042-standalone-extension-distribution.md) / [ADR-0050](0050-outbound-distribution-mirror-sync.md) (mirror distribution).

## Context and Problem Statement

We want a way to see the TOTAL tokens a pi session consumed — persisted somewhere
user-accessible, retrievable from the CLI and in-session, broken down by model,
and toggleable (off in most sessions). cache-meter already captures per-turn usage
via `message_end`, but it is an operator-only, env-var-gated, single-global-log
measurement tool with no per-session identity, no user-facing retrieval, and no
model breakdown surfaced to the user. token-meter reuses cache-meter's capture
mechanics and field vocabulary but makes several fresh decisions that warrant a
record.

## Decisions

1. **Capture via `message_end`, observational only.** Read `message.usage`,
   `message.model`, and `message.provider` as one atomic tuple at `message_end`
   time and append one JSONL record per assistant turn. The handler always returns
   `undefined` — never a replacement message (rewriting it would churn the
   provider's cached prefix; ADR-0034's binding invariant). No network; only
   numeric usage + model/provider strings are read, never message content.

2. **Per-session file keyed on pi's own session id.**
   `~/.pi/agent/extensions/token-meter/sessions/<session-id>.jsonl`, where
   `<session-id>` = `ctx.sessionManager.getSessionId()` (basename-sanitized;
   `.`/`..`/empty rejected before it becomes a path component). This departs from
   cache-meter's single global log: token-meter runs every session, so a global
   file grows unbounded and defeats "find this session's counts." Reusing pi's id
   lets a user correlate the log against the session transcript by filename.

3. **Append-only JSONL; aggregate on read. Never a mutable rollup.** pi runs
   parallel subagents as separate OS processes; a single `fs.appendFile` is one
   `write()` on an `O_APPEND` fd and is interleaving-safe across processes, whereas
   a read-modify-write rollup would lose updates. There is one source of truth —
   the CLI and the in-session tool both aggregate from it; the reader skips a
   corrupt/partial trailing line rather than throwing.

4. **Whole-tree accounting via environment propagation.** Subagents spawn as
   `pi --no-session` children that inherit the parent's environment. When enabled
   the root process exports `TOKEN_METER_SESSION` (its own session id, stamped once
   and never overwritten by descendants) and `TOKEN_METER_ENABLED=1`; every
   descendant records to the ROOT session's file. "TOTAL tokens consumed in a
   session" therefore includes subagent usage — the dominant orchestration pattern
   here — rather than silently undercounting it.

5. **Hybrid toggle, inert by default.** A persistent user-layer default
   (`extensionSettings.tokenMeter.enabled` in `~/.pi/agent/settings.json`) plus a
   per-session `--token-meter` flag and `/token-meter on|off|status` command
   (the `auto-router` pattern). **Only the user layer is read for the toggle** — a
   project's `.pi/settings.json` cannot flip metering or redirect the log (the log
   path is not configurable at all), closing the project-layer-trust gap ADR-0019
   had to mitigate for a configurable path. Nothing is registered/shown when off.

6. **"TOTAL" always keeps the breakdown.** Fresh `input`, `cacheRead`,
   `cacheWrite`, `output`, a `totalTokens`, and a **separate** nullable `cost`
   (absence ≠ zero). Cached input is priced ~10x below fresh, so a single opaque
   scalar would be misleading; every rollup shows the split.

7. **Retrieval on two surfaces reading one file.** An in-session `token_usage`
   tool (`registerTool`; terse one-line default, `verbose:true` table) and a
   `scripts/token-meter.sh` CLI (current / `--session` / `--all-time` / `--list`),
   `jq`-driven like `analyze-cache-ratio.sh`. The CLI reports rather than gates, so
   it ends with a `TOTAL —` line, not the PASS/FAIL summary block.

## Consequences

- **Positive:** accurate whole-session (incl. subagent) token + cost totals by
  model, retrievable in-session and from the CLI, off by default.
- **Neutral:** logs accumulate one file per session under the extension subtree
  (gitignored). Retention is left to the user (`--list` + manual prune / a future
  `--prune`); each file is small (one line per turn).
- **Accepted:** a provider that omits cache fields (e.g. github-copilot, SDK #1073)
  records 0 there — acceptable for a counter (unlike cache-meter's ratio gate,
  where absence-vs-zero matters and is handled as SKIP). Mid-session `/token-meter
  off` stops the root but not already-spawned children (env captured at spawn).

## Alternatives rejected

- **Single global log (cache-meter's shape):** unbounded growth, no per-session
  retrieval.
- **Mutable rollup JSON:** racy under the parallel-subagent process model (lost
  updates).
- **Env-var-only toggle:** no in-session control; **settings-only toggle:** no
  per-session override. The hybrid gives both and composes with subagent
  propagation.
- **Top-level-only scoping:** silently undercounts every session that used the
  subagent tool.
