---
status: Accepted
date: 2026-06-26
---

# ADR-0061: mirror-sync push auth is a scoped GitHub App installation token, not a PAT

**Status:** Accepted
**Date:** 2026-06-26
**Closes:** #403 (migrate mirror-sync auth PAT → GitHub App), #412 (narrow `MIRROR_SYNC_TOKEN` to Contents-only — subsumed: the App is Contents-only), #402 (scrub `insteadOf` credential — obviated: the token is short-lived + auto-revoked)
**Supersedes (in part):** [ADR-0050](0050-outbound-distribution-mirror-sync.md) — replaces its fine-grained-PAT (`MIRROR_SYNC_TOKEN`) push-auth mechanism. The sync engine, manifest, and modes are unchanged.
**Related:** [ADR-0053](0053-pin-github-actions-to-sha.md) (the SHA-pin policy applied to `create-github-app-token`), [ADR-0054](0054-no-source-ci-on-distribution-mirror.md) (no workflow files ship to mirrors — why Contents-only suffices), [ADR-0055](0055-automated-mirror-releases.md) (the `gh` Release creation that also uses this token).

## Context and Problem Statement

The `sync` job in `.github/workflows/sync-mirrors.yml` pushes generated content
to the six public mirror repos and creates their tags/Releases. Auth was a
fine-grained **PAT** (`MIRROR_SYNC_TOKEN`) with Contents:write + Workflows:write,
fed into a git `insteadOf` rewrite and `GH_TOKEN`. A pre-token security review
flagged a stronger long-term posture (a GitHub App installation token); #403
tracked the migration.

A three-way expert fan-out (gh-cli, security-review, shell) confirmed the design
and surfaced the decisions below. The PAT has three structural weaknesses an App
removes: it is **personal-account-owned** (breaks if the account leaves the org),
**long-lived** (up to a year; ~90-day manual rotation in practice), and a
**directly-usable bearer token** for its whole lifetime.

## Considered Options

1. **Keep the fine-grained PAT.** Rejected: personal-account coupling, manual
   rotation, and a leak window measured in weeks.
2. **GitHub App installation token (chosen).** Org-owned identity; a 1-hour
   token minted per job and auto-revoked at job end; survives personnel change;
   no static bearer credential at rest.
3. **Self-hosted runner with a machine credential.** Rejected: introduces a
   Tier-0 runner to own and harden for no gain over option 2.

## Decision Outcome

**Chosen: option 2.** An org-owned GitHub App (`psmfd`), installed on exactly the
six mirror repos, mints a short-lived installation token at job start via
`actions/create-github-app-token` (SHA-pinned per ADR-0053). The single minted
token feeds both the git `insteadOf` push rewrite and `GH_TOKEN`. The PAT is
retired. Three decisions make this least-privilege and safe:

- **Explicit `repositories:` scope, not `owner:` alone.** With `owner: psmfd` and
  no `repositories:` list, the minted token reaches **every** repo the App is
  installed on. The step enumerates the six mirrors so the token is scoped to
  exactly them — preserving the boundary the PAT had. This is the one mandatory
  constraint; omitting it is the migration's central footgun.
- **Contents:write only — no Workflows:write.** This resolves #412. Post-#411
  prune the config mirror ships no `.github/workflows/` (ADR-0054), and the
  overlay extension mirrors own their `ci.yml` (Dependabot-maintained on the
  mirror, never pushed by the sync), so the sync never creates or updates a
  workflow file. The `workflow_dispatch` validation in the cutover (below)
  confirms this empirically before the PAT is retired, so a wrong call costs a
  re-grant, not a production break.
- **App secrets behind a `mirror-production` environment.** The App private key
  has no automatic rotation, so it is stored as an **environment secret** (with
  `APP_CLIENT_ID` as a non-secret `vars.` variable) and the `sync` job declares
  `environment: mirror-production`. This gates key access to that one job rather
  than to any workflow added to the repo.

### Cutover (zero-downtime, fail-closed)

`create-github-app-token` errors if its secrets are absent, so a premature merge
fails closed (no push) rather than pushing with the wrong identity. The order:

1. Create the App (Contents:write only), install on the six mirrors, generate the
   private key, create the `mirror-production` environment, and add the
   `vars.APP_CLIENT_ID` variable and `secrets.APP_PRIVATE_KEY` secret to it.
2. Merge this change; on `main`, run the sync via **`workflow_dispatch`** to
   validate the App token end-to-end (push + Release) without waiting for a release.
3. Only after a green validation: delete the `MIRROR_SYNC_TOKEN` secret and revoke
   the PAT at the account level. Keep the transition window (both credentials
   live) to a single session.

### Consequences

- Good: leak blast radius drops from ~weeks to ≤1 hour; auth is org-owned and
  survives personnel change; no static push credential at rest; token rotation is
  automatic.
- Good: #412 (Contents-only) and #402 (credential scrub) are resolved/obviated by
  the design rather than carried as separate work.
- Neutral / new risk shape: the App **private key** is a long-lived asymmetric
  secret with no auto-rotation. Compromise allows minting tokens until manual
  revocation — mitigated by the environment-secret gate and the six-repo install
  scope, and detectable/revocable at the App level. This is a different shape than
  a PAT leak, not a worse one.
- Accepted: a token mint adds one step + a ~1s API call per sync run; the 1-hour
  token lifetime is ample for a six-repo push.
