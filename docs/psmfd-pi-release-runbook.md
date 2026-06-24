# psmfd/pi release runbook

Operator procedure for cutting a PSMFD pi release (`vX.Y.Z-psmfd.N`) from the
public detached mirror [`psmfd/pi`](https://github.com/psmfd/pi). The pipeline
is `psmfd-release.yml` (psmfd/pi#8), governed by
[ADR-0038](../adrs/0038-psmfd-pi-build-and-attest-trust-boundary.md)
(rebuild-and-attest, never re-attest upstream bytes) and fed by
[ADR-0039](../adrs/0039-mirror-sync-cadence-and-provenance.md) /
[`psmfd-pi-mirror-sync.md`](psmfd-pi-mirror-sync.md) (how source gets there).

## Versioning

`vX.Y.Z-psmfd.N` — `X.Y.Z` is the upstream base version of the mirrored
source being built (the lockstep version in `packages/*/package.json` at the
tagged commit); `N` starts at 1 and increments for PSMFD-side rebuilds of the
same base (workflow fix, packaging fix). A new upstream base resets `N` to 1.

## Preconditions

1. Active `gh` account is `TheSemicolon` (`gh api user --jq .login`) — it
   drifts on this host; the identity guards catch mutations but check first.
2. The source to release is on mirror `main` (if a newer upstream base is
   wanted, run the sync procedure in `psmfd-pi-mirror-sync.md` first and let
   the sync PR merge).
3. The CodeQL/code-scanning state on `psmfd/pi` has no untriaged release
   blockers (baseline triage: pi_config#359; only accepted/tracked findings
   may remain).
4. `psmfd-release.yml` is unchanged since its last review, or the change went
   through a reviewed overlay PR (allowlist + baseline updated together).
5. First release only: the SBOM license scan obligation (pi_config#356) is
   satisfied by reviewing the generated CycloneDX SBOM for
   GPL/AGPL/LGPL-family licenses before announcing the release.

## Cut the tag

Tags are cut from mirror `main` only, annotated, and immutable once pushed
(ruleset `protect-psmfd-release-tags` blocks update/deletion).

```sh
cd <mirror checkout> && git switch main && git pull --ff-only
BASE="$(node -p "require('./packages/coding-agent/package.json').version")"
TAG="v${BASE}-psmfd.1"   # bump .N if this base was released before
git tag -a "$TAG" -m "$TAG — PSMFD build of upstream base v${BASE}"
git push origin "$TAG"
```

## Trigger the workflow

```sh
gh workflow run psmfd-release.yml --repo psmfd/pi -f tag="$TAG"
gh run watch --repo psmfd/pi "$(gh run list --repo psmfd/pi \
  --workflow psmfd-release.yml --limit 1 --json databaseId \
  --jq '.[0].databaseId')"
```

The run is fail-closed at every stage: preflight (tag format + main
ancestry), build (hermetic rebuild), attest (checksum gate then keyless OIDC
attestation), publish (draft release → download the draft bytes back →
`sha256sum -c` → `gh attestation verify` per asset → undraft). A failure at
any point publishes nothing; the release, if created, stays draft.

## Verify the published release (operator, fresh environment)

Run OUTSIDE the build context — a clean directory on any machine:

```sh
mkdir /tmp/pi-verify && cd /tmp/pi-verify
gh release download "$TAG" --repo psmfd/pi
sha256sum -c SHA256SUMS
for f in pi-*; do
  gh attestation verify "$f" --repo psmfd/pi \
    --signer-workflow psmfd/pi/.github/workflows/psmfd-release.yml
done
```

Then smoke-test the binary for the local platform:

```sh
tar -xzf pi-darwin-arm64-"$TAG".tar.gz   # or unzip for windows assets
./pi/pi --version    # must print the upstream base version (X.Y.Z)
./pi/pi --help
```

Confirm the archive contains `LICENSE` and `NOTICE.psmfd.md`.

## Compare with upstream (informational)

Upstream publishes no attestations on its binaries, so byte comparison is
informational, never a gate, and upstream bytes are never re-attested. If
comparing: download the upstream asset for the same base version, record both
digests in the release discussion. Differences are EXPECTED (compiler
nondeterminism, added LICENSE/NOTICE, version-named paths); a material
functional difference warrants investigation before announcing.

## Rollback / yank

A release found bad after publication:

1. Edit the release: prepend a **WITHDRAWN** notice to the notes stating the
   reason and the replacement tag. Mark it as a pre-release to de-emphasize.
   Do not delete assets silently — consumers may hold attested bytes; the
   notice is the audit trail.
2. The tag stays (immutable by ruleset; deleting provenance anchors is worse
   than the bad release). Cut the fixed `vX.Y.Z-psmfd.N+1` and reference it
   from the withdrawn notes.
3. If the artifact is actively harmful (compromise, not just a bug), delete
   the release assets after the notice is in place and open a security
   advisory on `psmfd/pi` describing affected digests.

## Post-release

1. Update the consuming config (`pi_config` vendor pin or install channel) to
   the new tag where applicable.
2. Note the release on the umbrella tracking issue (pi_config#355 while open).
3. File follow-ups for any WARN-level oddities observed in the run logs.

## Failure triage quick reference

| Stage | Likely cause | Action |
| --- | --- | --- |
| preflight | tag typo, tag not on `main` | re-cut tag correctly (new `N` if pushed) |
| build | upstream toolchain drift (Bun/tsgo), registry outage | fix via reviewed overlay PR or retry |
| attest | OIDC/Sigstore outage | retry the run later; never sign locally |
| publish/verify | checksum or attestation mismatch | do NOT undraft manually; treat as integrity incident, delete the draft, investigate before any retry |

Never bypass a failed verify step by undrafting manually — the draft gate is
the release's integrity boundary.
