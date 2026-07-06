---
status: Accepted
date: 2026-07-05
---

# ADR-0076: Model tier policy — frontier orchestrator, local workhorse fan-out, pinned review trio — and the router `--model` precedence guard

**Status:** Accepted
**Date:** 2026-07-05
**Tracking issue:** #519
**Related:** [ADR-0031](0031-auto-router.md) (the auto-router this amends), [ADR-0026](0026-copilot-models-forward-fix-via-models-json.md) (the `models.json` custom-provider mechanism the workhorse registration rides on), [ADR-0035](0035-copilot-live-model-discovery.md) (Copilot live discovery, the tier-gating precedent), local-llm ADR-009/010 (oMLX serving architecture and concurrency ceiling grounding the tier split). Absorbs the intent of superseded #184 (three-tier ADR) and #186 (wrapper repins), both written for the retired Mistral/Devstral architecture.

## Context and Problem Statement

The #517 track gave pi two model economies with nothing recording how roles map onto them: a cloud frontier model (paid API dollars or Copilot premium-request quota) and a local oMLX workhorse (`omlx/coding-workhorse`, honest cost 0, concurrency-bound rather than dollar-bound — local-llm ADR-009/010). Three mechanism pieces already shipped ad hoc without a ratifying ADR: operator-local `models.json` registration (#518), the cost-0-first classifier ordering (#363), and the capable-set seed in `agent/extensions/shared/routing-matrix.json` (#363).

Two concrete defects force the rest:

