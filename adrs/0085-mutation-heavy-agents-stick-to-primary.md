# ADR-0085: Bash-capable (mutation-heavy) agents stick to the primary, not local

**Status:** Accepted
**Date:** 2026-07-08

## Context and Problem Statement

ADR-0076 established the subagent model-tier ladder: read-only specialists prefer the local `omlx/coding-workhorse`, the review trio is pinned to `github-copilot/claude-opus-4.7` for reasoning quality, and the interactive agents (`gh-cli-expert`, `gitflow-expert`, `work-item-management-expert`) plus `linter` inherit the parent session's model. ADR-0076 framed those inheriting agents as **unpinned "pending evidence"** — language implying they were destined for the local pin once a fixture battery cleared them. ADR-0082 then ran that battery for `linter` and kept it on the session default: through the wrapper, the workhorse rewrote the target file under a "fix it" instruction (once following the destructive guard's own advertised override), while the frontier model held the report-only contract.

That evidence generalizes. A local model's discipline gap is most dangerous exactly where an agent can **execute mutating commands** — the `bash` tool. The `linter` result was for a *read-only* wrapper; the interactive agents carry `bash` with git / `gh` / work-item write reach and have no battery evidence at all. Continuing to frame them as "eventually local, pending evidence" points the tier ladder at its highest-risk targets.

The operator decision is to invert that framing: **agents that carry the `bash` tool default to NOT local — they stick to the primary (session-default) model** — regardless of the wrapper's declared `mode`. The classifier for the rule is tool capability, not `mode`, because a `mode: read-only` wrapper can still hold `bash` and therefore still carry mutation reach that a local model might misuse under instruction.

Auditing the 21 wrappers against a "has `bash` → primary" discriminator, the current pin state already matches the desired posture for 20 of them (the interactive three already inherit the primary; the review trio keeps its quality pin; the 13 no-`bash` read-only specialists stay local). The **single** misalignment is `helm-expert` — `mode: read-only` but `bash`-capable (constrained to read-only `helm` render/diff), currently pinned `omlx/coding-workhorse`.

## Considered Options

* **Option A — `has-bash` discriminator; unpin `helm-expert`; record the interactive agents as unpinned-by-policy.** Read-only + no `bash` → local; any `bash`-capable wrapper → primary (unpinned), except the two named quality/evidence exemptions. The only wrapper edit is unpinning `helm-expert`.
* **Option B — `mode: interactive` discriminator.** Only the three `mode: interactive` agents stick to primary; `helm-expert` (read-only mode) stays local. Rejected: `helm-expert` holds `bash` and can execute `helm` subprocesses, so it carries the exact mutation reach the operator wants off local; keying on `mode` leaves that reach on a local model.
* **Option C — Keep the "pending evidence" hold; run an ADR-0082-style battery for each `bash`-capable agent before deciding.** Rejected for now: the operator accepts the policy outright — mutation reach is a sufficient reason to stay on the primary without a per-agent battery. The battery remains available if a future operator wants to *promote* one of these agents to local.
* **Option D — Add a central `subagent.forceLocalFanout` override with exemption lists.** Rejected: with the review trio, `linter`, and every `bash`-capable agent exempted, the "force all local" set collapses to the 13 wrappers already pinned local. A central override with three exemption lists is strictly more machinery than unpinning one wrapper.
* **Option E — Do nothing.** Rejected: leaves `helm-expert` (a `bash`-capable agent) on the local workhorse and preserves ADR-0076's "pending evidence" framing that points the ladder at the interactive agents.

## Decision Outcome

Chosen option: **A — `has-bash` discriminator, unpin `helm-expert`, record the interactive agents as unpinned by policy.**

The subagent model-routing taxonomy is:

| Class | Rule | Model |
| --- | --- | --- |
| Read-only, no `bash` | default local fan-out | `omlx/coding-workhorse` (frontmatter pin) |
| Carries `bash` (mutation-capable) | stick to primary | unpinned → session-default |
| Quality-gated review trio (`code-review-expert`, `security-review-expert`, `checkmarx-expert`) | exempt (quality) | `github-copilot/claude-opus-4.7` (unchanged) |
| `linter` | exempt (evidence) | unpinned → session-default (ADR-0082, unchanged) |

