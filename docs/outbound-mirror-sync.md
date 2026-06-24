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

The `sync` job needs a token with **content-write** to the `psmfd/pi-*` mirrors.

1. Create a fine-grained PAT (or install a GitHub App) scoped to the
   `psmfd/pi-config` and `psmfd/pi-<extension>` repositories, with
   **Contents: Read and write**.
2. Add it as an Actions secret named `MIRROR_SYNC_TOKEN` on `psmfd/pi_config`
   (`Settings → Secrets and variables → Actions`).
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

## Limitations

- A target's mirror repo must already exist — a missing mirror fails its clone
  loudly rather than being created automatically.
- `overlay` mode has no `--delete`: a source file removed upstream must be pruned
  from the extension mirror by hand. The `replace`-mode config mirror is exact.
