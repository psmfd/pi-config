---
status: Accepted
date: 2026-06-26
---

# ADR-0064: automate mirror→installation onboarding via an enterprise installer App

**Status:** Accepted
**Date:** 2026-06-26
**Tracking issue:** #440
**Amends:** [ADR-0061](0061-mirror-sync-github-app-auth.md) (mirror-sync App auth — the selected-repos decision stands; this adds how repos join the selection)
**Related:** [ADR-0050](0050-outbound-distribution-mirror-sync.md), #400

## Context and Problem Statement

ADR-0061 keeps the `psmfd-mirror-sync` App installed on **"only select
repositories"** (least privilege) and mints per-job tokens scoped to an explicit
`repositories:` list. The consequence: every new mirror repo must be **added to
the installation's selected-repos** before CI can sync it. That add was a manual
org-owner UI action, recurring for every extraction under #400 and every future
extension.

Three options were evaluated (three-agent review):

1. **Install on "All repositories."** Rejected. Installation scope is independent
   of the per-job token-mint list: a leaked `APP_PRIVATE_KEY` lets an attacker mint
   tokens directly against the installation ceiling, bypassing the workflow. "All
   repos" therefore widens the key's blast radius from the mirror set to the whole
   org — defeating ADR-0061's deliberate least-privilege posture.
2. **Org-admin classic PAT in CI** calling `PUT /user/installations/.../repositories/{id}`.
   Rejected. That endpoint accepts only a classic PAT owned by an org owner; storing
   it is a standing credential with `repo` scope — broader than the Contents:write
   App key it would support (privilege inversion), reintroducing the PAT class
   ADR-0061 retired.
3. **GitHub Enterprise organization-installation automation API** (GA July 2025).
   Chosen.

## Decision Outcome

**Chosen: option 3.** A dedicated **enterprise "installer" GitHub App** owns the
add operation.

- **Installer App:** created at the `psmfd` enterprise, with the single permission
  **"Enterprise organization installation repositories: read/write"** — it can
  change which repos an installation covers and **nothing else** (no Contents, no
  code read/write). Installed on the `psmfd` enterprise, granted the `psmfd` org.
- **Token minting:** `actions/create-github-app-token` does not support
  enterprise-installed apps (upstream #303), so `scripts/add-mirror-to-installation.sh`
  mints the token directly: an RS256 JWT signed with the installer key (fed to
  `openssl` via a process-substitution fd, never written to disk) is exchanged at
  `POST /app/installations/{id}/access_tokens` for a short-lived `ghs_` token.
- **The add call:**
  `PATCH /enterprises/psmfd/apps/organizations/psmfd/installations/142753672/repositories/add`
  with `{"repositories":["pi-<name>"]}` (bare names, ≤50 per call).
- **Trigger:** invoked as a step of the maintainer-driven mirror-extraction flow,
  not an always-on webhook — mirror creation is deliberate and infrequent.
- **Secrets:** `INSTALLER_APP_CLIENT_ID` (variable) + `INSTALLER_APP_PRIVATE_KEY`
  (secret) behind a deployment environment, mirroring ADR-0061's key handling.

### Consequences

- Good: the manual UI step is eliminated **without** a classic PAT and **without**
  widening the mirror-sync App's installation scope. The automation credential is
  strictly narrower than every alternative — it cannot touch repo contents.
- Good: the installer key is a *separate* credential from the mirror-sync key, so
  the two capabilities (manage-membership vs. write-contents) are not combined in
  one secret.
- Bad (accepted, bounded): a leaked installer key could add an **arbitrary** repo
  to the mirror-sync installation. That only becomes a content-write if the
  *mirror-sync* key is **also** compromised — both keys are required to weaponize,
  and both sit behind the environment gate. The add API is also audit-logged.
- Bad: a hand-rolled JWT→token mint (vs. the maintained action) is more code; it is
  covered by `--self-test` (signature verification, network-free) wired into
  `validate.sh`, and the live path fails closed on any mint/API error.
