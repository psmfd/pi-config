---
status: Accepted
date: 2026-07-12
---

# ADR-0094: Capability-driven local-LLM policy — global role lever, per-agent tag, matrix-decided models

**Status:** Accepted
**Date:** 2026-07-12
**Related:** [ADR-0090](0090-stable-router-subagent-model-policy.md) (the per-session/per-agent axes this composes with), [ADR-0081/#534] (the liveness "treat pin as absent" mechanism the pin backstop generalizes), [ADR-0082](0082-linter-stays-on-session-default.md) (the #535 discipline finding behind the structural bash floor), [ADR-0084] (user-layer-settings trust boundary), #685 (the capability issue), #656 (capability tiers + provider rows, the follow-on), #365 (finer-grained capability gates — schema must stay compatible)

## Context and Problem Statement

Local-model usage was governed by three disjoint mechanisms: 13 wrapper
`model: omlx/coding-workhorse` pins (hardcoding a model ID in 13 files), a
hardcoded `DEFAULT_LOCAL_SUBAGENT_MODEL` branch in the subagent policy seam,
and auto-router's shared candidate pool in which the model that runs the
classifier side-call and the model a real turn routes to were
indistinguishable. There was no way to say "local may classify but never do
the work," and no single place answering "may this agent use a local model?"

Design research (3-agent fan-out) established: `preferLocal: false` only
reorders (a zero-cost local candidate wins cost-rank anyway — exclusion must
filter the array); local re-enters through five paths beyond the candidate
pool (`/auto lock`, `model_select` auto-capture, the hardcoded subagent
default, wrapper pins, and an unpinned child re-running auto-router in its
own process); and 13 of 21 wrappers pinned local, so any lever subordinate to
pins would be dead on arrival.

## Decision Outcome

A four-layer capability-driven composition; each layer answers one question:

1. **Global lever** — `extensionSettings.localLlm.role: "full" |
   "classifier-only" | "off"` (default `full`), USER-layer settings.json
   only (a hostile repo's project layer must never steer local usage).
   Parsed by one shared reader (`shared/local-role.ts`) consumed by both
   auto-router and subagent, so the two extensions cannot drift. Because
   spawned children read the same user-layer file, the lever crosses the
   process boundary with no extra plumbing — the child re-derivation path
   closes itself.
2. **Per-agent tag** — `local-llm: true` wrapper frontmatter (default
   **false**, fail-closed: untagged and third-party wrappers never ride
   local). The tag is permission, not sufficiency: effective eligibility is
   `tag ∧ NOT local-forbidden ∧ lever == full`, where local-forbidden stays
   the structural tools floor (bash-capable or unrestricted — the
   #535/ADR-0082 discipline finding). A tag on a bash wrapper is a test
   failure, never honored.
3. **Matrix decides the concrete model** — the hardcoded
   `DEFAULT_LOCAL_SUBAGENT_MODEL` branch is deleted; eligible agents flow
   through the same `resolveCapabilityPick` as everyone else with local
   candidates in the pool (zero-cost local wins its capable set, preserving
   prior behavior under `full`). Wrapper `model:` pins remain only as a
   documented escape hatch (evals, dodging a bad model version), unused by
   first-party wrappers — the 13 local pins are migrated to tags in this
   change; capability tiers for the 3 remaining cloud pins land with #656.
4. **Auto-router two-pool split** — `buildRoutingPrompt` now returns a
   classifier pool (which model may RUN the classify() call — local allowed
   under `classifier-only`) and a target pool (what the turn may route to —
   the menu, `resolveChoice`, and matrix picks all use it). A menu left
   local-only under a restricted lever is a distinct, actionable
   `local-restricted` outcome.

Enforcement at the bypass paths: `/auto lock current|set` **refuses** a
local model while the lever restricts local (two conflicting operator
directives must surface, not silently resolve); a manual `/model omlx/…` is
honored for the live session (operator's in-the-moment call, same category
as the argv `--model` precedence rule) but **not auto-captured** into the
persisted lock; and `applyLocalRole` in the subagent pin path drops a local
requested model **fail-closed even when the registry is unreadable** —
liveness answers "is it up?", the lever answers "is it allowed?", and an
operator restriction must hold in indeterminate states (deliberate contrast
with the liveness filter's fail-open posture).

### Considered and rejected

- **Lever subordinate to wrapper pins** — dead on arrival with 13 local
  pins; also removed the need for the debate by migrating the pins to tags.
- **Boolean lever** — loses the classifier carve-out that makes the
  restriction cheap to live with (the side-call is the one place local is
  near-free and low-risk).
- **`preferLocal: false` as the exclusion mechanism** — reorders only;
  zero-cost local still wins.
- **Per-extension duplicated settings readers** (the preferLocalOmlx
  precedent) — two parsers of one policy invite drift; a shared reader
  costs one import.

### Consequences

- The matrix becomes load-bearing for local-eligible agents too: with a
  `null` (unreadable) matrix, an unpinned eligible agent falls to the
  session default instead of a hardcoded local model. Accepted — the
  centralized-matrix trade is the point; #656 populates provider rows and
  #660's refresh metadata (PR #687) keeps it tended.
- Until #656 lands rows, a tagged agent whose local candidate is down falls
  to the session default (previously: pin-drop → Copilot fallback rung).
  Transitional; #656 restores a non-local rung via the matrix.
- Lever changes apply next session (auto-router) / next tool call
  (subagent) — same read-once posture as preferLocalOmlx.
- **Point-of-use enforcement (post-review amendment, PR #691):** the
  three-way review of this arc found the lever enforced at every lock
  *write* site but not where locks and cached decisions are *used* — the
  canonical write-time-only access-control gap (CWE-862 shape). Closed:
  `/auto on`'s auto-capture is now lever-gated like the other write sites;
  a persisted local lock is bypassed (surfaced, never silently cleared) at
  application time; the decision cache is cleared on session_start AND a
  cache hit re-validates a local target against the lever inside route().
- **Accepted gap — unprofiled project-agent overrides:** a project-scoped
  wrapper shadowing an unprofiled first-party agent (e.g. the review trio,
  which carries `capability-tier` but no `guard-profile`) can override any
  frontmatter, including downgrading `capability-tier` or setting
  `local-llm: true` — within the lever and bash-floor bounds, which repo
  content can never widen. This is the pre-existing ADR-0093 trust boundary
  (full wrapper replacement was already possible; a tier downgrade is
  strictly weaker), gated interactively by the project-agent confirmation.
  Recorded here so the new one-line downgrade levers are a documented part
  of that boundary, not an oversight.
- **Combined tags:** `local-llm: true` + `capability-tier` on one wrapper
  compose — the tier pick operates on the lever/tag-filtered pool, so a
  local row satisfying the tier is selectable only for an eligible agent
  under a `full` lever (pinned by test). No first-party wrapper combines
  them today.
