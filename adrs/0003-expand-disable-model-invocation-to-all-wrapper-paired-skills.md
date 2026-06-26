# ADR-0003: Expand `disable-model-invocation: true` to all wrapper-paired expert skills

**Status:** Accepted
**Date:** 2026-05-19
**Companion to:** [ADR-0001](0001-subagent-orchestration-substrate.md) — refines the Phase D scope decision
**Implementing PR:** #77

## Context and Problem Statement

ADR-0001 Phase D set `disable-model-invocation: true` on three skills only — `code-review-expert`, `security-review-expert`, `checkmarx-expert` — to force their wrappers to be the sole entry point. The rationale was specific to those three: read-only specialists with strict tool restrictions whose verdict-shape contract depends on isolated-subprocess execution. The other 15 wrapper-paired expert skills (the 14 domain experts + `pi-agent-expert`) remained discoverable through the parent's `<available_skills>` block as auto-trigger candidates.

In practice, every one of those 15 skills is *also* paired with an agent wrapper in `agent/agents/<name>.md`, and `agent/AGENTS.md` § Behavioral rules already mandates **agent-first routing** for all delegated work — the orchestrator is required to route to a wrapper when one covers the domain, not to inline-load the skill. The auto-trigger surface on the 15 unhidden skills was therefore offering a routing path the rule explicitly forbids, with no compensating benefit:

1. **Orchestrator never used it correctly.** Whenever the orchestrator did auto-trigger one of the 15 skills inline, that was already a rule violation per `rules/agent-first-selection.md`. The auto-trigger surface only made violations easier, not better-shaped.
2. **Token cost was non-trivial.** Each skill's frontmatter `description` (some 400–800 chars) was injected into the parent system prompt on every session start. Eighteen skills × ~400 chars ≈ 7–11 KB of context budget, paid every session.
3. **Subagent subprocesses already loaded the skill explicitly.** Every agent wrapper in `agent/agents/<name>.md` instructs the spawned child to `read ~/.pi/agent/skills/<name>/SKILL.md` or `/skill:<name>` — those mechanisms are unaffected by `disable-model-invocation` (confirmed against pi internals at `<pi-install>/dist/core/skills.js`). The flag suppresses parent auto-trigger; it does not block the wrapper's deliberate load inside the subprocess.
4. **The catalog in `agent/AGENTS.md` is the canonical routing index.** Generated from `agent/agents/*.md` frontmatter by `scripts/regen-agent-catalog.sh`, it lists all 18 wrapper-paired specialists with descriptions sized for routing decisions. The orchestrator already reads this. The duplicate skill descriptions in `<available_skills>` added no routing signal the catalog did not already provide.

The original ADR-0001 Phase D scoping ("on `code-review-expert`, `security-review-expert`, `checkmarx-expert`") was the right *first move* — it proved the pattern without bulk migration. Eight months later, the pattern is uncontroversial within the repo, the agent-first rule is mature, and the partial-coverage version is leaking context budget for no enforcement gain. The question is whether to extend the flag to the remaining 15 wrapper-paired skills or leave the partial scoping in place.

## Considered Options

* **Option A** — **Set `disable-model-invocation: true` on all 18 wrapper-paired skills.** Uniform agent-first enforcement; ~7–11 KB context reclaimed per session; the three review specialists remain additionally distinguished by opus pinning and read-only tool allowlist (their hardening is structurally independent of this flag).
* **Option B** — **Preserve status quo.** Only the three review specialists carry the flag. Continue paying the parent-prompt token cost for the other 15 descriptions. Accept that the orchestrator-protocol rule must do all the agent-first enforcement on those 15.
* **Option C** — **Hybrid scoping by criteria.** Hide skills whose wrapper has restrictive `tools:` allowlists; leave others discoverable. Adds a per-skill judgment call and a maintenance burden (when does a new skill cross the threshold?).
* **Option D** — **Remove the flag from the review trio too; rely on the orchestrator-protocol rule alone for routing.** Maximum auto-trigger surface, weakest structural enforcement. Reverses Phase D entirely.

## Decision Outcome

Chosen option: **A — set the flag on all 18 wrapper-paired skills**.

The flag does exactly one thing for our substrate: it removes the inline auto-trigger path that the agent-first rule already forbids. Applying it to every wrapper-paired skill aligns the structural surface with the behavioral surface — the model is no longer offered an option the rule tells it not to take.

The three review specialists retain their *additional* hardening:

* **Opus pinning** (`model: claude-opus-4.7` in the wrapper) — guarantees reasoning quality independent of the parent session's model.
* **Read-only tool allowlist** (`tools: ["read","bash"]` with the bash-destructive-guard active) — prevents accidental writes during review.

These constraints are structurally orthogonal to `disable-model-invocation` and are unchanged by this ADR.

Implementation already merged in PR #77 (commit `b75601a`, 2026-05-19): one frontmatter line added to each of the 15 SKILL.md files that did not previously carry the flag, plus four doc-sync sites updated (`agent/AGENTS.md`, `README.md`, `agent/skills/pi-agent-expert/SKILL.md`, `agent/skills/pi-agent-expert/references/agent-and-skill-authoring.md`) to reflect that the flag is now project-wide rather than trio-scoped.

Options B, C, D rejected:

* **B (status quo)** continues paying ~7–11 KB of parent context per session for a surface the orchestrator-protocol rule already requires not be used.
* **C (hybrid)** introduces a maintenance burden — every new skill triggers a "should this one be hidden?" debate — with no clear principle to settle it. The agent-first rule already says "all of them, always"; the flag should match.
* **D (remove entirely)** reverses Phase D and weakens enforcement of the rule that everything else in the substrate depends on.

### Tradeoffs

* Good: Aligns structural enforcement with the existing agent-first behavioral rule — the inline auto-trigger path the rule already forbids is now also unavailable mechanically.
* Good: Reclaims ~7–11 KB of parent system-prompt context per session start (~6% of the typical bootstrap budget at our skill descriptions' current verbosity).
* Good: Uniform convention across all 18 wrapper-paired skills — no per-skill judgment call required for future additions. The new-skill template now reads "carries the flag" without exception clauses.
* Good: Subagent subprocess behavior is unchanged — every wrapper explicitly loads its paired skill via `read` or `/skill:<name>`, which is unaffected by the flag.
* Good: No catalog impact — `scripts/regen-agent-catalog.sh` reads only `agent/agents/*.md` frontmatter; skill frontmatter changes do not affect the routing table.
* Bad: `/skill:<name>` tab-completion is now the only manual-load path in interactive mode (descriptions still surface there per pi's `interactive-mode.js:339`); operators who relied on auto-trigger as a "skill exists" discovery cue must now consult either `/skill:` or the AGENTS.md catalog. Mitigated by the catalog being the canonical routing surface anyway.
* Bad: Reduces the parent's ability to opportunistically inline an expert skill for a one-off question that doesn't justify a full subagent spawn. The orchestrator-protocol rule already required this to go through the wrapper, so the practical loss is small, but the latency tax (extra ~few-hundred-ms subprocess spawn) is now unavoidable for any expert-skill consultation.
* Bad: Adds one more invariant for new-skill contributors to know about. Mitigated by codifying it in `rules/skill-description-style.md` (proposed follow-up; see "More Information" below).

## More Information

### Implementation summary

PR #77 (`chore/hide-expert-skills-from-prompt`, merged 2026-05-19, commit `b75601a`):

| Files | Change |
|---|---|
| 15 × `agent/skills/<name>/SKILL.md` | Added `disable-model-invocation: true` to frontmatter (one line each). The 15 not previously carrying the flag: `ansible-expert`, `azure-devops-expert`, `azure-infra-expert`, `docker-expert`, `docs-expert`, `dotnet-expert`, `gh-cli-expert`, `gitflow-expert`, `helm-expert`, `linter`, `pi-agent-expert`, `shell-expert`, `tauri-expert`, `vcluster-expert`, `work-item-management-expert`. |
| `agent/AGENTS.md` | Rewrote the per-agent-constraints paragraph to describe the flag as project-wide. The three review specialists are *additionally* distinguished by opus pinning and read-only tool allowlist. |
| `README.md` | Removed the Skills table's `Visibility` column (now uniform across all 18 rows). Rewrote the section preamble. |
| `agent/skills/pi-agent-expert/SKILL.md` + `references/agent-and-skill-authoring.md` | Generalized the `disable-model-invocation` guidance from "used by three review specialists" to "set on all 18 wrapper-paired skills". |

Validation: `scripts/validate.sh` PASS; `/review` (3-way: `code-review-expert` + `security-review-expert` + `linter`) aggregate verdict PASS on the final diff.

### Relationship to ADR-0001

ADR-0001 Phase D is **not superseded**. The Phase-D-as-written decision (set the flag on the three review specialists) remains correct and current. The Phase D scope statement was a cutover-phase decision — *which three skills to flip first* — not a permanent exclusion of the other 15; extending the flag is therefore additive, not contradictory. This ADR extends the scope of the flag's application to the remaining 15 wrapper-paired skills as a follow-on refinement; it does not invalidate any prior decision. Per `rules/adr-required.md`, ADR-0001 is not edited.

The three review specialists' *additional* hardening (opus pinning, read-only tool allowlist) was always orthogonal to the flag itself and remains unchanged by this ADR.

### Follow-ups (not in this ADR)

1. **Skill-description style rule.** With all 18 descriptions now invisible to the parent system prompt, their audience collapses to `/skill:` tab-completion + RPC `listSkills` + human repo readers. A consensus panel (`docs-expert`, `pi-agent-expert`, `code-review-expert`) recommended trimming the current 200–800 char "Use when…" prose to ~100–180 char topic labels, gated on first codifying the convention as `agent/rules/skill-description-style.md`. Tracked as a separate follow-up PR.
2. **`agent/agents/<name>.md` wrapper descriptions.** These remain verbose by design — they feed the AGENTS.md catalog, which is the canonical routing surface for the orchestrator. No change planned.

### Cross-references

* ADR-0001 § Decision Outcome (Phase D scope statement) — original three-specialist scoping that this ADR extends.
* `agent/rules/agent-first-selection.md` — behavioral rule the flag now structurally enforces for all 18 wrapper-paired skills.
* `agent/rules/post-implementation-review.md` § Doc-sync pairs — `README.md` Architecture Decisions list updated as required.
* pi `docs/skills.md` — first-party documentation of `disable-model-invocation` semantics (observed against pi 0.75.3).
* pi `<pi-install>/dist/core/skills.js` — observed runtime behavior (pi 0.75.3): flag filters skills from `<available_skills>` only; `read` and `/skill:<name>` paths are unaffected.