1. **Router-over-pin:** auto-router's enable state is disk-global (`~/.pi/agent/extensions/auto-router/state.json`) and extensions load in every pi invocation — including `-p`/`--mode json` subagent children spawned by `agent/extensions/subagent/index.ts`, which passes a wrapper's frontmatter `model:` pin as `--model` on the child's argv. Nothing checked for that explicit pin before `pi.setModel()`, so an enabled router inside a pinned child re-routes over the pin. Worse, pi's `setModel` also persists the chosen model as the user's **global default** (upstream behavior; tracked as #533).
2. **Pins hard-fail where the model does not exist:** `omlx` is operator-local `models.json` config (this repo ships only a commented example — #518), and the wrappers are shared repo content distributed via the public mirror. pi's `--model` resolution **hard-exits (`process.exit(1)`)** when the named provider has no registered models — so a naive static pin would break every pinned subagent on every host without the oMLX block, i.e. for every mirror consumer.

A third finding surfaced during design: pi's exact-id `--model` matching runs against the full registry (auth-ignorant) before fuzzy matching, and the review trio's historical bare pin `claude-opus-4.7` (dotted) exactly matches only the **github-copilot** registry id — Anthropic ids are dashed (`claude-opus-4-7`). The trio has therefore always resolved to Copilot when logged in, and produced broken children when logged out. The tier policy must make that binding deliberate instead of accidental.

## Considered Options

### Q1 — Tier-to-role mapping

| Option | Verdict |
|---|---|
| **Q1.A — Four-rung ladder: read-only specialist fan-out on the local workhorse; review trio pinned to opus via Copilot; orchestrator (parent session) on the session-default frontier; Copilot as the mid-tier between local and paid API.** | **Chosen.** Fan-out concurrency is exactly what the local workhorse is provisioned for (local-llm ADR-010: prefill-bound, sustained mark 8) and what burns quota/dollars fastest on cloud tiers. Quality-tier work deliberately never lands locally (local-llm ADR-009), so the review trio stays on opus — now explicitly `github-copilot/claude-opus-4.7` (operator decision: reviews bill to subscription quota, not API dollars). `linter` (runs tools, applies fixes) and the three interactive agents (`gh-cli-expert`, `gitflow-expert`, `work-item-management-expert`) stay unpinned on the session default pending evidence (#535 for linter). |
| Q1.B — Two-tier only (local vs. paid API), ignore Copilot. | Rejected. The Copilot subscription serves frontier models at zero marginal dollar cost; leaving it unmapped is what made the trio's Copilot binding accidental. The Copilot rung's *automatic* use as fan-out fallback is deferred to #536. |

### Q2 — Pin mechanism: how a role's tier is applied

| Option | Verdict |
|---|---|
| **Q2.A — Frontmatter pins + a spawn-time registry gate in the subagent extension.** 14 read-only specialist wrappers carry `model: omlx/coding-workhorse`; `runSingleAgent` passes a slash-qualified pin as `--model` only when its exact `provider/id` is in `ctx.modelRegistry.getAvailable()`, otherwise omits the flag (child inherits the session default) with a visible note in the tool result. Slash-less pins pass through ungated (pi's own pattern matching resolves them). Registry unreadable ⇒ fail open. | **Chosen.** The pin declares intent in shared content; the gate applies it only where it can work. Mirror consumers and oMLX-less hosts degrade silently to the default model instead of hard-exiting; a logged-out Copilot degrades the trio *visibly* (the note) instead of breaking it. Rides the existing `agent.model → --model` plumbing end-to-end. |
| Q2.B — Bare static pins, no gate. | Rejected. Hard-exits every pinned child on hosts without the provider (see Context §2) — shipping a machine-specific optimization as a universal default. |
| Q2.C — Role-aware routing (teach auto-router a subagent-role concept; no pins). | Deferred, not rejected. Composes with #352's matrix-aware routing and could lift the capability-blindness limitation below, but requires a child-role signal pi does not provide (no env-var or session marker exists upstream) plus routing-policy machinery, for no benefit the pins path does not already deliver. Re-evaluate at #352. |
| Q2.D — Liveness-aware gate (probe the oMLX server at spawn, not just the registry). | Deferred to #534. Registry presence ≠ server up; with the server down, pinned children still fail at the API layer on the operator host. `omlx-discovery.ts` (#364) has the right probe semantics and would move to `shared/`. |

### Q3 — Router precedence-guard contract

| Option | Verdict |
|---|---|
| **Q3.A — An explicit argv `--model` wins unconditionally, for the whole process: `before_agent_start` short-circuits *before* the classifier side-call and discovery probes; the sticky task-type label is cleared (the turn is unrouted for measurement); the notify is one-time, and `/auto status` reports `ON (inert: explicit --model)`.** | **Chosen.** "A child spawned with `--model` is never re-routed" (#519 acceptance criterion) admits no exception — a `--auto`-beats-`--model` carve-out would be the loophole a future spawn-path change silently falls through. Short-circuiting before classification means a pinned child pays none of the routing cost (classifier round-trip + Copilot/oMLX probes) the pin exists to avoid — this multiplies across every fan-out. Detection is an exact-token argv scan mirroring pi's parser (two-token `--model <value>` only; no `=` form, no alias; trailing valueless `--model` ignored; `--models` is a different token): `pi.getFlag()` cannot see built-in flags, and pi records no model-provenance anywhere an extension could read. |
| Q3.B — Guard only the final `setModel` call; classify and record normally. | Rejected. Pays full classifier + probe cost per pinned invocation, and the `routed` outcome would toast a model change that never happened. |
| Q3.C — Explicit `--auto` overrides the guard. | Rejected as a loophole (see Q3.A). An operator who passes both flags has contradicted themselves; deterministic pin-wins plus the one-time notify is the safer reading. |

### Q4 — Ratification of already-shipped #517-track decisions

Recorded retrospectively, not re-decided: **(a)** the workhorse registers via operator-local `~/.pi/agent/models.json` with a commented example in `agent/models.example.json` — never enabled in shared content, because pi treats key-command presence as availability and the model would appear available on hosts without oMLX (#518, ADR-0026 mechanism); **(b)** the classifier orders candidates cost-honest — the workhorse's true cost 0 leads, ties break smallest-window-first, no fabricated nonzero cost (#363); Copilot entries carry their API **list** prices, so they never tie with the workhorse — with the caveat that list price overstates a subscriber's marginal (quota) cost; **(c)** the workhorse's capable set (`simple-qa · code-edit · code-review · agentic-loop`; deliberately not `long-context` or `creative`) is seed data in `agent/extensions/shared/routing-matrix.json`, unconsumed until #352 (#363).

## Decision Outcome

1. **Tier ladder (Q1.A):** local workhorse for read-only specialist fan-out; `github-copilot/claude-opus-4.7` for the review trio; session-default frontier for the orchestrator; Copilot rung automation deferred to #536.
2. **Mechanism (Q2.A):** frontmatter pins gated at spawn time — `agent/extensions/subagent/model-pin.ts`, threaded through `runSingleAgent` and all three call sites, with the omission note surfaced in single/parallel/chain tool results.
3. **Precedence guard (Q3.A):** `agent/extensions/auto-router/argv-guard.ts` (`hasExplicitModelFlag`), consumed in `before_agent_start` ahead of all routing work.
4. **Ratifications (Q4):** the #518 registration mechanism, #363 cost-0 classifier policy, and #363 capable-set seed are policy of record.

## Consequences

- **Positive:** pinned fan-out children never re-route, never pay classifier/probe cost, and never rewrite the operator's global default (#533's blast radius shrinks to interactively routed turns). Mirror consumers get unchanged behavior instead of broken subagents. The trio's Copilot binding is deliberate, visible when degraded, and greppable (`model: github-copilot/claude-opus-4.7`).
- **Negative / accepted gaps:** (a) the guard is argv-anchored — a resumed session or a mid-session `/model` pick leaves no argv trace, so those turns are unguarded; pi persists no "how was this model chosen" provenance to do better. (b) Pinned-child turns produce no task-type records, narrowing #352/#520's measurement population — largely moot while oMLX reports no streaming usage (#521). (c) Static pins are capability-blind per invocation: the matrix excludes `long-context` from the workhorse's capable set, yet a pinned specialist can receive a long-context task; #352's matrix-aware routing (with Q2.C) is the designed remedy. (d) Registry presence ≠ liveness (#534). (e) A gated-off pin means the child inherits whatever the session default is — on a host with no cloud auth at all, that can itself be the workhorse or nothing; the note makes it visible, not correct.
- **Neutral:** `linter` and the interactive agents remain on the session default; the routing-matrix schema and consumers are untouched.

## Doc-Impact

| Surface | Classification | Reason |
|---|---|---|
| `adrs/0076-*.md` | in-scope | this ADR |
| `README.md` ADR list + directory tree | in-scope | new ADR row; new `argv-guard.ts`/`model-pin.ts`/`test-subagent.sh` files |
| `agent/AGENTS.md` model-pin prose | in-scope | trio requalified; 14 workhorse pins added |
| `agent/extensions/auto-router/README.md` | in-scope | guard subsection; resolve the "#519's ADR" forward reference to ADR-0076 |
| `agent/extensions/subagent/README.md` | in-scope | spawn-time gate behavior |
| `agent/skills/pi-agent-expert/references/subagent-internals.md`, `cli-and-modes.md`, `settings-and-config.md` | in-scope | gate at the documented `--model` argv site; guard semantics; ADR cross-reference |
| `agent/models.example.json` comment | in-scope | cite ADR-0076 alongside #518 |
| `scripts/validate.sh` | in-scope | 9b-subagent test-suite block |
| Copilot fan-out fallback docs | out-of-scope — tracked | #536 |

## More Information

- Filed during design: #533 (setModel default-persistence), #534 (liveness gate), #535 (linter pin evaluation), #536 (Copilot rung).
- pi internals verified against both the installed `v0.79.10-psmfd.1` and `v0.80.2-psmfd.1` (no relevant skew): extension loading in all modes, `resolveCliModel` hard-exit vs. warning branches, `setModel` default persistence, absence of child/pin provenance signals.
