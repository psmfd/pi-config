# ADR-0016 — Substrate ζ (smolvm pack) implementation details: R1 topology, bake matrix, registry, base image, headless auth, update story

- **Status:** Superseded by [ADR-0020](0020-rescind-substrate-zeta-smolvm-pack.md) (substrate ζ rescinded; smolvm support removed; substrate matrix reduces to α + η + κ). Historical supersession note: §D2 was previously superseded in part by [ADR-0017](0017-substrate-zeta-path-b-framing.md); ADR-0020 supersedes ADR-0016 in full.
- **Date:** 2026-05-23
- **Amends:** [ADR-0013](0013-distribution-substrate-strategy.md) — locks the four ζ-implementation dimensions that ADR-0013 left open (persistence-model R1 topology, bake matrix shape, registry namespace, update story). Refines R1's mechanism from "symlinks to read-only repo content" to a hybrid topology (symlinks for read-only sub-paths, real files for writable templates, schema-version sentinel). Inherits without modification [ADR-0014](0014-oci-substrate-amendment-to-0013.md)'s reframing of ζ as **the** sandbox substrate (per-workload kernel, default-deny egress, vsock SSH-agent forwarding) and ADR-0014's cross-substrate amendments (bake `PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1` into the pack's default env). ADR-0013 is not edited; this ADR records the refinement per [`agent/rules/adr-required.md`](../agent/rules/adr-required.md).
- **Related:** [ADR-0009](0009-pi-runtime-acquisition-strategy.md) (vendored-pi pattern that ζ consumes), [ADR-0011](0011-toolchain-install-strategy.md) (vendor-pin pattern that smolvm vendoring per #164 follows), [ADR-0004](0004-consensus-by-replication.md) (decision provenance — 3-way parallel research consult), [`docs/distribution-provenance.md`](../docs/distribution-provenance.md) (cross-substrate provenance policy ζ inherits per #128)
- **Tracking issues:** #99 (distribution umbrella), #131 (ζ implementation parent), #159 (this design pass), #160 (Dockerfile + entrypoint shim — consumes this ADR), #161 (CI release workflow), #162 (cosign provenance), #163 (UX docs), #164 (smolvm vendor pin), #119 (V1+V2 verification — closed PASS, supplies the design inputs that anchor this ADR)

## Context

[ADR-0013](0013-distribution-substrate-strategy.md) selected ζ as a substrate but explicitly deferred four implementation dimensions: persistence-model R1 mechanism, bake matrix shape (2 vs 4 packs), registry namespace, and update story. [ADR-0014](0014-oci-substrate-amendment-to-0013.md) subsequently reframed ζ as **the** sandbox substrate (load-bearing security capability — microVM-grade isolation) rather than a coverage convenience, and added two cross-substrate amendments that apply to ζ (`PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1` baked env; cosign-keyless as floor for OCI substrates, SHA256SUMS for non-OCI). Issue #119 closed PASS on both V1 (node-less extension portability — all 5 of our extensions load under the vendored Bun-compiled pi binary in a `--network none` debian:bookworm-slim container) and V2 (`smolvm pack run -e KEY=VALUE` env-var plumbing — documented `-e KEY=VALUE` form works on smolvm 0.7.2; undocumented Docker-style `-e KEY` inherit-from-host shorthand does not).

With those preconditions cleared, the remaining design surface is concrete and bounded. A 3-way parallel research consult ran on this ADR's specific questions (`smolvm-expert` + `pi-agent-expert` + `docker-expert`, all `PASS_WITH_WARNINGS`, no contradictions, three non-overlapping bodies of expertise — see #159 comment thread for the full reports). A follow-up 3-test empirical validation pass (`OQ1` PTY allocation, `OQ2` virtio-fs UID mapping + volume semantics, `OQ3` ghcr.io as `smolvm pack push` target) confirmed two of the three answers cleanly and surfaced one design refinement (OQ2 — smolvm `-v` is a staging-dir mount at `$HOST/virtiofs/smolvm0/`, not a direct bind mount; UX implication only, no topology impact).

Two facts shape what follows:

1. **Audience contract is locked as "consume-only sandbox."** Recipients who want to customize go to α. ζ ships one canonical pack of the upstream-canonical agent config; `/persistent` holds auth tokens, sessions, and pi's mutable state only — never config edits. Locked by repo owner 2026-05-23 (see #131 thread).
2. **smolvm `.smolmachine` sidecar artifacts are documented cross-platform** while only the stub binary is host-arch-specific. This collapses the matrix question from "2 or 4 host-arch packs" to "2 guest-arch sidecars covering all 4 host audiences," with smolvm-installed-locally as a recipient prerequisite. ADR-0013's framing of the matrix question implicitly assumed standalone-stub UX; the sidecar-plus-prereq UX is cheaper and lower-risk and is the path adopted here.

## Considered options

The four ADR-0013-deferred dimensions each had distinct options; presenting per dimension for transparency.

### Persistence model R1 — topology

**A — Hybrid (chosen): symlinks for read-only sub-paths, real files for writable templates, schema-version sentinel.**
Per `pi-agent-expert`'s authoritative inventory: pi reads from `extensions/`, `skills/`, `prompts/`, `themes/`, `agents/`, `rules/`, `AGENTS.md`, `SYSTEM.md` (never writes) and writes to `auth.json`, `settings.json`, `sessions/`, `models.json`, `keybindings.json`. Pi resolves each leaf independently (`join(agentDir, "auth.json")` style in the binary), so selective per-leaf overrides work. Hybrid symlinks the read-only leaves into the baked `/repo/agent/` layer and uses real files for the writable leaves. `.pack-meta.json` sentinel at `/persistent` root records pack version + pi version + schema version.

**B — Pure overlayfs.** `pi-agent-expert`'s structural preference. Cleanest semantics — pi sees one unified tree, writes go to upperdir (`/persistent`), reads fall through to lowerdir (`/repo/agent`). **Rejected.** Requires guest-kernel overlayfs-over-virtio-fs support; portability risk inside the libkrun microVM kernel (libkrunfw) is not characterized by upstream and would gate ζ on a kernel-feature contract we don't own. Acceptable to revisit if hybrid topology hits operational pain.

**C — Pure copy-on-first-run.** `smolvm-expert`'s preferred for ironclad semantics — entrypoint shim copies `/repo/agent/` → `/persistent/agent/` (minus `auth.json`/`sessions/`) on first run. **Rejected.** Wastes writable-volume bytes on content the pack already ships immutably; defeats the read-only-base-layer purpose; harder migration story (each pack release would re-copy potentially-modified files into a volume the user thought was theirs).

**D — Whole-root symlink (`/persistent → /repo/agent`).** **Rejected.** `pi-agent-expert` explicitly warned: pi's `SettingsManager` writes `settings.json` in-place; whole-root symlink would hit EROFS on first config-touching action.

### Bake matrix — shape

**A — 2 guest-arch sidecars (chosen): `linux/arm64` + `linux/amd64`.**
Per `smolvm-expert`: `.smolmachine` sidecars are documented cross-platform; only the stub binary is host-arch-specific. Two sidecars cover macOS arm64, macOS Intel (upstream-untested but technically reachable), Linux amd64, Linux arm64 audiences. Recipients install `smolvm ≥0.7.2` locally and run `smolvm machine create … --from <sidecar>` (sidecar-plus-prereq UX). CI cost is two `smolvm pack create --oci-platform linux/{arm64,amd64} …` invocations against the OCI image, both runnable on a single `linux/amd64` GHA runner because `pack create` consumes OCI layers, not host CPU.

**B — 4 host-arch standalone-stub packs.** Original ADR-0013 framing. **Rejected.** Doubles CI cost for the matrix and adds notarization risk for the macOS-targeted stubs (upstream `--single-file` help text warns of macOS notarization issues). Sidecar-plus-prereq UX dominates on every axis except first-touch convenience for recipients who lack smolvm — and those recipients have α as the no-prereq path anyway.

### Registry — namespace

**A — Dual-publish (chosen): `ghcr.io/thesemicolon/pi-config-pack:<version>-<arch>` primary + GitHub Releases cosign-blob-signed `.smolmachine` artifact fallback.**
`smolvm config registries init` produces an example `registries.toml` containing a first-class `[registries."ghcr.io"]` block (documented, not inferred). Empirical OQ3 validation confirmed wire-level reachability — unauthenticated `smolvm pack push` to `ghcr.io` returned an OCI-spec-conformant `401 UNAUTHORIZED`, proving smolvm's push pipeline reaches GHCR's distribution API correctly. Dual-publish gives recipients both the idiomatic `smolvm pack pull ghcr.io/…` UX and an offline-verifiable raw-asset fallback path. cosign-keyless signs the OCI artifact in GHCR per ADR-0014's amendment 2; cosign-blob signs the Release-attached `.smolmachine` for the recipient who skips GHCR. Same `GITHUB_TOKEN` covers both publications in CI (#161).

**B — `registry.smolmachines.com` (smolvm default).** **Rejected.** Third-party namespace with no governance over deprecation; account/auth model not characterized; no cosign tie-in.

**C — GitHub Releases only.** **Rejected.** Loses `smolvm pack inspect` pre-flight UX; recipient must `mv` the download into place and run `smolvm machine create --from …` manually. Strictly worse than (A) for the recipient who wants the documented smolvm UX.

### Base image

**A — `debian:bookworm-slim` digest-pinned (chosen).** Per `docker-expert`: the vendored pi binary is Bun-compiled against glibc (V1 confirmed it runs cleanly in `debian:bookworm-slim`). Alpine's musl libc would require a separate Bun-musl build target — additional CI surface for ~22 MB savings on a pack that already carries a 30 MB pi binary. Distroless lacks the bash needed for the entrypoint shim. Bookworm-slim is the smallest sound footprint.

**B — Alpine 3.20 (musl).** **Rejected.** Bun-glibc → musl risk; would require separate vendored-pi build pipeline.

**C — Distroless.** **Rejected.** No shell for the entrypoint shim; would force a Go/Rust rewrite of the shim or a custom layer — at which point bookworm-slim is the simpler answer.

### Headless auth

**A — `auth.json` env-var-name indirection (chosen) for API-key providers; one-time interactive bootstrap for OAuth providers.**
`pi-agent-expert` surfaced (`docs/providers.md:103-118`): pi's `auth.json` accepts three key-resolution forms — literal value, `!shell-command`, or **env-var name**. Bake an `auth.json` template containing `{"anthropic": {"type": "api_key", "key": "ANTHROPIC_API_KEY"}}` (and analogs for every API-key provider — 25+) into the pack's seed payload. Recipient runs `smolvm pack run -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v …` and pi resolves the env-var name to the live secret at call-time. **Fully headless. No `/login` required for API-key providers.** OAuth providers (Claude Pro/Max, ChatGPT Plus, GitHub Copilot) require a one-time interactive `/login` — documented as a separate bootstrap path; OQ1 confirmed `smolvm pack run -i -t` allocates a PTY (`/dev/pts/0`) exactly like `docker run -it`.

**B — Always interactive `/login` (no env-var path).** **Rejected.** Highest-friction UX; defeats the consume-only-sandbox audience contract; demands TTY-friendly recipient context that headless CI cannot satisfy.

**C — Bake API keys into the pack at build time.** **Rejected.** Catastrophic — secrets leak via the published artifact. Not seriously considered; included for option-symmetry.

### Update story

**A — Sentinel-gated, refuse-loud-on-downgrade (chosen).**
`/persistent/.pack-meta.json` records `{pack_version, pi_version, schema_version}`. Shim startup compares baked vs persisted: same → no-op; baked newer than persisted → tolerant (pi auto-migrates sessions v1→v2→v3, settings merges unknown fields, auth.json stable since v0.33 per `pi-agent-expert`'s CHANGELOG audit); baked older than persisted (recipient downgraded) → refuse loudly with the host volume path and an issue-tracker URL in the error message. **Auth tokens and sessions are never mutated by pack upgrades.** Only the read-only symlinks may re-point at new `/repo` content.

**B — Trust pi's per-file migrations alone.** **Rejected.** No documented schema-version sentinel at the pi data-dir level; downgrade silently corrupts an older pi's view of newer-format session files. Shim-owned sentinel is the cheapest defensive layer.

**C — Mutable `/persistent` rewritten by each pack release.** **Rejected.** Overwrites user state; defeats the persistence contract; turns pack upgrades into a destructive operation.

## Decision outcome

Six locked decisions:

| # | Dimension | Decision |
|---|---|---|
| D1 | R1 topology | Hybrid (symlink read-only sub-paths into `/repo/agent/`, real files for writable templates, `.pack-meta.json` sentinel) |
| D2 | Bake matrix | 2 guest-arch `.smolmachine` sidecars (`linux/arm64` + `linux/amd64`); recipients install `smolvm ≥0.7.2` locally |
| D3 | Registry | Dual-publish: `ghcr.io/thesemicolon/pi-config-pack:<version>-<arch>` primary + GitHub Releases cosign-blob-signed sidecar fallback |
| D4 | Base image | `debian:bookworm-slim` digest-pinned; `USER 1000:1000`; `ENTRYPOINT` exec form; no `HEALTHCHECK` |
| D5 | Headless auth | `auth.json` env-var-name indirection for API-key providers (default headless UX); one-time interactive `/login` over `pack run -i -t` for OAuth providers |
| D6 | Update story | Sentinel-gated; refuse loud on downgrade; auth/sessions never mutated by upgrades |

### Filesystem layout (load-bearing for implementation)

The baked OCI image layout:

```text
/repo/agent/                            ← read-only, baked into pack
├── extensions/                         ← all 5 of our extensions (V1-verified portable)
├── skills/
├── prompts/
├── themes/
├── agents/
├── rules/
├── AGENTS.md
├── SYSTEM.md
└── settings.json.template              ← copied to /persistent on first run

/repo/scripts/                          ← read-only; informational for the recipient
/repo/adrs/                             ← read-only; informational for the recipient

/persistent_seed/                       ← read-only seed content for /persistent
├── auth.json.template                  ← contains env-var-name indirection per D5
└── .pack-meta.json                     ← baked sentinel template

/usr/local/bin/pi                       ← vendored pi binary (per-arch via TARGETARCH)
/usr/local/bin/entrypoint.sh            ← R1 seeding shim per D1+D6
```

The runtime view (after entrypoint shim seeds `/persistent`):

```text
PI_CODING_AGENT_DIR=/persistent

/persistent/                            ← host-mounted via smolvm -v $HOME/.pi-agent-data:/persistent
├── .pack-meta.json                     ← sentinel (per D6)
├── extensions       → /repo/agent/extensions      (symlink, per D1)
├── skills           → /repo/agent/skills          (symlink)
├── prompts          → /repo/agent/prompts         (symlink)
├── themes           → /repo/agent/themes          (symlink)
├── agents           → /repo/agent/agents          (symlink)
├── rules            → /repo/agent/rules           (symlink)
├── AGENTS.md        → /repo/agent/AGENTS.md       (symlink)
├── SYSTEM.md        → /repo/agent/SYSTEM.md      (symlink)
├── settings.json                                  (real file — copied from seed; pi writes here)
├── auth.json                                      (real file — env-var-name template seed; pi rewrites on /login for OAuth providers)
└── sessions/                                      (real dir — pi populates)
```

### Default environment (inherited from ADR-0014 cross-substrate amendment 1)

The Dockerfile bakes `ENV PI_OFFLINE=1` and `ENV PI_SKIP_VERSION_CHECK=1` per ADR-0014. Sealed-artifact pi must not beacon `pi.dev/api/latest-version` on launch; the recipient has opted into a known-good version pin by running the signed pack.

### Recipient UX (canonical, per D2 + D5)

```bash
# One-time: install smolvm ≥0.7.2 (per #164 vendor pin)
curl -sSL https://smolmachines.com/install.sh | bash -s -- --version 0.7.2

# Primary path: pull from GHCR
smolvm pack pull ghcr.io/thesemicolon/pi-config-pack:1.0.0-linux-arm64 \
    -o pi-config-pack.smolmachine
smolvm machine create pi-config --from pi-config-pack.smolmachine
smolvm machine start --name pi-config

# Subsequent: run pi inside the pack with API-key auth (fully headless)
# Uses `pack run` — the empirically validated surface (V2 / OQ1).
smolvm pack run \
    -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    -v $HOME/.pi-agent-data:/persistent \
    pi-config-pack.smolmachine \
    -- pi -p "your task"

# OAuth-only bootstrap (one-time): TTY-attached /login
smolvm pack run -i -t \
    -v $HOME/.pi-agent-data:/persistent \
    pi-config-pack.smolmachine \
    -- pi /login
```

The `pack run` surface above is what V2 (#119) and OQ1 (#159) empirically validated. The `machine create` + `machine start` + `machine exec` lifecycle is the long-lived-VM alternative for recipients who want a single persistent VM across many invocations; its `-e`/`-v`/`-i -t` flag plumbing is documented identically in `smolvm machine` help but was not part of this round's empirical pass. #160 will empirically pin the long-lived-VM lifecycle and #163 will document both shapes.

### Recipient UX — `$HOME/.pi-agent-data` opacity (OQ2 follow-up)

Main UX doc treats `$HOME/.pi-agent-data` as opaque smolvm-managed state — recipients don't normally peek inside it. The backup/migration appendix discloses that the actual file layout lives at `$HOME/.pi-agent-data/virtiofs/smolvm0/` (smolvm-internal staging-dir convention surfaced by OQ2) for sophisticated users who want to back up `auth.json` or move state between hosts. The main UX flow does not depend on knowing this.

### `auth.json` mutation surface (D5 interaction note)

Decision D5 seeds `auth.json` with env-var-name indirection entries for every API-key provider. OAuth providers (Claude Pro/Max, ChatGPT Plus, GitHub Copilot) trigger pi's `/login` flow, which **rewrites the affected provider's section** of `auth.json` to embed OAuth tokens. Per `pi-agent-expert`'s audit of the `AuthStorage` writer path, the rewrite is a per-provider upsert, not a whole-file replacement — env-var-name indirection entries for other providers survive an OAuth `/login`. #160 implementation must preserve this property when copying the seed template (use `cp -n` or equivalent so the shim never clobbers a `/login`-mutated `auth.json` on re-seed) and #163 docs should state explicitly that the headless API-key UX continues to work for non-OAuth providers after an interactive OAuth bootstrap.

### Reproducibility posture (note for #161 / #162)

The ADR-0014 amendment 2 cosign-keyless floor + `--provenance=mode=max --sbom=true` give the **OCI image** portion of the dual-publish (D3) partial reproducibility, mitigated by `SOURCE_DATE_EPOCH` + digest-pinned base + checksum-verified pi binary. Residual nondeterminism comes from `deb.debian.org` package-version drift across days.

The **`.smolmachine` sidecar** portion is NOT byte-reproducible at all: smolvm v0.7.2 embeds an RFC-3339 `created` timestamp in the manifest and does not honor `SOURCE_DATE_EPOCH`. See #170 for the upstream-follow-up and the cosign policy implication (attestations bind to produced digest, not bit-identity). #162's policy design must accommodate this asymmetry between the two halves of D3.

## Consequences

**Cross-substrate amendment inheritance.** This ADR introduces no new cross-substrate amendments; it inherits ADR-0014's two amendments (default `PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1`; cosign-keyless floor for OCI substrates) without modification, and ADR-0014's reframing of ζ as **the** sandbox substrate — the load-bearing security capability of the matrix. The decisions locked above are defensible against future "ζ is too expensive, deprecate it" pressure precisely because ζ's microVM-grade isolation is the *only* such capability in the matrix; the implementation details serve that posture.

**Implementation can begin.** The four ADR-0013-deferred dimensions are now closed. #160 (Dockerfile + entrypoint shim) consumes D1+D4+D5+D6; #161 (CI release workflow) consumes D2+D3; #162 (cosign provenance) consumes ADR-0014's amendment-2 floor; #163 (UX docs) consumes D5 + the OQ2 doc nuance; #164 (smolvm vendor pin) is independent infrastructure inherited from ADR-0011's vendor-pin pattern.

**Recipient prerequisite shift.** ADR-0013's strawman implied a standalone-stub UX where the pack ran directly. D2 instead requires recipients to install `smolvm ≥0.7.2` locally. This is documented as the canonical UX in #163; the trade is acknowledged as cost (one recipient install step) for benefit (collapsed CI matrix, sidecar reuse across host arches, idiomatic `smolvm machine` lifecycle). α remains the zero-prerequisite path for recipients who can't or won't install smolvm.

**Documentation obligations.** Per ADR-0014's risk note, the κ-vs-ζ trust-boundary distinction must appear above the fold in any "which substrate?" docs. #163 inherits that obligation: ζ's UX doc must lead with the sandbox posture (per-workload kernel, default-deny egress, vsock SSH-agent forwarding) rather than presenting ζ as "pi-in-a-VM-because-VMs-are-nice." The footgun is recipients reaching for ζ for ergonomic reasons and reaching for κ for security reasons (the inverse of the correct mapping). Aggressive docs are the cheapest mitigation.

**Maintenance cost.** One Dockerfile, one entrypoint shim, one `pack-build.sh` driver, one GHA workflow, one vendored smolvm directory, ~4 docs files (UX + update story + verification + provenance), plus shared infrastructure with #128 (provenance) and #161 (CI). Reuses cosign-keyless infrastructure ADR-0014 already requires for κ. Net incremental load bounded.

**Risk — `smolvm` runtime defects propagating to ζ.** ζ is now tightly coupled to smolvm's `pack push`/`pack pull`/`machine exec` semantics. If smolvm changes the `-v` staging-dir convention (OQ2's surfaced internal naming), the OQ2-doc-nuance appendix becomes obsolete. If smolvm changes the `.smolmachine` sidecar cross-platform guarantee, D2 collapses back to per-host-arch packs. Mitigation: pin `smolvm` per #164 with explicit floor `0.7.2`; bump deliberately with a smoke test against the locked OQ-validation outputs; track upstream smolvm releases via the future scheduled-vendor-bump-bot tracked under #156/#157.

**Risk — pi major-version drift breaking persistence-schema sentinel.** D6's sentinel assumes pi's `auth.json` / sessions / settings.json schemas evolve in the forward-compatible direction `pi-agent-expert` characterized (session v1→v2→v3 auto-migrate; settings merge unknown fields). If a future pi release breaks that pattern (e.g., session v3 → v4 with no migrator), the sentinel will still refuse downgrades correctly but upgrades may silently lose state. Mitigation: pi-bump procedure (ADR-0009 § Bump procedure) gains a "verify against ζ's sentinel" step in its checklist — added inline as a comment on #131 rather than a separate ADR amendment.

**Open question deferred to #160 implementation:** does the shim use `cp -a` for the settings-template seed or a more careful `install -m 0600` to lock down `auth.json` permissions? `auth.json` is per pi's docs `0600` by convention; the shim should preserve that. #160 owns the call.

**Future work — re-evaluate R1-B (pure overlayfs).** If operational pain emerges from the hybrid topology (e.g., editor-write-through-to-EROFS surprises with future skills/extensions content that recipients expect to edit), overlayfs in the libkrun guest is a known direction. Re-open via a successor ADR; do not retrofit silently.
