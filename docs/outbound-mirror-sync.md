# Outbound distribution-mirror sync

Operational runbook for pushing curated subsets of the private `psmfd/pi-config`
monorepo out to its public distribution mirrors. Decision record:
[ADR-0050](../adrs/0050-outbound-distribution-mirror-sync.md).

> This is the **outbound** sync (push-out). The **inbound** psmfd/pi mirror sync
> — pulling upstream pi releases *in* — is a separate system documented in
> [`docs/psmfd-pi-mirror-sync.md`](psmfd-pi-mirror-sync.md)
> (ADR-0039/ADR-0045). They share only the word "sync".

## What it does

One engine ([`scripts/sync-mirror.sh`](../scripts/sync-mirror.sh)) driven by a
manifest ([`mirror/targets.yml`](../mirror/targets.yml)) keeps each public
mirror in sync:

| Mirror | Mode | Source |
|---|---|---|
| `psmfd/pi-config` | replace | curated config surface (agent/, setup.sh, install.sh, install-expertise.sh, adrs/, docs/, scripts/, hooks/, …) minus the twelve extension dirs and all dev-internal surfaces |
| `psmfd/pi-secrets-guard` … `pi-auto-router` | overlay | the matching `agent/extensions/<name>/` source (packaging overlay in the mirror is preserved; `pi-bash-destructive-guard`, `pi-expertise-client`, `pi-indexing`, `pi-context-manager`, `pi-auto-router` also inline their `shared/` closure per ADR-0065 — `pi-expertise-client` inlines `secret-scan` per ADR-0088) |

Safety properties (see ADR-0050 for the full rationale):

- **Tracked-only staging** — only `git ls-files` content is shipped, so
  gitignored runtime data / secrets cannot leak by construction.
- **Sanitize then fail-closed verify** — `mirror/sanitize/*.sed` rewrites example
  strings (the EMU/enterprise login examples → placeholders); a denylist grep
  then aborts the target if anything survived. Only the staged copy is touched.
- **README portability for extension mirrors** ([ADR-0062](../adrs/0062-mirror-readme-portability.md)) —
  an extension's `README.md` ships verbatim into a standalone public repo where
  monorepo-relative links (`](../../../adrs/…)`, `.review/`, sibling extensions)
  404 and private-repo refs (`psmfd/pi-config`, `psmfd/pi-config`) leak.
  Each extension target carries a per-extension `mirror/sanitize/<target>.sed` that
  rewrites ADR/rule/hook links to `psmfd/pi-config` blob URLs, de-links private
  issue/PR URLs to plain `#NNN`, and rewrites cross-extension links to the sibling
  mirror; an extension whose README is dominated by monorepo-infra cross-links uses
  a curated `readme_substitute` instead (e.g. `pi-artifact-handoff`). A fail-closed
  **`verify_portable`** gate then runs over every **overlay** staged tree and
  **hard-fails** the sync if any `](../` link or `(TheSemicolon|psmfd)/pi_config`
  slug survives.
- **Private-slug enforcement for the config mirror** ([ADR-0063](../adrs/0063-config-mirror-portability.md)) —
  the config mirror ships the ADR/doc/rule corpus, which references the private
  source repo (`psmfd/pi-config`, formerly `psmfd/pi-config`) ~1,700 times.
  `mirror/sanitize/pi-config.sed` de-links private issue/PR URLs to their link text
  and rewrites any surviving private slug to `psmfd/pi-config`; it does **not** touch
  relative links (which resolve on the config mirror, since it ships `adrs/`). The
  private slug is now in the global `DENYLIST_REGEX`, so `verify_clean` fail-closes
  on it for **every** target — extensions and config alike.
- **Secret-scan backstop** — `scripts/scan-secrets.sh` over the staged tree;
  best-effort in dry-run, mandatory before any push.
- **Curated README** (ADR-0059) — the `pi-config` target declares
  `readme_substitute: mirror/readme/pi-config.md`; `stage_target` swaps that
  public-facing README in for this monorepo's dev `README.md` (the substitute
  source lives under the excluded `mirror/` tree, so it never ships as itself).
  The substituted README still passes the sanitize/verify/secret-scan gates.

