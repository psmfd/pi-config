---
status: Accepted
date: 2026-06-19
---

# ADR-0044: Security overrides for vulnerable transitive dependencies in the psmfd/pi mirror

**Status:** Accepted
**Date:** 2026-06-19
**Tracking label:** `track:pi-mirror` (pi_config)
**Related:** [ADR-0041](0041-conditional-security-patch-divergence.md) (conditional security-patch divergence — this ADR extends its mechanism to transitive deps), [ADR-0043](0043-upstream-reporting-gate.md) (upstream reporting gate — governs the reachability-based reporting determination), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) (build-and-attest trust boundary)

## Context and Problem Statement

ADR-0041 sanctions a temporary, manifest-tracked PSMFD divergence to fix a security finding upstream has not fixed. The patches applied under it so far (psmfd-patch-002 vitest, -004 esbuild, -006 undici) all bump a **direct** dependency — a one-line version change in an upstream-owned `package.json` plus the regenerated lockfile/shrinkwrap.

Some vulnerable dependencies are pulled **transitively** and cannot be fixed by a direct bump:

- **protobufjs ≤ 7.6.0 / ≤ 7.6.2** (GHSA-wcpc-wj8m-hjx6 High DoS, GHSA-f38q-mgvj-vph7 Medium) — pulled by `@google/genai`.
- **ws ≥ 8.0.0 < 8.21.0** (GHSA-96hv-2xvq-fx4p High DoS) — pulled by `@google/genai`, `@mistralai/mistralai`, `openai`.
- **vite ≥ 7.0.0 ≤ 7.3.4** and its transitive **esbuild** (dev/build-only) — pulled by `vitest`.

The parent package's declared range does not move to the patched dependency version, so `npm` keeps resolving the vulnerable version and Dependabot's security-update PR fails ("latest possible version is X because of a conflicting dependency"). The mirror has no direct manifest line to bump.

## Decision

PSMFD may resolve a vulnerable **transitive** dependency by adding a security entry to the root `package.json` **`overrides`** block — a mechanism upstream already uses for non-security pins (e.g. `rimraf`, `gaxios.rimraf`) — forcing the patched version across the tree. This is a form of ADR-0041 conditional security-patch divergence and is governed by the same controls:

- The override entry, the regenerated `package-lock.json`, and (for production deps) `npm-shrinkwrap.json` are listed as `patched_paths` in `.psmfd/patches/manifest.yml` and kept in lockstep with `.psmfd/overlay-allowlist.txt` and the `SECURITY_PATCH_PATHS` set in `psmfd-zero-divergence.yml`.
- The override version MUST satisfy the parent dependency's declared range (so the graph stays self-consistent), and `npm run check` + `./test.sh` MUST pass to confirm no functional regression. An override that would break a parent is not applied — the finding is escalated instead.
- **Retirement** is mechanical, as in ADR-0041: when an upstream sync brings a dependency tree that already resolves the patched (or newer) version, the override entry is dropped on the `sync/upstream-*` import and the manifest entry marked `retired`.

## Reporting determination (ADR-0043)

Reachability drives whether a finding is a candidate for upstream reporting:

- **Runtime / reachable** transitive deps (e.g. protobufjs, ws — reached through Pi's provider HTTP/WebSocket layer) may fall inside upstream's `SECURITY.md` scope; the reporting decision is human-led and recorded per-patch. Materials are preparable; the agent does not file.
- **Dev/build-only** transitive deps (e.g. vite, esbuild — test/build tooling, dev-server-only advisories) are out of upstream scope, consistent with psmfd-patch-002/004.

## Considered Options

- **Wait for upstream / the parent package to move** — leaves an unbounded exposure window on the mirror's attested artifacts for a High/Critical transitive finding; rejected for the same reason ADR-0041 rejected "escalate and wait" for direct deps.
- **Patch the parent package's source** — a far larger behavioral divergence than pinning one transitive version; disproportionate and harder to retire.
- **npm `overrides` security entry (chosen)** — minimal, declarative, retires mechanically on sync, and reuses a block upstream already maintains.

## Consequences

- The mirror can close transitive-dependency security findings ahead of upstream without waiting for the parent package to move, while preserving attestation provenance (the override is a real, auditable commit on `main`).
- The `overrides` block is a slightly larger divergence surface than a single direct-dep version line; the satisfies-parent-range and green-CI requirements bound the breakage risk.
- First applied as **psmfd-patch-007** (protobufjs 7.6.3, ws 8.21.0, vite 7.3.5, esbuild 0.28.1) on `upstream_base: v0.79.5`.
