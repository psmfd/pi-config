# Outbound distribution-mirror sync

Operational runbook for pushing curated subsets of the private `psmfd/pi_config`
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
| `psmfd/pi-config` | replace | curated config surface (agent/, setup.sh, install.sh, adrs/, docs/, scripts/, hooks/, …) minus the five extension dirs and all dev-internal surfaces |
| `psmfd/pi-secrets-guard` … `pi-cache-meter` | overlay | the matching `agent/extensions/<name>/` source (packaging overlay in the mirror is preserved) |

Safety properties (see ADR-0050 for the full rationale):

- **Tracked-only staging** — only `git ls-files` content is shipped, so
  gitignored runtime data / secrets cannot leak by construction.
- **Sanitize then fail-closed verify** — `mirror/sanitize/*.sed` rewrites example
  strings (the EMU/enterprise login examples → placeholders); a denylist grep
  then aborts the target if anything survived. Only the staged copy is touched.
- **Secret-scan backstop** — `scripts/scan-secrets.sh` over the staged tree;
  best-effort in dry-run, mandatory before any push.

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

- **`verify` job** — on every PR touching a published source surface, runs
  `--all --dry-run`; a surviving denylisted string fails the job. It is
  **advisory** until registered as a required status check on `dev`
  (branch-protection follow-up [#398](https://github.com/psmfd/pi_config/issues/398)).
  The authoritative fail-closed gate is the
  `sync` job's own pre-push verify, which aborts the push on any leak.
- **`sync` job** — on push to `main` (a dev→main release promotion) and on manual
  `workflow_dispatch`, runs `--all --changed --push`. `--changed` skips a target
  whose `sources` are unchanged since the SHA in its `.mirror-provenance`, so an
  update fans out only to the affected mirrors. Dispatch accepts a single
  `target` input to sync just one.

## One-time setup: the `MIRROR_SYNC_TOKEN` secret

The `sync` job needs a token that can write content **and workflow files** to
the `psmfd/pi-*` mirrors.

1. Create a fine-grained PAT (or install a GitHub App) scoped to **exactly** the
   six mirror repos (`psmfd/pi-config` + the five `psmfd/pi-<extension>` repos),
   with these repository permissions:
   - **Contents: Read and write** — pushes the staged branch content.
   - **Workflows: Read and write** — required because the `pi-config` mirror
     ships `.github/workflows/*.yml`; without it GitHub refuses the push with
     *"refusing to allow a Personal Access Token to create or update workflow …
     without `workflow` scope"*. A fine-grained PAT applies permissions
     uniformly to all selected repos, so this is granted across all six (the
     other five carry no workflow files and are unaffected).
   - **Metadata: Read-only** — auto-included; required for repo access.

   Because the resource owner is the `psmfd` org and you are the org owner, the
   token is auto-approved (no pending-approval gate). Set a finite expiration
   (90 days recommended) — never a no-expiry token that can write to public repos.
2. Add it as an Actions secret named `MIRROR_SYNC_TOKEN` on `psmfd/pi_config`
   (`gh secret set MIRROR_SYNC_TOKEN --repo psmfd/pi_config`, or
   `Settings → Secrets and variables → Actions`). It is a **repo** secret, not an
   org secret — the narrowest scope that works.
3. The workflow rewrites `https://github.com/` to use the token only inside the
   `sync` job. It fails closed if the secret is absent.

## Adding a new mirror target

1. Create the public mirror repo (and, for extensions, its packaging overlay per
   [ADR-0042](../adrs/0042-standalone-extension-distribution.md)).
2. Add a `targets:` entry to `mirror/targets.yml` (`repo`, `mode`,
   `strip_prefix` for extensions, `sources`, `exclude`, `sanitize`).
3. Grant `MIRROR_SYNC_TOKEN` write access to the new repo.
4. Verify with `scripts/sync-mirror.sh --target <name> --dry-run`, then let the
   next push to `main` sync it (or dispatch it manually).

## Code-scanning follow-up (ADR-0052)

The public mirrors run GitHub CodeQL **default setup** (free for public repos);
the private source has no scanning (it would need paid GHAS). So findings surface
on the *derived* mirror but must be fixed in the *source* — patching a mirror is
overwritten by the next sync. Keep mirrors on **default setup**: advanced setup's
committed `.github/workflows/codeql.yml` would be erased by the `replace`-mode
`rsync --delete`. Full rationale in
[ADR-0052](../adrs/0052-mirror-code-scanning-followup.md).

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

Run it as a preflight in the promotion runbook: an open **HIGH/CRITICAL** mapping
to a source file blocks the release (fix-at-source then re-sync, or dismiss with
rationale). MEDIUM requires *triage recorded*, not necessarily a fix. The gate is
runbook-manual today; wiring it in as a required status check is a tracked
follow-up.

## Limitations

- A target's mirror repo must already exist — a missing mirror fails its clone
  loudly rather than being created automatically.
- `overlay` mode has no `--delete`: a source file removed upstream must be pruned
  from the extension mirror by hand. The `replace`-mode config mirror is exact.