## Running it locally

```sh
scripts/sync-mirror.sh --list                          # show configured targets
scripts/sync-mirror.sh --target pi-config --dry-run    # stage+sanitize+verify, no push
scripts/sync-mirror.sh --all --dry-run                 # dry-run every target
```

Dry-run is the default and never pushes. Use `--workdir DIR` to keep the staged
tree for inspection.

## Triggered sync (CI)

[`.github/workflows/sync-mirrors.yml`](../.github/workflows/sync-mirrors.yml):

- **`verify` job** — on every PR to `dev`/`main`, runs `--all --dry-run`; a
  surviving denylisted string fails the job. It is a **required status check** on
  `dev` ([ADR-0056](../adrs/0056-branch-protection-model.md), closing
  #398). It triggers on every
  protected-branch PR (scoped by `branches:`, not `paths:`) so the required check
  never stalls in a perpetual "expected" state. The `sync` job's own pre-push
  verify remains the authoritative fail-closed gate.
- **`sync` job** — on push to `main` (a dev→main release promotion) and on manual
  `workflow_dispatch`, runs `--all --changed --push`. `--changed` skips a target
  whose `sources` are unchanged since the SHA in its `.mirror-provenance`, so an
  update fans out only to the affected mirrors. Dispatch accepts a single
  `target` input to sync just one.

## One-time setup: the mirror-sync GitHub App ([ADR-0061](../adrs/0061-mirror-sync-github-app-auth.md))

The `sync` job authenticates to the `psmfd/pi-*` mirrors with a **short-lived,
org-owned GitHub App installation token** minted per job (it replaced the
long-lived `MIRROR_SYNC_TOKEN` PAT). One-time setup:

1. **Create the App** at `https://github.com/organizations/psmfd/settings/apps`
   → **New GitHub App**:
   - Name e.g. `psmfd-mirror-sync`; Homepage `https://github.com/psmfd`.
   - **Webhook: uncheck Active** (no webhook needed).
   - **Repository permissions → Contents: Read and write** (and the auto-included
     **Metadata: Read-only**). Do **not** grant Workflows — the sync never pushes
     `.github/workflows/` files (the config mirror ships none per
     [ADR-0054](../adrs/0054-no-source-ci-on-distribution-mirror.md); the overlay
     extension mirrors own their `ci.yml`, which Dependabot maintains on the
     mirror and the sync never touches). If a push is ever rejected for a workflow
     permission, add Workflows:write to the App.
   - **Where can this be installed: Only on this account.** → **Create**.
2. **Generate a private key** (App General settings → Private keys → *Generate*)
   — downloads a `.pem`. Note the **Client ID** (`Iv23.…`) in the About section.
3. **Install** the App (left sidebar → *Install App* → `psmfd` → **Only select
   repositories**) on exactly the thirteen mirrors: `pi-config`, `pi-secrets-guard`,
   `pi-bash-destructive-guard`, `pi-artifact-handoff`, `pi-web-fetch`,
   `pi-cache-meter`, `pi-token-meter`, `pi-gh-identity-guard`, `pi-compaction-optimizer`,
   `pi-expertise-client`, `pi-indexing`, `pi-context-manager`, `pi-auto-router`.
4. **Create the `mirror-production` environment** on `psmfd/pi-config`
   (`Settings → Environments → New environment`) and add to it:
   - Variable **`APP_CLIENT_ID`** = the `Iv23.…` Client ID (non-secret).
   - Secret **`APP_PRIVATE_KEY`** = the full `.pem` contents (`-----BEGIN…`).

   The `sync` job declares `environment: mirror-production`, so only that job can
   read the key. The workflow's mint step scopes the token to exactly the thirteen
   repos via an explicit `repositories:` list — with `owner:` alone it would reach
   every repo the App is installed on (the least-privilege footgun, ADR-0061).
   The token lives one hour and is auto-revoked at job end; the mint step fails
   closed if either secret is absent.

## Adding a new mirror target

1. Create the public mirror repo (and, for extensions, its packaging overlay per
   [ADR-0042](../adrs/0042-standalone-extension-distribution.md)).
2. Add a `targets:` entry to `mirror/targets.yml` (`repo`, `mode`,
   `strip_prefix` for extensions, `sources`, `exclude`, `sanitize`).
   For an **extension** target, author a `mirror/sanitize/<target>.sed` (or a
   curated `readme_substitute`) so the README is portable — the `verify_portable`
   gate hard-fails the dry-run until every `](../` link and private-repo slug is
   handled ([ADR-0062](../adrs/0062-mirror-readme-portability.md)).
3. Add the repo to the mirror-sync App installation **and** the workflow's
   `repositories:` list in `sync-mirrors.yml`. The installation add is automated
   ([ADR-0064](../adrs/0064-installer-app-installation-automation.md)) — no manual
   org-UI step:

   ```bash
   INSTALLER_APP_CLIENT_ID=Iv23... \
   INSTALLER_APP_PRIVATE_KEY="$(cat installer.pem)" \
     scripts/add-mirror-to-installation.sh pi-<name>
   ```

   (The installer App is enterprise-owned with only
   `Enterprise organization installation repositories: read/write` — it cannot read
   or write any repo's contents.)
4. Verify with `scripts/sync-mirror.sh --target <name> --dry-run`, then let the
   next push to `main` sync it (or dispatch it manually).

> **Enforced (ADR-0074, #512).** Steps 2–3 are a lockstep: a `pi-*` extension
> target must appear in `mirror/targets.yml`, the `sync-mirrors.yml`
> `repositories:` list, **and** `install.sh` `EXT_MIRRORS`. A `validate.sh`
> gate fails any PR where the three sets disagree, and a `sync-mirror.sh`
> onboarding preflight fails the real `--push` sync (with these steps) when a
> target's repo is not reachable — and warns in dry-run (the `verify` PR job
> passes a read-only `GH_TOKEN` so the probe is determinate, and a missing repo
> surfaces as a PR annotation) — so a half-onboarded target can no longer
> *silently* skip a release the way `pi-token-meter` did in v1.10.0.

## Inlining `shared/` for coupled extension mirrors ([ADR-0065](../adrs/0065-inline-shared-modules-for-coupled-extension-mirrors.md))

Three extensions — `auto-router`, `context-manager`, `indexing` — import the
in-repo [`agent/extensions/shared/`](../agent/extensions/shared) library by
relative path (`../shared/<mod>.ts`). `shared/` is deliberately **not published**
([ADR-0030](../adrs/0030-shared-foundation.md)), so each mirror carries an
**inlined copy** of just the modules it needs, produced at sync time.

A coupled target declares its **direct** `../shared/` imports in the manifest's
`inline:` field — the engine does the rest:

```yaml
  - name: pi-indexing
    repo: psmfd/pi-indexing
    mode: overlay
    strip_prefix: agent/extensions/indexing
    sources: [agent/extensions/indexing]
    sanitize: [pi-indexing]
    inline: [state]            # direct imports only; closure is resolved for you
```

At sync time `inline_stage` (between staging and sanitize):

1. **Resolves the transitive closure** of the seeds by following intra-`shared/`
   `./<mod>.ts` imports — e.g. `auto-router`'s `inline: [candidates, signals,
   notify, state]` pulls in `cost.ts` because `candidates.ts` imports it.
2. **Stages the closure tracked-only** under a `shared/` subdir of the mirror.
3. **Rewrites the import specifiers** to the right relative prefix per file depth:
   root files `../shared/` → `./shared/`, `test/` files `../../shared/` →
   `../shared/`.
4. **Fail-closed verify** — every `shared/` import must carry the expected prefix
   and resolve to an inlined module; an incomplete `inline:` list or a missed
   rewrite aborts the sync (a clean dry-run means the inline is complete).

Because the inlined modules are not under the target's `sources`, the engine also
folds the resolved closure into `--changed` detection, so an edit to canonical
`shared/` re-syncs the coupled mirrors. `auto-router` additionally value-imports
`@earendil-works/pi-ai` at runtime, so its overlay `package.json` declares that
package as a real `dependencies` entry (not a peerDependency).

Leaf extensions keep `inline: []` and are unaffected.

## Releases (ADR-0055)

Each mirror gets an **annotated tag + GitHub Release**, created idempotently by
`sync-mirror.sh --release`. The version source differs by mirror type:

- **Config mirror** (`pi-config`, `replace`) tracks the **source** version. Since
  [ADR-0066](../adrs/0066-ci-release-automation.md) this is cut by **CI**: on the
  dev→main promotion merge, `.github/workflows/release.yml` (triggered by
  `workflow_run` after the `sync` job completes) derives `vX.Y.Z` via
  `release.sh --print-version`, tags + releases the source, then runs
  `sync-mirror.sh --target pi-config --push --release --release-version $VERSION`
  to cut the matching mirror Release (no `--changed`: the content is already
  pushed by the `sync` job so the push self-skips, but `--changed` would skip the
  whole target including the release). The local `scripts/release.sh --tag-only`
  fallback does the same if CI cannot finish.
- **Extension mirrors** (`pi-<name>`, `overlay`) carry **independent SemVer**. The
  next version is **computed from Conventional-Commits history** over the
  extension's source subtree, not stored on the mirror (ADR-0058, below). The CI
  `sync` job runs `--all --changed --push --release` (with `GH_TOKEN` set to the
  minted GitHub App token, ADR-0061); when an extension's source changes, the engine
  computes the bump, writes it into the mirror `package.json`, and releases it.
- **Install-side pins are per-extension** ([ADR-0075](../adrs/0075-per-extension-install-pins.md)).
  `install.sh` pins each mirror to its own release (`name@vX.Y.Z` in `EXT_MIRRORS`);
  a single shared `EXT_REF` could not represent independently-versioned mirrors
  (#492). `scripts/check-ext-ref-drift.sh --fix` + the weekly `pin-drift-check.yml`
  bump each stale pin to its mirror's latest release via an automated PR.

### Release-time pin consistency (ADR-0098)

The CI `sync` job above cuts the extension-mirror releases on the **post-merge**
push — the same instant `release.yml` cuts the config release — so a naively-cut
release ships `install.sh` pins that are one cycle behind the mirror releases the
same promotion just created (the #704 defect). To close this, `scripts/release.sh`
runs a **pre-promotion Phase 1.5** ([ADR-0098](../adrs/0098-release-time-mirror-pin-sync.md))
*before* opening the promotion PR:

1. **Pre-release the changed extension mirrors from dev** —
   `sync-mirror.sh --all --overlay-only --changed --push --release`. The
   `--overlay-only` filter excludes the replace-mode config mirror from the
   target set entirely — necessary because the content push is unconditional
   (only the config mirror's *release* is gated on `--release-version`, not its
   push), so it must not be resolved at all here. The config mirror is still cut
   post-merge by `release.yml` / Phase 6. Idempotent (`--changed`).
2. **Reconcile pins, fail-closed** — `check-ext-ref-drift.sh`; if pins drift
   behind the just-cut releases, `release.sh` opens a `chore/release-pin-sync-<VERSION>`
   PR to dev (it cannot push to protected dev directly) and **stops**. Merge it,
   `git pull`, and re-run — the re-run finds the mirrors already released and the
   pins clean, and proceeds. The promoted snapshot then carries pins matching the
   mirror releases.

The post-merge `sync` job is unchanged and becomes an idempotent no-op for the
already-released mirrors. `--tag-only` and `--no-mirror-release` skip Phase 1.5.

Properties:

- **Idempotent.** Tag and Release existence are probed independently; an existing
  pair is skipped, and a partial state (tag pushed, Release missing) self-heals on
  re-run. A `replace` target with no `--release-version` is skipped, so an `--all
  --release` run never mis-releases the config mirror.
- **Annotated tags.** The engine creates `git tag -a` (config mirror: `git tag
  -s`, SSH-signed — see Release signing below) + pushes it, then `gh release
  create --verify-tag` — `gh release create` alone would make a lightweight tag.
- **Token scope.** Tag push and Release creation need **Contents: write** only
  (already held; see #412).
- **Dashboard.** `psmfd/pi-ecosystem` auto-discovers each repo's latest release on
  an hourly cron (safety net). On a release, `release.yml` can fire a
  `repository_dispatch` (`release-published`) to refresh it **immediately** —
  enabled by adding pi-ecosystem to the mirror-sync App installation
  (`scripts/add-mirror-to-installation.sh pi-ecosystem`) and setting the repo
  variable `ECO_DASHBOARD_DISPATCH=true`. `gh workflow run dashboard --repo
  psmfd/pi-ecosystem` always refreshes it manually. Private repos
  (`pi_config`, `agent-expertise-api-infra`) render without a version — the
  dashboard's read token cannot see private releases (by design).

### Release signing ([ADR-0087](../adrs/0087-config-mirror-release-signing.md))

The **config-mirror** release tag is **SSH-signed** so consumers can verify
origin authenticity on the `git clone`/`git fetch` path (`update.sh` fail-closed,
`install.sh` best-effort). Extension mirrors stay unsigned — they are consumed via
`pi install`, not verified by the install/update scripts.

- **Signing key.** A dedicated ed25519 key. The **private** key is the
  `mirror-production`-environment-gated secret `RELEASE_SIGNING_SSH_KEY` (isolated
  from the App push token, so a token-only compromise cannot forge a signature).
  `sync-mirror.sh`'s `create_release()` writes it to a temp file and signs the
  config-mirror tag with `git tag -s` (`gpg.format=ssh`). Absent (local
  `release.sh --tag-only` emergency path), it WARNs and cuts an **unsigned** tag
  rather than block the release — so CI is the path that guarantees a signed tag.
- **Public key** is pinned in two lockstepped places (a `validate.sh` gate keeps
  them identical): inline in `install.sh` (standalone), and
  `scripts/lib/release-signers.txt` (used by `update.sh`, which reads it from the
  already-trusted clone — the correct trust anchor is the key you already have,
  not the incoming content).
- **Immutable Releases** is enabled on `psmfd/pi-config`: each release locks its
  tag→commit binding server-side, preventing a force-repoint / same-version
  content-substitution that the numeric anti-downgrade guard cannot catch.
- **One-time setup:** generate the keypair, add the private key to the
  `mirror-production` environment as `RELEASE_SIGNING_SSH_KEY`, publish the public
  key into `install.sh` + `release-signers.txt`, and enable release immutability
  in the mirror's Settings → General → Releases. **Key rotation/revocation**
  (multi-key allowed-signers with validity windows) is tracked in
  #634.

### How an extension version advances (ADR-0058)

The **what/where/how** for a human:

- **What advances it:** a Conventional-Commits-typed change to
  `agent/extensions/<name>/` in `pi_config`. `feat` → MINOR, `fix`/`perf` → PATCH,
  `!`/`BREAKING CHANGE` → MINOR while pre-1.0 (v1.0.0 is a deliberate manual step).
  `chore`/`docs`/`refactor`/`style`/`test`/`ci`/`build` (and no change) → **no
  release**.
- **Where it happens:** `scripts/sync-mirror.sh`, overlay `--release` path
  (`ext_advance_version` → `ext_next_version` → `_classify_bump`/`_bump_version`).
  It anchors at the SHA in the mirror's `.mirror-provenance` (the last sync point),
  classifies commits in `provenance..HEAD` over the subtree, `jq`-writes the new
  version into the mirror's `package.json` before the commit, then tags + releases.
- **How to drive it:** just land your change with the right commit type. On the
  next `dev`→`main` promotion the `sync` job releases it. To preview without
  pushing: `scripts/sync-mirror.sh --target pi-<name> --release --dry-run` prints
  the computed `vCUR -> vNEXT` (or "would be skipped"). To check the bump logic:
  `scripts/sync-mirror.sh --self-test` (also a `validate.sh` gate).

**Worked example:** a PR adds a capability to `agent/extensions/secrets-guard/`
with `feat(secrets-guard): add base64 detection`. The mirror is at `v0.1.0`. On the
next promotion, `--changed` fires (the subtree moved), the engine computes
`v0.1.0 → v0.2.0` (a `feat` → MINOR), writes `0.2.0` into the mirror
`package.json`, and cuts `psmfd/pi-secrets-guard` `v0.2.0`.

> **Commit-discipline rule:** a commit that changes an extension's *observable
> behavior* must be `feat` or `fix`, **not** `chore`. A `chore`-typed change yields
> no release, so e.g. a `web-fetch` allowlist expansion typed `chore(web-fetch):`
> would ship the content but never release — type it `fix` (or `feat`) instead.

## Code-scanning follow-up (ADR-0052)

The public mirrors run GitHub CodeQL **default setup** (free for public repos);
the private source has no scanning (it would need paid GHAS). So findings surface
on the *derived* mirror but must be fixed in the *source* — patching a mirror is
overwritten by the next sync. Keep mirrors on **default setup**: advanced setup's
committed `.github/workflows/codeql.yml` would be erased by the `replace`-mode
`rsync --delete`. Full rationale in
[ADR-0052](../adrs/0052-mirror-code-scanning-followup.md).

CodeQL default-setup is the mirror's **only** CI: no source-repo CI workflow is
synced to the mirror, because a source-of-truth gate cannot pass against the
derived subset (it was permanently red — #411).
See [ADR-0054](../adrs/0054-no-source-ci-on-distribution-mirror.md).

### Source-side scanning: declined, with free gates ([ADR-0060](../adrs/0060-source-scanning-strategy.md))

Scanning the **private source** itself (to catch the pre-promotion / unmirrored
gap) requires paid **GitHub Code Security** — the license gate is enforced at the
SARIF upload endpoint, so a self-hosted CodeQL runner does **not** avoid the cost,
and Checkmarx One adds no shell coverage and a paid tenant. ADR-0060 declines the
purchase at current scale and instead closes the *material* part of the gap — the
surfaces mirror CodeQL structurally cannot reach — with two free, PR-blocking CI
gates: a **shellcheck** pass over `scripts/`/`hooks/`
(#425; shell is outside CodeQL's
JS/TS analysis) and **`eslint-plugin-security`** over the extension TypeScript
(#426) — now defense-in-depth
over all extensions (every suite extension is mirrored + CodeQL-scanned), and the
sole source-side scanner for the vendored `subagent` and the `shared/` library,
which have no mirror. A 30-day
enterprise Code Security trial is recorded as an available future measure if the
source's risk profile changes.

### Gotcha: orphaned `actions` CodeQL language on a workflow-less mirror

CodeQL default setup **auto-detects and scans every supported language**,
including `actions` (GitHub Actions workflows) when `.github/workflows/` is
present. The `replace`-mode config mirror (`pi-config`) ships **no** workflows
(ADR-0054), so after the first sync that removed them the `Analyze (actions)`
job has nothing to scan and fails on every push with
`CodeQL detected code written in GitHub Actions but could not process any of it`
(no-source-code-seen, exit 32) — a red check on the public repo (#418).
The five extension mirrors keep their own `ci.yml` overlay (ADR-0042), so their
`actions` scan has code and is unaffected.

**Fix — re-detect, do not edit in place.** An in-place
`PATCH /repos/OWNER/REPO/code-scanning/default-setup` with a reduced `languages`
array is a **no-op** (202 Accepted, but GitHub keeps the auto-detected set;
`updated_at` does not advance). Toggle default setup **off then on** to force a
fresh detection that finds no workflows and so excludes `actions`:

```bash
# 1. disable default setup
printf '{"state":"not-configured"}' | gh api repos/psmfd/pi-config/code-scanning/default-setup \
  -X PATCH -H 'Content-Type: application/json' --input -
# 2. re-enable — fresh detection on the workflow-less tree excludes `actions`
printf '{"state":"configured","query_suite":"default","languages":["javascript-typescript"]}' | \
  gh api repos/psmfd/pi-config/code-scanning/default-setup -X PATCH -H 'Content-Type: application/json' --input -
```

Verify the next CodeQL run has only `Analyze (javascript-typescript)` and no
`Analyze (actions)` job. This only needs doing once per mirror that has all its
workflows removed; it will not recur unless workflows are re-added (they are not,
per ADR-0054). Advanced setup is **not** an option here — its committed
`codeql.yml` would be erased by the `replace`-mode `rsync --delete` (ADR-0052).

### Per-push follow-up checklist

After a sync that changed a mirror, for each open alert on that mirror:

1. **Locate the source.** Map the alert's `path:line` to the `pi_config` file
   (the mirror path mirrors the source path). If the file is not in any target's
   `sources`, it is mirror-only and can only be triaged on the mirror.
2. **Decide: fix or dismiss.**
   - **Fix at source** — correct it in `pi_config` (branch → `dev` → promote);
     the next sync re-pushes and CodeQL re-runs; confirm the alert flips to
     *Fixed* in the mirror's Security tab. The fix commit is the record.
   - **Dismiss** (false positive / won't fix) — dismiss on the mirror and record
     the rationale in [`security/scanning-decisions.md`](../security/scanning-decisions.md).
     Dismissals are server-side and survive re-syncs while the location is stable.

```sh
# Dismiss one alert (false positive) on a mirror:
gh api --method PATCH repos/psmfd/pi-config/code-scanning/alerts/<N> \
  -f state=dismissed -f dismissed_reason="false positive" \
  -f dismissed_comment="see security/scanning-decisions.md"

# Bulk-dismiss every open alert of one rule across a mirror:
gh api "repos/psmfd/pi-config/code-scanning/alerts?state=open&per_page=100" \
  --paginate --slurp --jq '.[][] | select(.rule.id=="<rule>") | .number' \
| while read -r n; do
    gh api --method PATCH "repos/psmfd/pi-config/code-scanning/alerts/$n" \
      -f state=dismissed -f dismissed_reason="false positive" \
      -f dismissed_comment="see security/scanning-decisions.md"
  done
```

### Release gate (before a dev→main promotion)

```sh
scripts/check-mirror-alerts.sh               # fails on any open HIGH/CRITICAL
scripts/check-mirror-alerts.sh --verbose
scripts/check-mirror-alerts.sh --threshold medium   # stricter pre-release sweep
```

An open **HIGH/CRITICAL** mapping to a source file blocks the release
(fix-at-source then re-sync, or dismiss with rationale). MEDIUM requires *triage
recorded*, not necessarily a fix.

The gate is **enforced automatically** by `scripts/release.sh`: its Phase 0
preflight runs `check-mirror-alerts.sh` and aborts the promotion (fail-closed) on
any open HIGH/CRITICAL alert — or if the gate cannot run (e.g. a `gh`
`security_events` access error). Use `release.sh --skip-mirror-alerts` to override
for a known-accepted state. Running the commands above by hand is still a useful
ad-hoc sweep (e.g. `--threshold medium`). See
[ADR-0057](../adrs/0057-enforce-mirror-alerts-gate-in-release.md)
(enforcement) and [ADR-0052](../adrs/0052-mirror-code-scanning-followup.md) (the gate).

Since [ADR-0066](../adrs/0066-ci-release-automation.md), `release.sh` **opens the
promotion PR and exits** — the tag + Release are cut by `release.yml` on the merge,
not by a local poller. The gate stays in `release.sh` Phase 0, so it still runs
locally before the PR is opened (it cannot run in CI — the workflow tokens lack
`security_events` on the mirror repos). Enforcing it as a required CI check on the
PR is deferred to #473; until then,
**always open the promotion PR via `release.sh`** so the gate is not skipped.

## Limitations

- A target's mirror repo must already exist — a missing mirror fails its clone
  loudly rather than being created automatically.
- `overlay` mode has no `--delete`: a source file removed upstream must be pruned
  from the extension mirror by hand. The `replace`-mode config mirror is exact.
