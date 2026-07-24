---
status: Accepted
date: 2026-07-21
---

# ADR-0119: pi version bumps cover the full downstream component surface

**Status:** Accepted
**Date:** 2026-07-21
**Related:** #823 (v0.81.1 bump), #856 (mirror packaging bump pass), [ADR-0092](0092-pi-runtime-bump-automation.md) (the bump-script automation this scopes), [ADR-0040](0040-consume-psmfd-attested-pi-releases.md) (attested consumption), [ADR-0044](0044-security-overrides-for-vulnerable-transitive-deps.md) (lockfile-security override mechanism referenced by the checklist), `docs/vendor-updates.md` § Pi runtime (the checklist this ADR backs)

## Context and Problem Statement

A "pi version bump" was operationally defined as what `scripts/bump-pi-runtime.sh` touches: the vendored binary pin, the `EXTENSION_DEPS_PI_AGENT_VERSION` npm quad, `agent/settings.example.json`, and the subagent snapshot audit. The 2026-07-20 brace-expansion advisory (GHSA-3jxr-9vmj-r5cp, high) exposed that this definition misses real pi-version surfaces:

- **Mirror packaging dependencies** — each of the 12 public extension mirrors commits its own `package.json`/`package-lock.json` with `@earendil-works/*` dev-deps (and in pi-auto-router's case a *runtime* `pi-ai` dep). These lockfiles pinned pi 0.80.2/0.80.3 while pi_config was at 0.80.10, and they were the actual Dependabot alert surface: brace-expansion sits as a nested exact pin under the pi packages, so Dependabot cannot remediate it — only bumping the pi packages themselves moves it.
- **agent-expertise-api** — its `.pi/extensions/expertise-api/package-lock.json` carries the same pi-pinned tree.
- **The psmfd/pi mirror itself** — root lockfile + `install-lock`, real runtime exposure, only movable by an upstream sync.

No tooling or document enumerated these, so the stale layers drifted silently until an advisory lit them up.

## Considered Options

1. **Documented full-surface checklist, tooling unchanged.** Add a canonical component checklist to `docs/vendor-updates.md` § Pi runtime; each bump walks it and classifies every surface (bumped here / tracked issue / deliberately deferred). Chosen.
2. **Extend `bump-pi-runtime.sh` to also open mirror packaging PRs.** Rejected for now: the mirrors are 12 separate repos with their own CI; a scripted cross-repo fan-out is real automation work with real failure modes, and the cadence (a few bumps per month) doesn't yet justify it. Filed as the tracked follow-up path on #856; this ADR does not preclude it.
3. **Status quo (script scope = bump scope).** Rejected — demonstrated failure mode; security advisories land on the undocumented layers.

## Decision Outcome

**Option 1.** The definition of a pi version bump is the full component checklist in `docs/vendor-updates.md` § Pi runtime, not the bump script's file list. The checklist enumerates, per surface: what pins it, what tooling (if any) moves it, and where it lives. A bump PR (or its tracking issue) must account for every row — bumped, tracked as a follow-up issue, or explicitly deferred with a reason. The bump script remains the automation for the pi_config-local rows only.

### Consequences

- Good: advisories that land on any pi-version surface have a documented owner and fix vector; no more silent drift on the mirror packaging layer.
- Good: the checklist gives `pi-runtime-bump.yml` bot PRs a review rubric — the reviewer checks the non-automated rows.
- Neutral: mirror packaging bumps stay manual per-repo work until #856's automation decision.
- Bad: the checklist is prose, not a gate — nothing fails if a row is skipped. Accepted: the alternative (cross-repo enforcement) is disproportionate today.
