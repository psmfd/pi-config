# psmfd/pi mirror sync cadence and provenance model

Operational policy for synchronizing the public detached mirror
[`psmfd/pi`](https://github.com/psmfd/pi) with upstream
[`earendil-works/pi`](https://github.com/earendil-works/pi). The governing
decision record is [ADR-0039](../adrs/0039-mirror-sync-cadence-and-provenance.md);
the release trust boundary it feeds is
[ADR-0038](../adrs/0038-psmfd-pi-build-and-attest-trust-boundary.md). The sync
flow is the mirror's single largest inbound trust surface: the zero-divergence
guard intentionally skips overlay-path enforcement for trusted
`sync/upstream-*` PRs, so everything here exists to keep that bypass narrow,
deliberate, and auditable.

## Cadence model

**Upstream-release-driven, with a security fast path.** A sync happens only
when one of two triggers fires:

1. **Planned base upgrade** — PSMFD intends to cut a `vX.Y.Z-psmfd.N` release
   from a newer upstream version.
2. **Security fast path** — a CVE/advisory affects the upstream version range
   the mirror currently carries. Target SLA: sync + release within 72 hours
   for critical severity, 7 days for high.

No other condition triggers a sync. Scheduled "freshness" syncs are rejected:
they create noise PRs, train the maintainer to rubber-stamp a privileged
operation, and batch no value — the mirror only needs new history when a
release wants it. Sync and release are decoupled: a sync may land on `main`
without an immediate release decision.

**Awareness vs sync.** Upstream releases 2–5 times per week, so awareness is
scheduled even though syncing is not: a future `psmfd-sync-notify.yml`
workflow (PSMFD-developed; requires its own overlay PR plus a
`.psmfd/workflow-allowlist.yml` entry) runs daily, compares upstream
HEAD/latest release against the mirror, and opens/updates a single
`upstream-sync` tracking issue. Permissions: default read-only plus
`issues: write` on the notify job only — no PAT, no repo secrets. Until that
workflow exists, GitHub "Watch → Releases only" on the upstream repo is the
interim signal.

## Sync execution model

**Manual, maintainer-run, local.** The sync runs on the maintainer's machine
under their own `gh` identity and is pushed as a `sync/upstream-*` branch. An
in-repo automation path is rejected: pushes from `GITHUB_TOKEN` are attributed
to `github-actions[bot]` and would fail the guard's trusted-actor check, and a
stored PAT is exactly the long-lived repo secret the security baseline
prohibits. The human who reviews the import is the same identity that fetched
and pushed it.

### Tooling

The mechanical and validation steps below are automated by the overlay script
[`.psmfd/sync-upstream.sh`](https://github.com/psmfd/pi/blob/main/.psmfd/sync-upstream.sh)
in the mirror (decision record: [ADR-0045](../adrs/0045-automate-mirror-sync-runbook.md)).
It is a convenience over this runbook, not a replacement for it: it automates
preflight, the namespace-isolated `fetch`, the `--no-ff` `merge`, the mechanical
`resolve` (its path matcher mirrors the guard's `allowed()` exactly), upstream
workflow quarantine, the `validate` gate, and `evidence` generation. It does
**not** automate any divergence-sensitive judgement — security-patch retirement,
allowlist edits, conflict-resolution overrides, the gitleaks gate, and PR review
stay human-gated. The subcommands (`preflight`, `setup`, `fetch`, `preview`,
`merge`, `reconcile`, `resolve`, `validate`, `evidence`, `prune-pollution`) are
ordered so the maintainer's retirement decision lands between `merge` and
`resolve`, where dropping a path from the allowlist flips its resolution to
`--theirs` (take upstream). `reconcile` only *signals* retirement candidates by
diffing each patch's `upstream_base..<target>` upstream refs; per-patch coverage
verification remains mandatory. The script is overlay tooling and must never ride
a `sync/upstream-*` branch — it ships via an ordinary overlay PR.

### One-time remote setup (per clone)

The `upstream` remote is fetch-only and namespace-isolated. Upstream tags land
under `refs/upstream/tags/*`, never `refs/tags/*`, so upstream tags can never
be confused with PSMFD release tags:

```sh
git remote add upstream https://github.com/earendil-works/pi.git
git remote set-url --push upstream DISABLE
git config remote.upstream.fetch '+refs/heads/main:refs/upstream/main'
git config --add remote.upstream.fetch '+refs/tags/*:refs/upstream/tags/*'
git config remote.upstream.tagOpt --no-tags
```

### Allowed refs

Import upstream `main` and upstream release tags only. No upstream feature,
fix, or release branches — they add tracking noise and widen the divergence
surface with no provenance value. Upstream tags are **unsigned source
references**: they are recorded, never re-published as PSMFD refs, and never
vouched for (per `PROVENANCE.md`). PSMFD release tags (`vX.Y.Z-psmfd.N`,
annotated, under `refs/tags/`) are the only tags consumers should trust on the
mirror.

### Sync procedure

```sh
git fetch upstream
git log refs/upstream/main --oneline --not main        # preview the range

git switch main && git pull
git switch -c sync/upstream-<upstream-tag>             # e.g. sync/upstream-v0.80.0
git merge refs/upstream/tags/<upstream-tag> --no-ff \
  -m "sync: incorporate upstream <upstream-tag>"
```

Branch naming: `sync/upstream-<upstream-tag>`; security fast path appends
`-sec`; if syncing an untagged upstream fix, `sync/upstream-<8-char-sha>-sec`
(exception, not the rule). The branch pattern is what activates the guard
bypass — it is a routing discriminator, not authentication; the same-repo and
trusted-actor checks are the actual controls.

Merge mechanics are fixed: **always `--no-ff` merge, never rebase, never
fast-forward.** PSMFD overlay commits sit above the seed; rebasing them would
rewrite their SHAs and break every existing reference. The merge commit is the
audit record of the sync event. The sync PR merges with **"Create a merge
commit"** (not squash) to preserve the upstream history chain.

### Deterministic conflict resolution

For any conflicted path, the resolution is mechanical, never ad-hoc:

- Path in `.psmfd/overlay-allowlist.txt` → `git checkout --ours -- <path>`
  (PSMFD version wins).
- Any other path → `git checkout --theirs -- <path>` (upstream version wins).

### Upstream workflow quarantine on sync

If the imported range adds or modifies files under `.github/workflows/`, those
files must be moved to `.github/workflows-upstream-reference/` as part of the
sync branch (matching the existing quarantine convention) so no upstream
workflow becomes executable. Any such change is called out explicitly in the
PR body and reviewed against `.psmfd/security-baseline.md`.

## Evidence recorded per sync PR

Every sync PR body must contain:

1. **Import range block** — upstream remote URL, old upstream SHA (previous
   sync base or seed `406a2214`), new upstream SHA, upstream tag(s) synced to.
2. **Tag inventory** — every upstream tag newly included in the range
   (name + SHA each).
3. **Surface summary** — `git diff --stat <old>..<new>`, with explicit
   callouts for changes under `.github/workflows/`, build/release scripts, and
   dependency lockfiles.
4. **Overlay conflict log** — each overlay path conflicted and the (always
   `--ours`) resolution, or "No overlay conflicts."
5. **Divergence proof** — confirmation that the non-overlay diff
   `main..sync-branch` equals the upstream diff for the same range (no
   PSMFD-introduced source changes rode along).
6. **Gitleaks result** — `scan-secrets --range OLD..NEW` (gitleaks) over the new
   range, where `OLD` is the pre-merge mirror `main` and `NEW` is the merge HEAD
   (ADR-0048; the repo-agnostic scanner picks up the mirror's own
   `.gitleaks.toml`); scanner version + exit status; any finding triaged
   (commit/path-scoped allowlist, rotation, or false positive) **before
   merge**. Broad regex-only allowlists remain prohibited.
7. **Upstream signature observation** — for each imported tag: signed/unsigned
   as **observed**, never "verified". Standing disclaimer: PSMFD records
   import evidence; it does not vouch for upstream commit content, signing
   hygiene, or dependency safety. Rebuilding under PSMFD workflows bounds the
   build, it does not sanitize upstream source.

## Targeted pre-merge review (solo-maintainer realistic)

Full review of an imported range is not feasible; these targeted checks give
the best risk reduction per minute, in priority order:

1. **Workflow-file delta** — list added/modified `.github/workflows/` files in
   the range; quarantine and review each (highest-leverage injection surface).
2. **Build/release script mutations** — diff changes to top-level build entry
   points (`scripts/build-binaries.sh`, `package.json` scripts, release
   tooling); question asked: does any build step now make a network call or
   shell escape it didn't before? These scripts run inside PSMFD's attested
   release workflow, so a malicious change here would be laundered into a
   valid PSMFD attestation.
3. **Lockfile new-package check** — list newly added packages (not version
   bumps) in any changed lockfile; cross-check each name/namespace against the
   public registry.
4. **Tag-SHA cross-check** — at review time, `gh api
   repos/earendil-works/pi/git/ref/tags/<tag>` must still match the fetched
   SHA; a moved tag pauses the sync for explicit decision.

Residual gaps (documented, accepted): no full semantic review of imported
commits, no cryptographic verification of upstream authorship, no dynamic
analysis. This is the upstream-source-compromise residual risk named in
ADR-0038; the build boundary limits its blast radius and does not remove it.

## Sync-actor trust constraints

- The guard bypass requires all three: `sync/upstream-*` head ref, same-repo
  PR, PR author = the configured trusted sync actor.
- A repository ruleset should restrict creation of `sync/upstream-*` branches
  to the trusted actor and block force pushes to them; force-pushing an open
  sync PR invalidates its evidence. Required before any collaborator is added.
- The bypass skips the overlay-path check **only**. Maintainer review before
  merge, the gitleaks gate, and all other CI remain mandatory. A trusted sync
  PR is never an auto-merge PR.
- The bypass authorizes importing upstream history and nothing else: no
  overlay edits, no guard changes, no new runnable workflows may ride a sync
  branch — those are overlay PRs.

## Sync PR vs overlay PR

Mutually exclusive by construction:

| | Sync PR | Overlay PR |
|---|---|---|
| Branch | `sync/upstream-*` | anything else |
| May touch | upstream-owned paths (+ mechanical overlay conflict resolutions, + workflow quarantine moves) | overlay-allowlist paths only |
| Guard | path check bypassed (trusted actor) | path check enforced |
| Merge method | merge commit | repo default |
| Evidence | full block above | changed-path list; allowlist+guard updated together if the allowlist grows |

Need both in one cycle → two PRs: sync first, overlay branched from post-sync
`main`.

## Never-cross list

**From pi_config (private) into psmfd/pi (public) — never:**

- Personal identity material: emails, home-directory paths, SSH keys (public
  included), `.gitconfig`, anything under `~/.pi/` or `.pi/` runtime state.
- Credentials of any kind, live or rotated (rotated tokens still leak format
  and issuer).
- Unpublished ADR drafts, private notes, references that reveal non-public
  repos or relationships.
- pi_config's own toolchain internals: `agent/vendor/` pins, `scripts/lib/`,
  pi_config's `.gitleaks.toml` (the mirror has its own).

The overlay allowlist is the mechanical gate; this list is the semantic reason
the gate must not be widened casually.

**From psmfd/pi into pi_config — never blindly:**

- Quarantined upstream workflows (require explicit classification first).
- Upstream lockfiles (would substitute pi_config's pinned dependency set).
- The mirror's `PROVENANCE.md`/`.gitleaks.toml` (context-specific; misleading
  elsewhere).

## Related

- [ADR-0039](../adrs/0039-mirror-sync-cadence-and-provenance.md) — decision
  record for this policy
- [ADR-0038](../adrs/0038-psmfd-pi-build-and-attest-trust-boundary.md) —
  build-and-attest trust boundary this policy feeds
- `psmfd/pi` `PROVENANCE.md`, `.psmfd/security-baseline.md`,
  `.psmfd/overlay-allowlist.txt` — the mirror-side contracts
- pi_config#360 — tracking
  issue closed by this doc
