---
status: Accepted
date: 2026-06-14
---

# ADR-0042: Upstream documentation as the security-reporting gate

**Status:** Accepted
**Date:** 2026-06-14
**Tracking label:** `track:pi-mirror` (pi_config)
**Related:** [ADR-0041](0041-conditional-security-patch-divergence.md) (conditional security-patch divergence — this ADR refines its reporting half), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md), [ADR-0039](0039-mirror-sync-cadence-and-provenance.md), upstream [`SECURITY.md`](https://github.com/earendil-works/pi/blob/main/SECURITY.md) and [`CONTRIBUTING.md`](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md)

## Context and Problem Statement

ADR-0041 established that the mirror may carry a temporary security patch when
upstream has no fix, and that the fix is then "submitted upstream with evidence."
That second half assumed every mirror-applied security fix is something upstream
wants reported. The first four patches (psmfd-patch-001 git-ref injection,
002 vitest, 003 shell-quote, 004 esbuild) showed that assumption is wrong:
evaluated against upstream's own published policy, none are reportable.

Upstream `earendil-works/pi` publishes two governing documents:

- **`SECURITY.md`** — a trust model and an explicit out-of-scope list. Pi treats
  "the local user account and files writable by it" as inside Pi's trust
  boundary. Out of scope: installing untrusted packages/extensions, user-
  initiated local actions, "local code execution / sandboxing behavior", and
  dependency reports unless the dependency is "reachable through Pi".
- **`CONTRIBUTING.md`** — a strict, explicitly anti-automation contribution gate:
  new contributors' issues and PRs are auto-closed; approval is a maintainer
  reply (`lgtmi` for issues, `lgtm` to unlock PRs); no PR before `lgtm`; issues
  must be human-authored ("do not use an LLM to generate text"); "you must
  understand your code"; and agent-slung or high-volume automated submissions
  earn a permanent account block.

Reporting therefore is not a mechanical follow-up to fixing. It needs a decided,
repeatable gate so the mirror does not (a) waste maintainer time filing
out-of-scope reports, or (b) risk an account block by submitting agent-driven
contributions, while still surfacing the genuinely reportable findings.

## Decision

Adopt **upstream's published policy documents as the authoritative gate** for
deciding whether and how a mirror-applied security fix is reported upstream.

1. **Fix first, always.** Applying the fix in the mirror (ADR-0041) is
   unconditional and independent of reportability. The mirror's released
   artifacts are protected regardless of upstream's reporting posture.
2. **Determine reporting after, against the gate.** For each patch, evaluate the
   finding against upstream's **current** `SECURITY.md` scope and
   `CONTRIBUTING.md` process (re-read at determination time — these documents
   change). Record the determination in the patch manifest.
3. **Report only when in-scope.** A finding is reported upstream only if it is
   in scope under `SECURITY.md` (a demonstrated security-boundary bypass with
   impact, reachable through Pi — not a local-trust-boundary, user-installed-
   package, dev-only-dependency, or extension-behavior case). In-scope security
   findings use the private channel (`security@earendil.com` / GitHub private
   advisory). A non-security hardening worth offering uses the contribution
   path, not the security channel.
4. **Reporting is human-led.** Because `CONTRIBUTING.md` requires human-authored
   issues, `lgtm` approval before any PR, and bans agent-driven submissions, the
   agent never files upstream issues, PRs, or advisories. The agent may prepare
   materials (a clean fork branch off upstream HEAD, talking points); a human
   authors the issue, obtains approval, and owns the PR.
5. **Record the no-report determination.** When a finding is out of scope, record
   that determination (with the reason) in the manifest entry and proceed. "Not
   reported" is a logged decision, not an omission.

## Determination for the current patches

All four were evaluated against upstream `SECURITY.md` and found **out of scope —
not reported**:

| Patch | Finding | Why out of scope |
|---|---|---|
| psmfd-patch-001 | git-ref flag injection | Triggers when a user installs a git package with a crafted ref → "installing untrusted packages" + "user-initiated local action". Offerable only as optional defense-in-depth hardening via the contribution path, not as a vulnerability. |
| psmfd-patch-002 | vitest CVE-2026-47429 | Dev/test-only dependency; not shipped or reachable through Pi. |
| psmfd-patch-003 | shell-quote CVE-2026-9277 | Transitive dependency of the *sandbox example extension* → extension behavior; not reachable through core Pi. |
| psmfd-patch-004 | esbuild GHSA-gv7w / GHSA-g7r4 | Dev/build-only dependency; not reachable through Pi. |

## Considered Options

1. **Report every mirror security fix upstream.** Rejected: most are out of
   upstream's scope; filing them wastes maintainer time and, done via
   automation, risks a permanent block under `CONTRIBUTING.md`.
2. **Never report; carry patches indefinitely.** Rejected: genuinely in-scope
   findings should reach upstream so the patch can retire and all users benefit.
3. **Gate reporting on upstream's own published policy (chosen).** Uses the
   maintainers' stated scope as the objective test, fixes unconditionally, and
   keeps reporting human-led and high-signal.

## Consequences

- **Positive:** the mirror always protects its artifacts; reporting effort is
  spent only on findings upstream considers in scope; no risk of an account
  block from agent-driven or out-of-scope submissions; every determination is
  auditable in the manifest.
- **Negative / accepted:** out-of-scope patches may be carried longer (retired
  only when upstream independently fixes the underlying issue and the mirror
  syncs). The gate depends on upstream keeping its policy docs current and is
  re-evaluated per finding, not cached.
- **Follow-up:** the patch manifest gains a per-entry reporting determination;
  the mirror `security-baseline.md` documents the operational gate.
