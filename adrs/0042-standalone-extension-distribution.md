---
status: Accepted
date: 2026-06-12
---

# ADR-0042: distribute first-party extensions via standalone public mirror repos

**Status:** Accepted
**Date:** 2026-06-12
**Tracking issue:** #376
**Related:** [ADR-0009](0009-pi-runtime-acquisition-strategy.md) (pin-and-fetch posture), [ADR-0021](0021-extension-type-checking-and-linting.md) (extension toolchain — unchanged in-repo), [ADR-0030](0030-shared-foundation.md) (in-repo `shared/` library — unchanged in-repo; distribution form addressed here), [ADR-0040](0040-consume-psmfd-attested-pi-releases.md) (psmfd release surface)

## Context and Problem Statement

The first-party extensions under `agent/extensions/` (secrets-guard,
bash-destructive-guard, artifact-handoff, web-fetch, cache-meter,
auto-router, context-manager, indexing) are installed only as a side effect
of the whole-repo `~/.pi → pi_config` symlink created by `setup.sh`. There
is no way for someone else to adopt a single extension without adopting all
of pi_config — its rules, hooks, settings, and trust decisions.

The goal is casual distribution to friends: one command to install one
extension. Distribution via the pi.dev package gallery is explicitly not
wanted, and npm publishing is unnecessary overhead. pi has first-class
support for exactly this shape: `pi install git:github.com/<owner>/<repo>@<ref>`
clones the repo, runs `npm install --omit=dev` when a `package.json` is
present, registers it in `settings.json`, and loads it next session
(`docs/packages.md` in the pinned pi build). Extensions are jiti-loaded
TypeScript — no build step — and pi bundles its own SDK packages
(`@earendil-works/*`, `typebox`), so a distributed extension needs them only
as `peerDependencies`.

Three couplings constrain extraction: (1) `auto-router`, `context-manager`,
and `indexing` import `../shared/` by relative path (ADR-0030 deliberately
kept `shared/` unpublished); (2) the typecheck/lint/test toolchain is
monorepo-rooted (ADR-0021: root `eslint.config.js`, cached deps, per-extension
test runner scripts); (3) `web-fetch/index.ts` hardcodes a `USER_AGENT` URL
pointing at the monorepo.

## Considered Options

1. **Publish to npm / the pi.dev package gallery.** Rejected: gallery
   exposure is explicitly unwanted; npm publishing adds release ceremony
   (scoped package, 2FA, provenance) for an audience of friends who can
   `pi install git:` directly.
2. **Move extensions out to standalone repos and consume them back**
   (pinned `packages:` entries in `settings.json`, or a fetch script in the
   `fetch-pi-binary.sh` mold). Rejected: degrades the daily dev loop from
   edit→reload to edit→push→reinstall, and fragments the ADR-0021 toolchain
   (every repo re-hosts typecheck/lint/test). Revisit if an extension
   stabilizes or gains outside contributors.
3. **Monorepo stays the source of truth; each extension gets a standalone
   public mirror repo under the `psmfd` org.** Chosen.

History sub-decision for the mirror repos: `git filter-repo` /
`git subtree split` history extraction vs **fresh-start with a provenance
note**. Fresh start chosen: squash merges already collapse per-file history
to one commit per PR, the canonical history stays in pi_config, and no extra
tooling is needed. Any single extension can be re-extracted with full
history later without affecting the others.

## Decision Outcome

**Chosen: option 3.** pi_config remains where extensions are developed,
validated, and reviewed; the public repos are distribution mirrors.

- **Naming and ownership:** `psmfd/pi-<extension-name>` (e.g.
  `psmfd/pi-bash-destructive-guard`), consistent with the `psmfd/pi`
  release surface (ADR-0040).
- **Mirror contents:** `index.ts` (+ helper `.ts` files) and `test/`
  verbatim from the monorepo, plus a packaging overlay maintained in the
  mirror: real `package.json` (SDK as `peerDependencies`; `typescript`,
  `tsx`, `@types/node`, and a pinned SDK version as `devDependencies` for
  CI), `tsconfig.json`, README (monorepo README + provenance header +
  Install section), MIT `LICENSE`, and a minimal CI workflow
  (typecheck + `node --test` via tsx).
- **Security baseline:** every mirror enables the full free GitHub
  security suite, matching the other psmfd public repos (`psmfd/pi`):
  Dependabot alerts + security updates, secret scanning with push
  protection — plus the scanners applicable to a TypeScript repo that
  `psmfd/pi` does not need: CodeQL default-setup code scanning
  (JavaScript/TypeScript) and a `.github/dependabot.yml` covering the
  `npm` and `github-actions` ecosystems.
- **Install story:** `pi install git:github.com/psmfd/pi-<name>@<tag>`;
  `pi -e git:...` for try-before-install. Tags are SemVer with a `v`
  prefix, starting at `v0.1.0` (pre-1.0 semantics per the ecosystem-wide
  SemVer tagging rule; graduation to `v1.0.0` is a deliberate decision).
- **Sync model:** manual, release-runbook style — copy changed sources from
  the monorepo, bump the mirror tag, and record the source pi_config commit
  in the mirror README provenance line. CI-automated mirroring
  (subtree-split force-push) is a follow-up under #376, not part of this
  decision. Mirror `main` is a derived artifact: contributions arrive as
  issues/PRs on the mirror but land in pi_config first, then sync out.
- **Extraction order:** leaf extensions first (secrets-guard,
  bash-destructive-guard, artifact-handoff, web-fetch, cache-meter — zero
  `shared/` imports). The `shared/`-coupled three (auto-router,
  context-manager, indexing) are deferred; when extracted, the modules each
  one uses are **inlined** into its mirror at sync time. ADR-0030 is
  unchanged inside the monorepo — the inline copy is purely a distribution
  form, and the monorepo copy of `shared/` remains canonical.
- **Pilot:** `psmfd/pi-bash-destructive-guard` validates the repo shape,
  CI, tagging, and the friend-install path end to end before the remaining
  leaves are extracted.

### Consequences

- Good: friends get a one-command install per extension with no pi_config
  adoption; the dev loop, validate.sh gates, and ADR-0021 toolchain are
  untouched; no marketplace or npm surface is created.
- Good: the trust posture is simple — mirrors distribute source that jiti
  loads as-is; there are no binaries to attest (unlike ADR-0040's runtime).
- Bad: manual sync can drift. Mitigations: the provenance line pins the
  source commit, the mirror CI typechecks against the pinned SDK, and #376
  tracks automation.
- Bad: per-mirror fixes are needed where source references the monorepo —
  `web-fetch`'s hardcoded `USER_AGENT` URL must point at its mirror repo
  when extracted.
- Bad: force-synced mirror `main` cannot accept direct commits; each mirror
  README must say so.
