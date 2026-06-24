---
status: Accepted
date: 2026-05-29
---

# ADR-0024: `gh-identity-guard` — per-command inline skip + override-hint hardening

**Status:** Accepted
**Date:** 2026-05-29
**Tracking issue:** [#276](https://github.com/TheSemicolon/pi_config/issues/276)
**Related:** [ADR-0022](0022-gh-identity-guard-extension.md) (the guard's design; §Q5 override surfaces), [ADR-0023](0023-gh-identity-guard-remote-scoping.md) (host-scoping)

## Context and Problem Statement

`SKIP_GH_IDENTITY_GUARD=1` is read once at extension load, so it is a session-wide disable; a per-command prefix inside a running session (`SKIP_GH_IDENTITY_GUARD=1 git push …`) sets the env var for the spawned shell, not the already-loaded extension, and is silently not honored. #265 reported this as confusing. #276 asks for a per-command inline skip so a one-shot disable works in-session, parallel to `GH_IDENTITY_OVERRIDE=`.

A pre-existing, related hazard surfaced during design review: the probe-error message (`index.ts probeErrorReason`) listed `SKIP_GH_IDENTITY_GUARD=1` as the **first** "override path" — i.e. it coached a *blocked agent* toward disabling the guard, the exact action the guard exists to prevent. A per-command skip makes that hint directly actionable as a command prefix, so the two must be addressed together.

The guard's security property: **a wrong-identity push to a github.com repo is blocked UNLESS a human operator deliberately, visibly disabled the guard for that call.** A per-command skip is an intentional disable; the risks are (a) *over-broad* disabling via compound commands and (b) *loophole framing* that turns the skip into an agent's go-to unblock.

## Considered Options

- **A. Whole-string skip parser** (mirror `parseOverride`, scan the leading run of the entire command). Rejected: a leading-run parser over-disables compound commands — `SKIP_GH_IDENTITY_GUARD=1 true && git push` would exempt the push, even though the shell only delivers the var to `true`. Verified against bash assignment semantics.
- **B. Per-segment skip association.** Honor the skip only when `SKIP_GH_IDENTITY_GUARD=1` leads the *same* simple-command segment as the mutation. **Chosen** — it matches what the shell actually does.
- **C. Recognize `export`/`declare` forms too.** Rejected: invites builtin-parsing and widens the surface; the session-wide skip is the correct tool for a persistent disable.

## Decision Outcome

### Per-command inline skip (per-segment)

`classify()` scans segments (it already does, for host-scoping). A mutating segment whose own leading `NAME=value` run contains `SKIP_GH_IDENTITY_GUARD=1` is **exempted**: not added to `gitPushes`, does not set `reason`/`unconditional`. `ClassifyResult.inlineSkip` records that ≥1 segment was exempted, so the caller can announce it. Implemented as `hasInlineSkip(tokens)` in `classifier.ts` (not `overrides.ts`: a skip *nullifies* the guard, the opposite safety profile to `GH_IDENTITY_OVERRIDE`, which *asserts* an identity — keeping it out of the "overrides" module avoids implying equivalence).

Rules:

- **Value must be exactly `1`** (matching the session-wide `=== "1"` contract; `tokenize()` strips wrapping quotes so `="1"`/`='1'` arrive as `1`). `=0`/`=true`/`=`/`=2` are not a skip.
- **Per-segment only.** `SKIP=1 true && git push` does NOT exempt the push; `SKIP=1 git push origin && git push backup` exempts only the first.
- **Bypass-net shapes always gate.** When the bypass-DENY net fires (`bash -c`/`eval`/`xargs`/`$()`), the classification is `unconditional` and the inline skip is **ignored** — the net exists precisely for shapes where static reasoning fails, so it must not be defeatable by an outer prefix. (Operators use the session-wide skip for those.)
- **`export VAR=1; …` not recognized** — direct prefix form only.

In `index.ts`:

- **Ambiguity → block.** If both `GH_IDENTITY_OVERRIDE=` (valid) and an inline skip are present, the intents contradict (assert vs disable); an explicit pre-check blocks with a "contradictory overrides" error rather than letting evaluation order silently pick one.
- **Announce, never silent (ADR-0022 §Q5).** An honored skip emits a `warning` notify framed as an operator override — *"OPERATOR SKIP … This is an operator override, not an agent action."* In a headless (`!ctx.hasUI`) session the skip is still honored but cannot be announced — accepted gap, consistent with the session-wide bypass; the prefix is visible in the tool-call stream regardless.

### Override-hint hardening (loophole text)

`probeErrorReason`'s hint no longer lists `SKIP_GH_IDENTITY_GUARD=1` as a first-class recovery path. It now leads with the identity-CORRECTING paths (`gh auth switch`, `GH_IDENTITY_OVERRIDE=<login>` — both still verify identity) and names disabling the guard last, explicitly as an operator action ("Do not disable the guard to clear a block"). This closes the path by which a blocked agent could read the guard's own error text as permission to self-disable.

## Consequences

- **Positive:** the documented session-start-only limitation is lifted for the common single-command case; the skip can't be smuggled (leading-outer-run only excludes quoted args, commit messages, URLs, heredocs) or over-applied across a compound command; the guard's error text no longer coaches self-disable.
- **Negative / accepted gaps:** a headless skip is honored without a UI announcement (prefix still visible in the tool stream). `export`-form and bypass-net-shape skips are intentionally not honored (operators use the session-wide skip).
- **Framing risk:** the README must present the inline skip as an operator-only action, not an agent unblock. The threat model and §Q5 override table are updated accordingly.
- **Testing:** `classifier.test.ts` covers per-segment exemption, value-match, compound non-over-disable, bypass-net-gates, and no-smuggling; `index.test.ts` covers allow+announce, partial-compound gating, ambiguity block, non-mutating no-announce, headless honor, and bypass-net gate.