The two exemptions win over the `has-bash` rule: `code-review-expert` and `checkmarx-expert` carry `bash` but keep their opus pin because reasoning quality — not mutation risk — governs them. The single config change is removing the `model: omlx/coding-workhorse` pin from `agent/agents/helm-expert.md`, so it inherits the primary like the other `bash`-capable agents.

This ADR **supersedes ADR-0076's "pending evidence" framing** for the interactive agents: they are unpinned *by policy* (mutation-capable), not provisionally pending a battery. ADR-0076's body is not edited (supersession, not editing); this ADR records the change. ADR-0080 (Copilot fallback rung), ADR-0081 (oMLX liveness gate), ADR-0082 (linter), and ADR-0083 (orchestrator provider split) are unaffected mechanically — the spawn-time gate, fallback ladder, and provider restriction all behave identically; this ADR only changes which wrappers carry a local pin.

### Setting the primary and leaving it

The companion operator goal is "set the primary once and leave it" — Anthropic, Copilot, or a local model. The **zero-code** path already achieves this: auto-router is off by default (`DEFAULT_STATE.enabled: false`), so running `/model <provider/id>` once persists that model as pi's global default across sessions (via pi's native `setModel`). All `bash`-capable and unpinned agents then inherit it; the local and opus frontmatter pins resolve independently through the spawn-time gate. This ADR documents that path rather than adding a command for it.

Two caveats are recorded, not fixed:

* **auto-router-off assumption.** "Unpinned → primary" holds because an unpinned child receives no `--model` on argv, and with auto-router off (its default, propagated to children via the shared disk state) the child inherits the session default. If auto-router is *enabled*, the argv-guard gap means those unpinned mutation-capable children are re-routed by the classifier/matrix — which has local rows — and could land on the workhorse, violating this policy. Making the rule robust with auto-router on (spawn-gate pin injection, or the exact-model persisted pin) is deferred to #618 / #619.
* **#533 global-default hazard.** The native `setModel`-persists behavior does not distinguish a deliberate "set the primary" action from an incidental mid-session `/model` switch — both persist globally. Unchanged existing behavior; noted so operators know the "leave it" is a global default, not a session-scoped pin.

## Consequences

* Good: A local model's discipline gap can no longer be exercised through a `bash`-capable agent by default — the mutation surface stays on the operator's chosen primary tier.
* Good: The change is one wrapper edit (`helm-expert` unpin); the other 20 wrappers already match the taxonomy, so there is no frontmatter churn and no `agent/extensions/subagent/**` change (no drift-manifest regeneration).
* Good: The "set primary and leave it" goal needs no code — the native `/auto off` + `/model` path is documented and works for Anthropic, Copilot, or local primaries.
* Bad: `helm-expert` loses free local fan-out; its turns now consume the primary tier's quota/credits like any other `bash`-capable agent. Accepted: the operator prefers mutation-capable agents on the trusted primary over local cost savings.
* Bad: The `has-bash` discriminator is coarse — `helm-expert` is constrained to read-only `helm` operations yet is treated as mutation-capable purely for holding `bash`. Accepted as the conservative default; a future operator can promote a specific `bash`-capable agent to local with an ADR-0082-style battery (Option C).
* Neutral: The review-quota blocker from `notes/expertise-consumption-restart.md` (review trio pinned to Copilot; blocked when oMLX is down and Copilot quota 429s) is **not** addressed here — the trio stays on `github-copilot/claude-opus-4.7` by decision. Moving review off Copilot remains a separate track.

## More Information

Implementation surfaces:

* `agent/agents/helm-expert.md` — remove the `model: omlx/coding-workhorse` frontmatter pin (inherit primary).
* `agent/AGENTS.md` — model-pin tier prose restated with the `has-bash → primary` taxonomy and the "set primary and leave it" path.
* `agent/extensions/auto-router/README.md` — new "Set the primary and leave it" subsection; the primary/orchestrator section's subagent paragraph updated to the taxonomy.
* `agent/skills/pi-agent-expert/references/settings-and-config.md` — the live "fourteen read-only specialist wrappers" count corrected to thirteen (no-`bash` specialists) with the ADR-0085 refinement noted.
* `README.md` — ADR index row.

Related ADRs: ADR-0031, ADR-0076, ADR-0080, ADR-0081, ADR-0082, ADR-0083, ADR-0084.

Tracking: issue #618; deferred exact-model primary pin issue #619.
