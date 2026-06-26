# `docs/archive/smolvm/` — historical reference for substrate ζ (rescinded)

This directory holds the two highest-value prose artifacts from the rescinded substrate-ζ (smolvm pack) implementation, preserved per [ADR-0020](../../../adrs/0020-rescind-substrate-zeta-smolvm-pack.md) § Consequences > Neutral > Archive disposition.

## What's here

| File | Original path | Why preserved |
|---|---|---|
| [`SKILL.md`](SKILL.md) | `agent/skills/smolvm-expert/SKILL.md` | The most comprehensive prose reference for the smolvm CLI/SDK surface this project ever wrote. Skill-loader frontmatter (`name:` / `description:` / `disable-model-invocation:`) stripped on archive to prevent re-indexing as an active skill. |
| [`packaging-zeta-README.md`](packaging-zeta-README.md) | `packaging/zeta/README.md` | The contributor-facing one-pager documenting the bake source, R1 hybrid topology, sentinel-gated reconciliation, and the build-time platform contract. Relative-path links inside this file are broken (they resolved against the original `packaging/zeta/` location); treat them as decision-history pointers, not navigable links. |

## What's *not* here

- The Dockerfile, entrypoint shim, seed templates, fetch helper (`scripts/lib/fetch-smolvm-binary.sh`), validate script (`scripts/validate-smolvm-vendor.sh`), build driver (`scripts/pack-build.sh`), release workflow (`.github/workflows/pack-release.yml`), agent wrapper (`agent/agents/smolvm-expert.md`), and vendor pin (`agent/vendor/smolvm/`) — all deleted from the active tree in the rescission PR. Recoverable from git history at the pre-rescission tag; standalone reference value is low and ADR-0020 § Supersession map preserves the rationale.
- The superseded ADRs themselves — [ADR-0016](../../../adrs/0016-smolvm-pack-substrate-details.md) and [ADR-0017](../../../adrs/0017-substrate-zeta-path-b-framing.md) — remain in `adrs/` per MADR's supersession-not-deletion convention. Their status frontmatter points at ADR-0020. They are the canonical archive for the substrate decision history; this directory is the prose-detail companion.

## Why ζ was rescinded

See [ADR-0020](../../../adrs/0020-rescind-substrate-zeta-smolvm-pack.md). One-sentence summary: the empirical chain (#178 → #196 → #200) plus the upstream-platform-coverage gap (no `linux-arm64` smolvm binary; `smolvm-darwin-arm64` host-arch-coupled `agent-rootfs.tar`) plus a non-converging Path-B replacement search (#204, #207) together made the maintenance cost of *filling* the deferred ADR-0018 implementation slot exceed the value of doing so. Substrate κ ([ADR-0014](../../../adrs/0014-oci-substrate-amendment-to-0013.md)) structurally covers the v1 distribution audience.

## If sandbox-substrate coverage is ever reopened

#194 (CelestoAI/SmolVM — a different project, name-collision-only with `smol-machines/smolvm`) is the documented entry point. A successor ADR is required before any reopened work begins.
