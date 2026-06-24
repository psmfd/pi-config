# ADR-0017 — Substrate ζ audience contract: Path B (single-file portable; macOS + Debian first-class; Windows deferred)

- **Status:** Superseded by [ADR-0020](0020-rescind-substrate-zeta-smolvm-pack.md) (substrate ζ rescinded; the Path-B audience contract this ADR established is closed by rescission rather than by an ADR-0018 implementation answer; smolvm support removed)
- **Date:** 2026-05-24
- **Supersedes (in part):** [ADR-0016](0016-smolvm-pack-substrate-details.md) § D2 (bake-matrix shape) and the audience-contract assumption that underpins it ("smolvm-installed-locally as a recipient prerequisite; two `.smolmachine` sidecars cover the matrix"). The substrate underneath D2 is being replaced and the prerequisite/sidecar-shape question must be re-answered against the new substrate (deferred to ADR-0018). The other five ADR-0016 decisions (D1 R1 topology, D3 registry, D4 base image, D5 headless auth, D6 update story) are **not** superseded by this ADR; they remain the candidate baseline that ADR-0018 will evaluate for retention under the new substrate. D4 (`debian:bookworm-slim` digest-pinned) is highly likely to be retained because the Path-B narrowing makes Debian first-class and the existing rootfs is reusable. Per [`agent/rules/adr-required.md`](../agent/rules/adr-required.md), supersession is by addition rather than edit; ADR-0016 is not modified.
- **Related:** [ADR-0013](0013-distribution-substrate-strategy.md) (parent strategy that ADR-0014 / ADR-0016 amended), [ADR-0014](0014-oci-substrate-amendment-to-0013.md) (κ OCI substrate + sandbox-substrate reframing of ζ — both inherited unmodified), [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md) (`web_fetch` allowlist that enabled first-party-doc citations in the substrate-evaluation research), [ADR-0004](0004-consensus-by-replication.md) (decision provenance — 2-round parallel research fan-out)
- **Tracking issue:** [#204](https://github.com/TheSemicolon/pi_config/issues/204) (parent — substrate replacement, full Phase 1 → Phase 4 effort)

## Context and problem statement

[ADR-0016](0016-smolvm-pack-substrate-details.md) selected smolvm-pack as substrate ζ and locked six implementation dimensions. Issue [#178](https://github.com/TheSemicolon/pi_config/issues/178) subsequently surfaced a structural defect in smolvm v0.7.2 `pack create` (blob fetch fails on the first layer of debian-based GHCR images, in the agent VM, on GHA `ubuntu-24.04` runners) that is **not** a workaround-addressable bug:

- All non-self-hosted GHA paths exhausted (Probe A: `ubuntu-24.04-arm` — no `linux-arm64` smolvm binary upstream; Probe B: β workaround dead; Probe C: γ v0.7.1 bisect dead; PR #286 ruled out).
- Mac-side sidecar production proved structurally dead: smolvm CLI binaries bundle an in-VM `agent-rootfs.tar` that is **hard-coupled to host arch** (`smolvm-darwin-arm64` ships an aarch64 `agent-rootfs/bin/busybox`; no `--oci-platform` flag overrides this). A recipient kernel of a different architecture cannot exec the agent init → boot fails. Documented in [#178](https://github.com/TheSemicolon/pi_config/issues/178) and #196.
- Self-hosted Linux x86_64 runner ([#200](https://github.com/TheSemicolon/pi_config/issues/200)) remained the only viable smolvm-retaining path — operationally undesirable and still leaves the recipient with smolvm-as-prerequisite, which is the load-bearing assumption that #178 ultimately destabilized.

A 2-round parallel research fan-out (`docs-expert`, `aws-expert`, `docker-expert`, `pi-agent-expert`, `smolvm-expert`) — run with hard-required first-party-documentation citations under the expanded [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md) allowlist (PRs [#202](https://github.com/TheSemicolon/pi_config/pull/202), [#203](https://github.com/TheSemicolon/pi_config/pull/203)) — surfaced that **"what replaces smolvm?" has no single answer until substrate ζ's audience contract is committed.** Two framings were tabled:

- **Path A — own-dev-loop hardening.** Audience: pi maintainers running on their own workstations. Daemon-on-host is acceptable. Single-file portability is **not** required. Optimization target: blast-radius isolation and snapshot/restore speed for the maintainer's local workflow.
- **Path B — ship-as-portable-binary.** Audience: third-party pi users. They receive one artifact (or near-it: brew formula / `.deb` / signed binary) that bundles {rootfs + agent runtime + sandbox boundary} and runs end-to-end with minimum host prerequisites. Optimization target: install friction, signed/notarized binary feasibility, cross-arch matrix coverage, license cleanliness. This was the original substrate-ζ design intent per ADR-0016 §D2 — though the prior framing implicitly assumed "the audience already has smolvm installed," which the smolvm disqualification invalidates.

The two paths select **disjoint** shortlists on the macOS slice (Path A → krunkit-on-Homebrew; Path B → Apple-Containerization-when-floor-met, libkrun/krunkit-today, or possibly libkrun-direct as a shared abstraction). Without an explicit framing commitment, no further substrate-evaluation round can produce an actionable recommendation.

## Considered options

### A — Path A: own-dev-loop hardening

Scope substrate ζ down to hardening the pi maintainer's local sandbox. Daemon-on-host (Lima/Colima/Podman-machine on macOS, Firecracker on Linux) is acceptable. No third-party distribution shape. **Rejected.** This reframing would abandon ADR-0013's distribution-substrate goal (which ADR-0014 reframed ζ as the load-bearing implementation of) and would leave pi without any answer for the third-party-recipient install story. The original problem statement is unchanged; only the prior substrate (smolvm-pack) is invalidated.

### B — Path B: ship-as-portable-binary, with explicit host-tier narrowing — **chosen**

Retain the original substrate-ζ goal (one artifact a third party can run end-to-end), but narrow the supported-host matrix to make the multi-quarter effort tractable:

| Host | Tier | Rationale |
|---|---|---|
| macOS (Apple Silicon dominant; macOS 14 floor) | **first-class** | Original Path-B requirement; Apple Silicon dominance is empirically observed in our maintainer + user base; macOS 14 is the floor required by `krunkit` / `libkrun-efi` per [krunkit README](https://github.com/containers/krunkit) |
| Linux Debian (bookworm + trixie) | **first-class** | Narrower than "Linux generally" — removes Alpine/musl, RHEL-family, Arch from the v1 supported matrix; pins kernel floor (bookworm 6.1 LTS, trixie 6.12 LTS, both above Firecracker's 4.14 minimum per [firecracker-microvm.github.io](https://firecracker-microvm.github.io/)); pins package manager (`apt`) for any in-substrate tooling; aligns with the existing digest-pinned `debian:bookworm-slim` rootfs in `packaging/zeta/Dockerfile` (deleted by ADR-0020 alongside the rest of the ζ bake source) which is reusable as the in-VM rootfs regardless of substrate change |
| Linux non-Debian (Alpine, RHEL-family, Arch) | best-effort | Not in the supported matrix at v1; the substrate may happen to work on them, but no targeted testing or release engineering |
| Windows | **deferred** | Cloud Hypervisor's Microsoft-Hypervisor backend remains on the watch-list; revisit when demand justifies the per-OS-slice work. No commitment in v1. |

### C — Path A and Path B in parallel

Treat the maintainer-loop and third-party-distribution problems as separate substrates with separate ADRs. **Rejected.** Doubles the effort surface without separable user-facing benefit; the maintainer-loop problem is adequately covered today by pi's existing primitives (subagent subprocess isolation + bash-destructive-guard + tool allowlists) per the `pi-agent-expert` characterization in research round 2. No standalone Path-A ADR is justified at this time.

### D — Defer the framing decision; keep smolvm as the substrate behind operational workarounds

Push #178 to the self-hosted Linux runner path ([#200](https://github.com/TheSemicolon/pi_config/issues/200)) and continue. **Rejected.** The structural Mac-side disqualification (hard-coupled per-host `agent-rootfs.tar`) is not addressable by runner choice; even with a self-hosted Linux runner producing the amd64 sidecar, the macOS recipient still runs a smolvm CLI whose in-VM rootfs is wrong-arch for a meaningful subset of cross-pack scenarios. The defect is in smolvm's distribution shape, not in the runner.

## Decision outcome

**Adopt Path B with the host-tier narrowing in option B above.**

This ADR commits to:

1. **Audience contract:** substrate ζ ships a third-party-runnable artifact (or near-it: brew formula / `.deb` / signed binary). Daemon-on-host as a recipient prerequisite is **not** acceptable. smolvm-as-recipient-prerequisite (ADR-0016 §D2's load-bearing assumption) is rescinded.
2. **Host matrix:** macOS (Apple Silicon dominant; macOS 14 floor) and Linux Debian (bookworm + trixie) are first-class. Non-Debian Linux is best-effort. Windows is deferred.
3. **Implementation choice is explicitly deferred** to ADR-0018 (drafted in Phase 3 of #204, after the Phase 2 substrate-verification research round). ADR-0018 will commit to one of: (a) **libkrun-direct as a shared cross-platform abstraction** (architecturally clean if first-party verification confirms libkrun can produce a portable swap-the-host artifact and the Podman-machine + `crun-vm` ecosystem solves "one OCI image → per-container libkrun microVM"); (b) **per-OS-slice composition** behind a thin pi-side abstraction (vfkit + krunkit + libkrun on macOS today, Firecracker or Cloud Hypervisor on Debian, Apple Containerization tracked as the future macOS slice once macOS 26 + Apple Silicon is the floor); (c) a third option surfaced by the Phase 2 research that this ADR has not anticipated.
4. **The non-§D2 dimensions of ADR-0016 are not yet superseded.** D1 (R1 topology), D3 (registry namespace), D4 (`debian:bookworm-slim` digest-pinned base), D5 (env-var-name auth indirection), and D6 (sentinel-gated update story) remain the candidate baseline. ADR-0018 will evaluate each for retention under the new substrate. D4 is highly likely to be retained — the digest-pinned `debian:bookworm-slim` rootfs in `packaging/zeta/Dockerfile` (deleted by ADR-0020 alongside the rest of the ζ bake source) is reusable as the in-VM rootfs regardless of substrate change, and the Path-B Debian-first-class narrowing reinforces that.

## Consequences

### Immediate (this ADR)

- ADR-0016 §D2 is superseded; the rest of ADR-0016 remains in effect as the candidate baseline for ADR-0018 evaluation.
- ADR-0013 and ADR-0014 are not modified. The κ OCI substrate (ADR-0014) and the α GitHub Template / η WSL2 rootfs substrates (ADR-0013) are unaffected by this decision — only ζ's implementation substrate is in flux.
- The Path-B host-tier narrowing (macOS + Debian first-class; Windows deferred) becomes a load-bearing constraint for any Phase 2 substrate-verification work and any Phase 3 implementation ADR.
- [#200](https://github.com/TheSemicolon/pi_config/issues/200) (self-hosted Linux runner for amd64 sidecar production) is queued for close-or-rescope once ADR-0018 lands — if the new substrate does not require cross-arch pack production on GHA, #200 becomes moot.
- [#170](https://github.com/TheSemicolon/pi_config/issues/170) (smolvm `pack create` `SOURCE_DATE_EPOCH` non-determinism) is queued for close as moot under the new substrate.
- [#162](https://github.com/TheSemicolon/pi_config/issues/162) (cosign-sign `.smolmachine` artifacts) and [#163](https://github.com/TheSemicolon/pi_config/issues/163) (substrate UX docs) are queued for rescope under ADR-0018.
- [#176](https://github.com/TheSemicolon/pi_config/issues/176) (extract composite action from `pack-release.yml`) is queued for rescope or close under ADR-0018.
- smolvm is **demoted** from "the sandbox substrate" (ADR-0014's framing) to a narrow "Other" niche. The `agent/vendor/smolvm/` pin, `scripts/validate-smolvm-vendor.sh`, and `agent/skills/smolvm-expert/SKILL.md` are retained as long as the niche use-case retains them; they get cleaned up at the Phase 4 boundary if and only if the niche disappears.

### Phase 2 unblocked

- The next research round can proceed with a defined target: confirm or reject libkrun-direct (option (a) above) versus per-OS-slice composition (option (b)) under the Path-B host-tier narrowing. Phase 2 specialists must cite first-party docs (the [`docs.podman.io`](https://docs.podman.io/) and [`documentation.ubuntu.com`](https://documentation.ubuntu.com/) hosts that PR [#203](https://github.com/TheSemicolon/pi_config/pull/203) added were specifically required for this round).

### Risk and explicit follow-ups

- **Apple Containerization is future-state.** The strongest macOS-first-class Path-B substrate (per `docs-expert` round 1) requires macOS 26 + Apple Silicon, which is not yet a realistic floor for the v1 audience. ADR-0018 must commit to a today-shippable macOS slice (krunkit + libkrun via Homebrew is the leading candidate) and treat Apple Containerization as a tracked future-state migration target, not a v1 dependency.
- **Windows deferral is reversible but not free.** When the deferred Windows tier is reopened, ADR-0017 supersession (or a new ADR-amends-0017) will be required; the implementation ADR-0018 should record the Windows-slice entry point even though it is not built in v1, so a future amendment is additive rather than disruptive.
- **No license-incompatible substrates may be selected by ADR-0018** without an explicit license-supersession step here. Apache-2.0 / MIT / BSD-3 is the floor (matches every other substrate in ADR-0013 / ADR-0014 / ADR-0016). GPL-2.0 substrates (e.g. QEMU as a thick backend) may be evaluated but must carry a license-impact section in ADR-0018.
- **smolvm vendor cleanup is deferred to Phase 4.** Until ADR-0018 commits to a replacement and Phase 4 ships v1 of it, the `agent/vendor/smolvm/` pin and adjacent assets remain in place — they are non-load-bearing for the new substrate but load-bearing for any in-flight smolvm use that has not yet migrated.

## Supersession map (for README.md cross-reference)

| Prior decision | Disposition |
|---|---|
| [ADR-0016 §D2](0016-smolvm-pack-substrate-details.md#decision-outcome) — bake matrix shape (2 guest-arch `.smolmachine` sidecars; smolvm-installed-locally as recipient prerequisite) | **Superseded in part** by this ADR. The audience contract that underpinned §D2 (smolvm-as-prerequisite) is rescinded; the specific sidecar shape is rescinded with it. The new implementation shape is deferred to ADR-0018. ADR-0016's §D1, §D3, §D4, §D5, §D6 are not superseded and remain the candidate baseline for ADR-0018 evaluation. |
