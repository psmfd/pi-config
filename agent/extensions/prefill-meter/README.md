# prefill-meter

Spawn-time prompt-segment measurement (ADR-0125, #891, umbrella #889).

Existing meters (token-meter, cache-meter) are aggregate, per-turn, and post-hoc — nothing separated a spawn's prompt into its segments. This extension records, once per pi process, how the cold-prefill system prompt decomposes into: pi's base template, the appended wrapper body (`--append-system-prompt`), the `<project_context>` context-files block (AGENTS.md/CLAUDE.md), and the `<available_skills>` block — plus the user-role task prompt. It exists to put numbers on #889's prefill work, starting with the before/after delta of the ADR-0124 `--no-context-files` default.

## How it measures

- **`before_agent_start`** (first firing per process only — the cold prefill is the target; later turns reuse the cached base): the event payload carries the fully composed system prompt *and* the structured `BuildSystemPromptOptions` it was built from, so every segment is sized from structured data — no string re-parsing, deterministic by construction.
  - The `<available_skills>` bytes come from pi's own exported `formatSkillsForPrompt` — exact, no lockstep copy.
  - The `<project_context>` bytes come from a lockstep reproduction of pi's template (dist `core/system-prompt.js`, pinned v0.81.1); the derived base-segment size going negative flags template drift (`driftSuspect: true`) instead of silently mis-attributing bytes.
  - `appendSha256` (SHA-256 of the raw wrapper body) joins records to `agent/agents/*.md` wrappers offline. No prompt or context-file content is ever logged — byte counts, paths, counts, and the hash only.
- **`message_end`** (first assistant message carrying usage): one `first_usage` record with the provider-reported token counts — the provider-tokenizer ground truth for the spawn record's byte sum.

Both handlers are **observational** (the ADR-0034 invariant): they never return a `systemPrompt` override or a replacement `message`, and a ledger write failure never disturbs the turn. `auto-router` also consumes `before_agent_start` (ADR-0031); this extension coexists by being inert in the handler chain — the recorded `systemPromptBytes` reflects the prompt as delivered at its chain position.

## Toggle and env vars

| Variable | Meaning |
|---|---|
| `PREFILL_METER_CONFIG` | **The only switch.** Unset/empty ⇒ fully inert (no hooks do work, no file is touched). Non-empty ⇒ armed; the trimmed value is recorded verbatim as the run `label` — tag probe runs (`before-0124`, `probe-3-after`, …). Carried into env-strict subagent children via the subagent extension's base allowlist (ADR-0125), so arming the orchestrator measures the whole spawn tree. |
| `PI_SUBAGENT_DEPTH` | Read-only input (stamped by the subagent extension, ADR-0118): recorded as `depth` so orchestrator (0) and child (≥1) records separate cleanly. |

Example probe run:

```bash
PREFILL_METER_CONFIG=probe-3-after pi -p "run the /review fanout on HEAD"
```

## Ledger

Append-only JSONL at `~/.pi/agent/extensions/prefill-meter/spawns.jsonl` (fixed basename; parallel child processes append interleaving-safely — one `write()` per record on an `O_APPEND` fd, the ADR-0073 rationale). Gitignored in a dev checkout (the `~/.pi` symlink resolves into this repo). No rotation: the meter is armed only for probe runs; prune by deleting the file.

Record kinds:

```json
{"ts":"…","kind":"spawn","label":"probe-3-after","pid":4242,"depth":1,
 "promptBytes":180,"systemPromptBytes":11440,"baseBytes":9210,
 "appendBytes":2200,"appendSectionBytes":2202,
 "contextSectionBytes":0,"contextFiles":[],
 "skillsSectionBytes":0,"skillsTotal":21,"skillsVisible":0,
 "appendSha256":"…"}
{"ts":"…","kind":"first_usage","label":"probe-3-after","pid":4242,"depth":1,
 "model":"omlx/…","provider":"omlx","input":2900,"cacheRead":0,"cacheWrite":0,"output":120}
```

Analysis is plain `jq` (deliberately no bundled analyzer — see ADR-0125):

```bash
# Cold-prefill segment breakdown for child processes, by wrapper hash
jq -s '[ .[] | select(.kind=="spawn" and .depth>0) ]
       | group_by(.appendSha256)[]
       | {sha: .[0].appendSha256[0:12], n: length,
          sys: (.[0].systemPromptBytes), ctx: (.[0].contextSectionBytes)}' \
  ~/.pi/agent/extensions/prefill-meter/spawns.jsonl
```

## Files

- `index.ts` — hook wiring, env gate, first-firing latches
- `record.ts` — pure record builders + segment templates (unit-tested without a pi runtime)
- `state.ts` — append-only ledger I/O
- `test/` — `node:test` suites; run via `scripts/test-prefill-meter.sh`
