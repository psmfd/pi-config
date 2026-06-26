---
status: Accepted
date: 2026-06-26
---

# ADR-0060: decline paid source-side scanning; close the material gap with free CI gates

**Status:** Accepted
**Date:** 2026-06-26
**Closes:** #407 (evaluate source-side SAST to close the pre-promotion scanning gap)
**Amends:** [ADR-0052](0052-mirror-code-scanning-followup.md) — resolves its "Bad / accepted: the pre-promotion source gap" consequence and its option-1 "documented future option" (GHAS trial / self-hosted runner / scheduled Checkmarx). ADR-0052's core process (mirror CodeQL baseline, fix-at-source loop, dismissal log, promotion severity gate) stands unchanged.
**Related:** [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the sync engine whose `sources`-scoped staging creates part of the gap), [ADR-0053](0053-pin-github-actions-to-sha.md) (the shellcheck vendor pin a free gate would invoke), [ADR-0042](0042-standalone-extension-distribution.md) (the extension distribution; six extensions are unmirrored and thus unscanned).

## Context and Problem Statement

ADR-0052 made free mirror-side CodeQL the baseline scanner and **accepted a
bounded gap**: code on `dev`/feature branches, and source files outside a
target's manifest `sources`, are unscanned until promoted to `main` and synced
to a public mirror. #407 asked whether to close that gap and how — evaluating a
GHAS trial, a self-hosted CodeQL runner, or a scheduled Checkmarx One scan.

A three-way expert fan-out (security-review, gh-cli, checkmarx) established the
facts the evaluation turns on:

- **The gap is partially material, not theoretical.** Six extensions
  (`compaction-optimizer`, `subagent`, `context-manager`, `gh-identity-guard`,
  `auto-router`, `indexing`, `expertise-client`) ship only inside the `pi-config`
  mirror or have no mirror, so mirror-side CodeQL **never** scans them. That set
  includes the highest-trust code in the repo — `agent/extensions/subagent/index.ts`
  `spawn()`s a child `pi` process with an externally-supplied task string — and
  `compaction-optimizer`, which produced pi_config's first real CodeQL HIGH
  finding (ADR-0052, "First application").
- **Source-side code scanning on a private repo requires paid GitHub Code
  Security** (the 2025 repackaging of GHAS code scanning; ~$30/active
  committer/month). This was verified live: `GET repos/psmfd/pi-config/code-scanning/analyses`
  returns `403 — Code Security must be enabled`. The license gate is enforced at
  the SARIF **upload endpoint**, so a **self-hosted CodeQL runner does not avoid
  the cost** — it cannot upload results to a private repo without the license.
  Options "GHAS trial" and "self-hosted runner" therefore collapse into a single
  purchase decision. (The trial is 30 days, enterprise-scoped — not the 60 the
  issue assumed.)
- **Checkmarx One is the wrong tool here.** It does not analyze shell scripts at
  all (the repo's 38 shell files + 2 security-critical hooks are a stated gap);
  for the TypeScript surface it is near-redundant with CodeQL; and it requires an
  enterprise tenant with no free tier. It is only rational if a tenant already
  exists for other work — none does.
- **Two free gaps exist today that close the *material* part of the source gap
  at zero cost.** `shellcheck` is vendored and SHA-pinned (ADR-0053) but
  **`validate.sh` never actually runs it** against the repo's own scripts — it
  only validates the vendor pin. And `eslint-plugin-security` is absent from the
  extension ESLint config, so the unmirrored high-trust TS extensions get no
  security-lens static analysis.

The maintainer has decided **not** to purchase code scanning for this at the
current scale.

## Considered Options

1. **Buy GitHub Code Security for the private source** (~$30/committer/mo, or a
   30-day enterprise trial first). Closes the gap completely with the same query
   suite already running on the mirrors. Rejected now: recurring paid cost for a
   solo-maintained repo whose source is private until promotion, where mirror
   CodeQL + `check-mirror-alerts.sh` already gate it. Retained as a documented
   future measure.
2. **Self-hosted CodeQL runner uploading to the source.** Rejected: the live 403
   proves it does not avoid the Code Security license (the gate is on the upload
   API, not the runner), and it adds a Tier-0 trust boundary (a runner that can
   write to a protected branch) for no cost saving over option 1.
3. **Scheduled Checkmarx One SAST.** Rejected: no shell coverage, near-redundant
   TS, enterprise-tenant-only with no free tier and none in place.
4. **Decline paid scanning; close the material gap with free CI gates.** Chosen.
   Keep mirror CodeQL as the baseline and add two zero-cost defense-in-depth
   gates that cover exactly the surfaces mirror CodeQL structurally cannot: a
   shellcheck CI gate (shell is outside CodeQL on every mirror) and
   `eslint-plugin-security` (the unmirrored TS extensions).

## Decision Outcome

**Chosen: option 4.** No paid source-side scanner is adopted. Mirror-side CodeQL
(ADR-0052) remains the baseline for promoted, mirrored content. The
pre-promotion / unmirrored gap is narrowed — not via purchase — with two free
gates, each tracked as its own follow-up because each carries an unknown
remediation tail:

- **Shellcheck CI gate** (#425) —
  `validate.sh` runs the vendored `shellcheck` over `scripts/**/*.sh` and
  `hooks/*.sh`. This is the highest-value item: shell is the source's largest
  scanner-blind surface (CodeQL is JS/TS-only) and includes the security-critical
  `secrets-guard.sh` / `gh-identity-guard.sh` hooks. It also corrects a latent
  assumption that this gate already existed.
- **`eslint-plugin-security`** (#426) —
  added to the extension ESLint config, giving a security-lens pass over the six
  unmirrored extensions (including the `subagent` process-spawn surface) that
  mirror CodeQL never sees, inside the lint gate that already runs.

A free SARIF-to-Security-tab path does **not** exist for private repos (the same
403 blocks third-party SARIF upload), so these gates are **PR-blocking checks**,
not persistent Security-tab findings. That is the accepted shape.

### Future option (recorded, not adopted)

If the source's risk profile changes (more contributors, a network-exposed
component, or a need for persistent historical findings), start the **30-day
enterprise GitHub Code Security trial** to measure whether source-side CodeQL
surfaces material findings beyond the mirrors before committing to the
per-committer cost. This requires an enterprise-owner action and is out of scope
here.

### Consequences

- Good: zero recurring cost; the two surfaces mirror CodeQL cannot reach (shell,
  unmirrored TS) get real static analysis; the shellcheck gate everyone assumed
  existed becomes real.
- Good: the decision is evidence-based — the buy-vs-decline call rests on a
  verified license gate, not an assumption.
- Neutral: free gates are PR-blocking only; there is no source-side Security tab,
  no historical trend, no Copilot Autofix. Acceptable for a private source whose
  public artifact is the scanned mirror.
- Bad / accepted: the pre-promotion window for **mirrored TS** (the squash-merge
  to `dev` before promotion) remains CodeQL-blind until sync — unchanged from
  ADR-0052, and bounded to not-yet-public content. Only a paid source-side
  scanner closes it; deliberately not bought.
