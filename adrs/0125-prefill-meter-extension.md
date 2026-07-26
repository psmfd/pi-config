---
status: Accepted
date: 2026-07-26
---

# ADR-0125: prefill-meter — spawn-time prompt-segment measurement

**Status:** Accepted
**Date:** 2026-07-26
**Related:** [ADR-0034](0034-cache-ratio-measurement.md), [ADR-0073](0073-token-meter-extension.md), [ADR-0105](0105-token-meter-strict-env-carveout.md), [ADR-0114](0114-cache-meter-strict-env-carveout.md), [ADR-0124](0124-subagent-context-file-suppression.md), [ADR-0031](0031-auto-router.md), #891, #889.

## Context and Problem Statement

The #889 prefill-reduction arc ships changes whose entire value is a smaller
child cold prefill — ADR-0124 removed the `<project_context>` block from
default-path spawns — but no instrumentation separates a spawn's
prompt-segment sizes. token-meter (ADR-0073) and cache-meter (ADR-0034) are
aggregate, per-turn, and post-hoc: they can say what a whole request cost,
never *which segment* of the composed system prompt (pi base template, appended
wrapper body, context files, skills XML) carried the bytes. Probe-3-style
validation of #889 needs per-segment before/after evidence, and #891 requires
the measurement to be deterministic and to never modify the prompt.

Two premises in the original #891 text did not survive research:

- `before_agent_start` is **not** unused repo-wide — auto-router owns it
  (ADR-0031), and ADR-0032/0033 treat non-collision with that handler as an
  explicit compatibility check for new extensions.
- "Spawn time" is not a parent-side signal: the parent's `spawn()` call site
  knows only the wrapper body and task string. The base template, context
  files, and skills block exist only once the child's own resource loader and
  `buildSystemPrompt()` have run.

What makes the hook the right seam anyway (verified against the pinned
v0.81.1 dist): `before_agent_start` fires once per `AgentSession.prompt()`
call — including `-p --mode json` children — and its payload carries the task
prompt, the fully composed system prompt, *and* the structured
`BuildSystemPromptOptions` (`appendSystemPrompt`, `contextFiles`, `skills`) it
was composed from. Segment sizing therefore needs no string re-parsing.

## Considered Options

1. **Parent-side measurement in the subagent extension.** Rejected: the parent
   can size only the wrapper body and task string; base/context/skills bytes
   are child-side facts. It would also grow the vendored extension's patch
   surface for a job an ordinary first-party extension can do.
2. **Post-hoc string re-parsing of the composed prompt** (regex over
   `<project_context>`/`<available_skills>` markers). Rejected: the base/append
   boundary is a bare `\n\n` join with no marker, so re-parsing cannot separate
   them; marker parsing is also fragile against upstream template changes.
3. **Extend token-meter with segment fields.** Rejected: different event,
   different cadence (once-per-process vs per-turn), different ledger shape;
   ADR-0088's cross-extension import ban would force entanglement token-meter
   was deliberately kept free of.
4. **New measurement-only extension consuming `before_agent_start`'s
   structured payload.** Chosen.

## Decision Outcome

A new first-party extension, `agent/extensions/prefill-meter/`, records to an
append-only JSONL ledger (`~/.pi/agent/extensions/prefill-meter/spawns.jsonl`,
fixed basename, `O_APPEND`-safe across parallel children — the ADR-0073
mechanics):

- **`spawn` record** — on each process's *first* `before_agent_start` only
  (the cold prefill is the target; later turns reuse the cached base): byte
  counts for the task prompt, total system prompt, wrapper body (raw and as
  the rendered `\n\n`-joined section), `<project_context>` block (plus
  per-file path/bytes), and `<available_skills>` block, with a derived
  base-segment size and `PI_SUBAGENT_DEPTH` recorded as `depth`. The skills
  bytes come from pi's own exported `formatSkillsForPrompt` (exact, no
  lockstep copy); the context block is a lockstep reproduction of the
  `system-prompt.js` template whose drift is self-detecting (a negative
  derived base sets `driftSuspect` instead of silently mis-attributing bytes).
  `appendSha256` gives offline wrapper identity with zero content logged —
  the payload docs flag `systemPromptOptions` content as sensitive, so records
  carry byte counts, paths, counts, and the hash only.
- **`first_usage` record** — from the first assistant `message_end` carrying
  usage: the provider-tokenizer ground truth for the byte sum. Not available
  at spawn time and not per-segment; it validates totals.

Design constraints adopted:

- **Observational invariant (ADR-0034):** neither handler ever returns a
  `systemPrompt` override or replacement `message`; a ledger write failure
  never disturbs a turn. This is also the auto-router coexistence answer: a
  second `before_agent_start` consumer is safe precisely because it is inert
  in the handler chain (recorded bytes reflect the prompt as delivered at the
  meter's chain position).
- **Inert by default, env-armed:** the single switch is
  `PREFILL_METER_CONFIG`; its trimmed non-empty value is the recorded run
  label. No settings key, flag, or command — this is an operator probe tool,
  not always-on accounting (deliberately narrower than token-meter's hybrid
  toggle).
- **Strict-env carve-out (the ADR-0114 pattern):** `PREFILL_METER_CONFIG` is
  added to the subagent extension's `BASE_ALLOWLIST` as an exact key —
  non-secret observational config, unconditional cross-cutting infrastructure
  identical for every wrapper, never a per-wrapper `env-allow` entry (the
  ADR-0105/0114 rejection rationale applies unchanged). Regression-tested in
  `sanitize-env.test.ts`.
- **No bundled analyzer:** the ledger is `jq`-shaped; a dedicated analysis
  script can follow if the probe workflow demands one. Mirroring is likewise
  deferred — unmirrored first-party extensions are established practice.

### Consequences

- #889 levers become measurable: arm the meter, run a probe fan-out, and the
  ledger yields per-wrapper, per-segment cold-prefill sizes with a token
  cross-check — including the ADR-0124 before/after delta via
  `context-files: inherit` vs default wrappers.
- The live measurement itself is operator-run, not CI-gated (the ADR-0034
  split): CI gates the unit suites (`scripts/test-prefill-meter.sh`, wired
  into `validate.sh`) and the sanitize-env regression.
- The lockstep context-template reproduction is a small standing maintenance
  cost on pi upgrades, mitigated by the self-detecting drift flag and by the
  skills side using the real exported formatter.
