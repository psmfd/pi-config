---
status: Accepted
date: 2026-08-19
---

# ADR-0144: response-channel communication contract — adapted structure, measured, never rewritten

**Status:** Accepted 2026-08-20 — implemented with #1029. The two open decision points resolved at implementation: (1) **seed list** = the upstream repo's example list verbatim (five phrases; operator decision 2026-08-20) — a small, attributed, structural seed rather than a wholesale tuned-list import; #1034's tic-meter remains the growth instrument. (2) **Orchestrator-only**: the contract is not loaded into subagent children — ADR-0124 already suppresses child context files by default, children's output is governed by the research-parallelism return contract and read by the orchestrator rather than the operator, and per-child prefill for an unread channel fails the leanness gate; revisit only if a child-authored channel becomes operator-facing. Prefill cost of the orchestrator-side wiring measured with `prefill-meter` before/after in the #1029 PR. Originally filed Proposed with #1029 (contract + templates) and #1034 (tic-meter) on 2026-08-19.

**Related:** [ADR-0142](0142-plain-english-write-enforcement.md) (the docs-channel sibling, and the upstream-attribution pattern this follows), docs-expert SKILL.md §Plain-English Pass (#1009), `agent/rules/structured-review-format.md` (the existing code/verdict discipline the reference codes compose with), [ADR-0125](0125-prefill-meter-extension.md) (the cost instrument), [ADR-0073](0073-token-meter-extension.md)/[ADR-0034](0034-cache-ratio-measurement.md) (the meter-family shape for the measurement half). Upstream: [disler/fixing-smartass-opus-5](https://github.com/disler/fixing-smartass-opus-5) (MIT) @ `5a349e8`, assessed 2026-08-19; adoption queued in psmfd/FingerTrap ADR-0027.

## Context and Problem Statement

Every persisted channel in this stack has a contract with teeth: markdown writes are rewritten in flight (ADR-0142), commits have shape rules plus the proposed trailer guard (ADR-0143), reviews have a structured format with machine verdicts. The chat-response channel — the one the operator reads on every turn of every session — has nothing: no communication rule in `agent/rules/`, no appended system prompt anywhere. Verbosity, sycophancy, banned-phrase tics, and heading theater are ungoverned exactly where they cost the most reading time.

The upstream repo demonstrates the fix class and its portability (its own `just sr-pi` recipes run the identical file through pi's `--append-system-prompt`), but two of its properties do not transfer: the banned-word list is Opus-5-specific by its author's own statement, and this stack routes across models (`auto-router`); and its mechanism is wholly advisory, which for *this* suite raises the standing question — what enforcement level does the channel actually support?

## Decision Drivers

- **The response channel cannot be mechanically rewritten.** Responses stream to the operator live; the session transcript treats the event stream as the single source of truth (a post-hoc rewrite forks display from log — the exact divergence ADR-0142's pre-write design exists to avoid); and the suite's own precedent (`plain-english` excluding `edit` fragments) already declined the analogous structurally-unsafe case.
- **Structure must outlive the word list**: model-specific tics drift per model and per release; the contract's skeleton (patterns / codes / boundaries / examples) should survive every model swap with only the word list re-seeded.
- **Standing prompt text is paid on every turn** — `prefill-meter` exists precisely to price such additions, and the contract must state its own cost.
- **Aliases must not cost standing tokens** when the prompt-template system already provides the same expansion for free at the point of use.
- **No duplicated rule text**: hard boundaries that already live in `plan-before-code`, `post-implementation-review`, and `conventional-commits`/ADR-0143 must be referenced, not restated — two prose sources for one rule is a drift hazard.
- Upstream attribution per the ADR-0142 pattern (gvzdv/claudish-to-english precedent).

## Considered Options

1. **Adapted contract as an agent rule + prompt templates + measured compliance** — structure adopted, word list seeded from this stack's observed tics, tic-meter as the number.
2. **Verbatim adoption** of the upstream file as an appended system prompt.
3. **Mechanical response rewriting** — "plain-english for responses".
4. **Nothing** — status quo.

## Decision Outcome

**Option 1.**

- **`agent/rules/communication-contract.md`**, wired into the installed global agent context: positive/negative patterns with a banned-word list seeded from tics observed in this stack's own transcripts (#1034's recorder is the seeding instrument) *(seeding bootstrap resolved at acceptance: the upstream example list — see Status)*; `F/D/O/R/Q/A` reference codes for multi-item answers, composing with `structured-review-format.md` rather than competing with it; hard boundaries as one-line pointers to the rules that own them; a do/do-not examples section maintained by distillation — the upstream repo's strongest idea, kept intact (models pattern-match examples harder than rules).
- **Prompt templates over in-prompt aliases**: `agent/prompts/{scr,eli,foc,ref}.md`. Discoverable via `/` in the TUI and listed to FingerTrap's composer through `get_commands`; zero standing prompt cost. In-prompt alias expansion is rejected: it pays tokens on every turn for a lookup table the template system already provides at the point of use.
- **Measurement is the channel's enforcement ceiling**: #1034's tic-meter (meter-family shape, inert by default) records banned-phrase hits, em-dash density, heading counts, and response length per assistant message — the upstream compare-loop institutionalized as a trend instead of an eyeball test, and another observe-from-outside JSONL series for FingerTrap's FT-2 slice-7 dashboards.
- **Prefill cost is a merge gate**: the contract PR carries a `prefill-meter` before/after measurement, and the contract stays lean enough to justify its own number.

Option 2 is rejected: the word list is wrong for this stack's models, and the upstream boundaries duplicate rules that already exist here. Option 3 is rejected **with its reasons recorded so it is not re-proposed**: streaming, the transcript source-of-truth invariant, and the `plain-english` edit-fragment precedent all break it structurally — not a cost trade-off but a correctness one. Option 4 leaves the most-read channel the only ungoverned one.

### Consequences

- Good: the last ungoverned channel gets a contract; contract changes become measurable (#1034); the seeding loop (observe tic → add to list → watch the trend) replaces imported word lists.
- Good: four templates land as ordinary prompt files — no new machinery.
- Bad: standing prefill cost on every turn — measured, and bounded by the leanness gate.
- Bad: prose remains probabilistic; tics will still slip. The meter says which and how often; the posture is the upstream repo's own — add to the list and move on.
- Neutral: the contract's hard-boundary section stays thin by design, because enforcement for those rules lives elsewhere (worktree, ADR-0143, the Tier 3 evidence channel).

## Known Limitations and Deferred Work

- The initial banned-word list will be small until #1034 produces seeding data; importing the upstream Opus-5 list wholesale is deliberately not the bootstrap. *(Resolved at acceptance — the bootstrap is the upstream example list, five phrases; see Status.)*
- Whether the contract also loads into subagent children (or stays orchestrator-only to spare their prefill) is decided at implementation with `prefill-meter` numbers in hand. *(Resolved at acceptance — orchestrator-only; see Status.)*
