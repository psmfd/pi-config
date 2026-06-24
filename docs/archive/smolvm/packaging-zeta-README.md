<!--
Archived 2026-05-25 per ADR-0020 (rescind substrate ζ / smolvm pack).
This file was previously packaging/zeta/README.md — the contributor-facing
one-pager for the substrate-ζ bake source. The Dockerfile, entrypoint shim,
seed templates, fetch/validate scripts, and pack-release workflow this README
referenced have been deleted from the active tree. Body content is preserved
verbatim as historical reference; do not rely on it for current build
guidance — see ADR-0020 for the rescission rationale and the post-rescission
substrate matrix (α + η + κ). All `../../` relative paths below resolved
against the original `packaging/zeta/` location and are now broken; treat
them as decision-history pointers, not navigable links.
-->

# Substrate ζ — `pi-config-pack` Dockerfile + entrypoint shim

This directory holds the bake source for substrate ζ (smolvm pack), per [ADR-0016](../../adrs/0016-smolvm-pack-substrate-details.md) and parent [#131](https://github.com/TheSemicolon/pi_config/issues/131). One-pager for contributors; recipient-facing UX docs live in [#163](https://github.com/TheSemicolon/pi_config/issues/163).

## Layout

| Path | Purpose |
|---|---|
| `Dockerfile` | Two-stage build: BUILDPLATFORM-native fetcher (downloads + verifies the per-`TARGETARCH` pi binary against `agent/vendor/pi/CHECKSUMS`) → TARGETPLATFORM runtime (pinned `debian@sha256:0104b…` base, tini PID-1, USER 1000:1000, ENV `PI_OFFLINE=1`/`PI_SKIP_VERSION_CHECK=1`/`PI_CODING_AGENT_DIR=/persistent`). |
| `entrypoint.sh` | R1 seeding shim per ADR-0016 D1+D6: idempotent symlink seeding of read-only sub-paths, `install -m 0600` for `auth.json`, `install -m 0644` for `settings.json`, writable-dir creation for `sessions/`+`npm/`+`git/`, `.pack-meta.json` sentinel reconciliation (same/upgrade/refuse-on-downgrade). |
| `seed/auth.json` | Headless-auth template per ADR-0016 D5: env-var-name indirection entries for all 26 API-key providers pi recognizes (per pi-agent-expert's v0.75.4 `docs/providers.md:36-118` walk on [#160](https://github.com/TheSemicolon/pi_config/issues/160)). OAuth providers (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot) deliberately excluded — they require interactive `/login`. |
| `seed/settings.json` | Minimal pi default settings; pi merges unknown fields forward-compatibly. |

`seed/.pack-meta.json` is **generated at build time** from the `PACK_VERSION`, `PI_VERSION`, and `SCHEMA_VERSION` build args (see `Dockerfile` final RUN stage), not stored as a static file.

## Local build (single arch)

```bash
cd /path/to/pi_config        # repo root is the build context
docker buildx build \
    --platform linux/arm64 \
    --build-arg SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)" \
    --build-arg PACK_VERSION="0.0.0-dev" \
    -t pi-config-pack:dev-arm64 \
    -f packaging/zeta/Dockerfile \
    .
```

## Local build (multi-arch, requires buildx + qemu)

```bash
docker buildx create --use --name pi-config-builder 2>/dev/null || true
docker buildx build \
    --platform linux/arm64,linux/amd64 \
    --build-arg SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)" \
    --build-arg PACK_VERSION="0.0.0-dev" \
    -t pi-config-pack:dev \
    -f packaging/zeta/Dockerfile \
    .
```

The multi-arch build runs the fetcher stage natively on the builder (the `--platform=$BUILDPLATFORM` directive sidesteps qemu emulation) and only emulates the runtime stage. Acquisition of the pi binary stays fast even on a single-arch host.

## Smoke test the entrypoint shim (without building)

```bash
# Stand up a host-side persistent dir
mkdir -p /tmp/zeta-smoke-persistent
docker run --rm \
    -e PI_CODING_AGENT_DIR=/persistent \
    -v /tmp/zeta-smoke-persistent:/persistent \
    --entrypoint /bin/bash \
    pi-config-pack:dev-arm64 \
    -c '/usr/local/bin/entrypoint.sh ls -la /persistent'

# Re-run (idempotent path)
docker run --rm \
    -e PI_CODING_AGENT_DIR=/persistent \
    -v /tmp/zeta-smoke-persistent:/persistent \
    --entrypoint /bin/bash \
    pi-config-pack:dev-arm64 \
    -c '/usr/local/bin/entrypoint.sh ls -la /persistent'
```

The first run should emit `INFO no persisted sentinel; first run` and seed all symlinks + templates. The second run should emit `OK sentinel matches baked` and no new seeds.

## Build → pack pipeline (full sidecar production)

`scripts/pack-build.sh` (driver) wraps `docker buildx` plus `smolvm pack create` to produce a `.smolmachine` sidecar per arch. See its header comments for invocation.

## Bump procedure

| Bumping | Touch |
|---|---|
| Base image (`debian:bookworm-slim` digest) | `Dockerfile` runtime-stage `FROM` line. Resolve new digest via `docker manifest inspect debian:bookworm-slim` and pick the manifest-list digest (serves both `linux/amd64` and `linux/arm64`). |
| pi version | `agent/vendor/pi/VERSION` (per ADR-0009 bump procedure). Dockerfile's `ARG PI_VERSION` defaults to `v0.75.5` but is overridden by `scripts/pack-build.sh`, which reads VERSION at build time. |
| Schema sentinel | `Dockerfile` `ARG SCHEMA_VERSION`. Bump ONLY when changing the on-disk persistence layout — bumping unnecessarily forces every recipient through the upgrade path. Update the entrypoint shim's `READONLY_LEAVES`/`WRITABLE_TEMPLATES`/`WRITABLE_DIRS` arrays in the same commit. |
| Provider enumeration | `seed/auth.json`. Re-walk `docs/providers.md` (in the vendored pi cache at `~/.cache/pi_config/pi-<VER>/`) for new env-var entries. The pi-agent-expert subagent is the canonical second opinion. |

## Design provenance

| Decision | Lock | Source |
|---|---|---|
| `debian:bookworm-slim` base, `USER 1000:1000` | ADR-0016 D4 | `docker-expert` consult on #160 |
| `PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1` baked env | ADR-0014 amendment 1 | `pi-agent-expert` (ADR-0014 design pass) |
| Hybrid R1 topology (symlinks + `install -m`) | ADR-0016 D1 | `pi-agent-expert` (R1 leaf inventory) |
| Env-var-name `auth.json` template | ADR-0016 D5 | `pi-agent-expert` (`docs/providers.md:36-118`) |
| Sentinel-gated update story | ADR-0016 D6 | Three-way consult on #159 |
| Two-stage Dockerfile, fetcher on `$BUILDPLATFORM` | This README | `docker-expert` consult on #160 (TARGETARCH qemu-trap mitigation) |
| Single seed root `/persistent_seed/` | This README | `code-review-expert` info-flag #5 on PR #165 (collapse of ADR-0016 diagram asymmetry) |
| Writable persistent dirs (`sessions/`, `npm/`, `git/`) | This README | `pi-agent-expert` data-dir-leaf audit on #160 (`docs/packages.md:62,89`) |

## CI release pipeline (`.github/workflows/pack-release.yml`)

Landed in #161. Fires on `release: published` (matrix per ADR-0016 § D2: native
`ubuntu-24.04` for amd64, `ubuntu-24.04-arm` for arm64). Per leg:

1. Probe `/dev/kvm` (smolvm hard prereq).
2. `docker buildx build --push --provenance=mode=max --sbom=true` to
   `ghcr.io/<owner>/pi-config-pack:<tag>-<arch>` (NO manifest list).
3. Verify provenance + SBOM attestations attached via
   `docker buildx imagetools inspect`.
4. Resolve the platform-specific image-manifest digest.
5. Produce `.smolmachine` sidecar from the GHCR digest reference
   (forecloses tag-replacement races).
6. Attach sidecar to the GitHub Release via `gh release upload --clobber`.

A summary job aggregates per-leg manifests and posts/updates a sentinel-marked
comment on parent issue #131 (per #161 AC bullet 3).

**Manual smoke test:** `gh workflow run pack-release.yml -f tag=v1.0.1` from
`main` (or `Actions → pack-release → Run workflow`).

**Reproducibility caveat (#170):** the `.smolmachine` sidecar is NOT
byte-reproducible — smolvm v0.7.2 embeds an RFC-3339 `created` timestamp and
does not honor `SOURCE_DATE_EPOCH`. Cosign attestations (#162) bind to the
produced blob digest. The OCI image portion is partially reproducible
(modulo `deb.debian.org` package-version drift across days).

## Out of scope

- CI release workflow → [#161](https://github.com/TheSemicolon/pi_config/issues/161) (in this PR)
- cosign-keyless signing → [#162](https://github.com/TheSemicolon/pi_config/issues/162)
- Recipient UX docs → [#163](https://github.com/TheSemicolon/pi_config/issues/163)
- smolvm vendor pin → [#164](https://github.com/TheSemicolon/pi_config/issues/164) (closed; smolvm v0.7.2 vendored)
- Sidecar reproducibility → [#170](https://github.com/TheSemicolon/pi_config/issues/170) (smolvm upstream)
