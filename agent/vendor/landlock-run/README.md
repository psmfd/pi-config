# landlock-run vendor pin

Pinned acquisition record for `landlock-run` — the self-restrict-then-exec
Landlock launcher (~300 lines of static C11 over the raw kernel UAPI,
statically linked against musl) that [ADR-0146](../../../adrs/0146-bash-tool-write-confinement.md)
adopts for Phase 2a bash-tool write confinement (#1046). Consumed by the
composed `pi-bash-sandbox` shellPath wrapper.

- **Upstream:** `@deepseek-ai/node-addon-landlock-run` platform packages on
  the npm registry, built from `deepseek-ai/deepseek-harness`
  (`native/landlock-run/`). License: **BSD-3-Clause** (this component ships
  its own LICENSE; the parent monorepo's MIT does not apply here —
  ADR-0146 D2/D9).
- **Pinned version:** 0.1.1 (npm version — no `v` prefix, unlike the
  GitHub-release vendors). Exact-pin discipline per ADR-0146: the
  dependency's public history was ~10 days old at assessment (liveliness
  Active, risk Medium), so every bump is a deliberate `/vendor-update`
  re-audit, never a float.
- **Assets:** the two prebuilt platform tarballs
  (`node-addon-landlock-run-linux-{x64,arm64}-<version>.tgz`), each
  containing the static binary at `package/bin/landlock-run`. **Linux-only
  by nature** — no macOS/Windows assets exist upstream (macOS confinement
  is the Seatbelt leg, #707); this is the repo's first platform-gated
  vendor fetch, and `ih_ensure_landlock_run` returns rc=2 (unsupported
  host triple) on non-Linux hosts by design.
- **Fetch path:** npm registry tarball URLs
  (`https://registry.npmjs.org/@deepseek-ai/node-addon-landlock-run-linux-<arch>/-/<asset>`)
  do not fit `_ih_vendor_fetch_extract`'s GitHub-releases
  `base/tag/asset` URL shape, so `ih_ensure_landlock_run` carries its own
  small fetch using the same primitives (versioned cache dir under
  `~/.cache/pi_config/`, `_ih_verify_sha256`, `_ih_link_local_bin`).

## Bump procedure

1. Read the upstream release notes and re-run the liveliness assessment
   (young dependency — check maintenance signals, not just the diff).
   Diff `native/landlock-run/` C source between pins (~300 lines — read it).
2. Fetch both platform tarballs from the npm registry, compute sha256s,
   update `VERSION` + `CHECKSUMS` + the version citations in this README.
3. `scripts/validate-landlock-run-vendor.sh` must pass (structure), and the
   landlock canary suite (`scripts/test-landlock-canary.sh`) must pass on a
   Linux host — the `mcm` self-hosted smoke workflow is the standing lane.
4. Record the bump in `docs/vendor-updates.md` per its procedure section.
