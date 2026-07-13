---
status: Accepted
date: 2026-07-12
---

# ADR-0096: Ephemeral routed model changes — surgical persistence suppression in auto-router

**Status:** Accepted
**Date:** 2026-07-12
**Related:** [ADR-0031] (auto-router), [ADR-0041](0041-conditional-security-patch-divergence.md) (mirror security-patch-only divergence policy that rules out the fork patch), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md), #533 (the bug), [earendil-works/pi#5263](https://github.com/earendil-works/pi/issues/5263) (upstream issue, maintainer-agreed direction; retirement trigger)

## Context and Problem Statement

pi's extension-facing `pi.setModel()` delegates to `AgentSession.setModel()`,
which unconditionally calls `settingsManager.setDefaultModelAndProvider(...)`
(agent-session.ts:1546 at v0.80.6), persisting the model to
`~/.pi/agent/settings.json` as the user's **global default**. auto-router
calls `pi.setModel()` on essentially every turn (routed pick, and
orchestrator-lock application), so every route silently rewrote the operator's
deliberate `/model` default (#533). No suppression option exists anywhere in
the pinned runtime; upstream agrees the behavior is wrong
(earendil-works/pi#5263) but has shipped no fix (PR #5270 was bot-auto-closed,
unmerged).

## Considered Options

1. **Patch the psmfd/pi fork** (`persistDefault` option on `setModel`,
   flipped only for the extension-facing RPC binding) and cut
   `v0.80.6-psmfd.2`. Technically ~4 lines and the cleanest semantics — but
   the mirror's public trust posture (ADR-0041, PROVENANCE.md) is **strict
   zero-divergence except manifest-tracked SECURITY patches**: "the mirror
   must not carry behavioral source patches." A QoL bug does not meet the
   security-patch bar; carrying it would mean amending a published provenance
   guarantee for convenience. Rejected on governance grounds, not effort.
2. **Global prototype no-op** (the community stopgap documented in
   upstream #5263): permanently no-op `SettingsManager.prototype`
   persistence setters at extension load. Works, but session-wide — the
   user's own manual `/model` picks would also stop persisting, a behavior
   change to a UI surface auto-router does not own. Rejected.
3. **Snapshot/restore `settings.json`** around routed turns. File-I/O race
   against concurrent pi sessions (this host routinely runs several), extra
   I/O on the hot path, risk of clobbering unrelated settings written
   mid-session. Rejected (also rejected by #533's own issue text).
4. **Surgical suppression (chosen):** swap
   `SettingsManager.prototype.setDefaultModelAndProvider` for a no-op only
   for the duration of the router's own awaited `pi.setModel()` call,
   restored in `finally`. Manual `/model` persistence is untouched.

## Decision Outcome

Option 4 — `agent/extensions/auto-router/ephemeral-set-model.ts`, used by both
call sites (`route.ts` routed pick, `index.ts` lock application).

Why it is sound: pi's extension loader maps `@earendil-works/pi-coding-agent`
to the **bundled live module** (virtualModules in Bun-binary mode, jiti
aliases in dev — `core/extensions/loader.ts`), so the prototype the extension
patches is the same object pi's own `AgentSession` dispatches through.
Verified empirically against the pinned npm package and the fork source at
`v0.80.6-psmfd.1`.

### Accepted trade-offs

- **Microtask window:** a manual `/model` landing inside the router's await
  has its persistence suppressed once (the session model still applies; only
  the settings.json write is skipped that one time). Microtask-scale,
  accepted.
- **Fail-open drift posture:** if the import or the method shape drifts at a
  future runtime/extension-deps bump, the helper falls open to plain
  `pi.setModel()` — behavior then equals the pre-fix state (clobbering
  returns), never anything worse. A drift-alarm test imports the REAL pinned
  package and asserts the method exists, so the bump fails tests instead of
  silently reverting.

### Retirement trigger

When upstream ships the persist opt-out (earendil-works/pi#5263) and the
runtime pin advances past it: switch the two call sites to the first-class
option, delete `ephemeral-set-model.ts` and its tests, and mark this ADR
superseded. Tracked as a pi_config follow-up issue filed with this ADR.
