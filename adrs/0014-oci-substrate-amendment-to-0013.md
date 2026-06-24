# ADR-0014 — Add OCI/GHCR container substrate (κ); reframe smolvm pack (ζ) as sandbox substrate, not coverage second-place

- **Status:** Accepted
- **Date:** 2026-05-20
- **Amends:** [ADR-0013](0013-distribution-substrate-strategy.md) — extends the substrate matrix from α + η + ζ to α + η + ζ + κ, and reframes ζ's role from "second-place by adoption breadth" to "the sandbox substrate, defined by its agent-isolation posture rather than ranked by reach." ADR-0013 is not edited; this ADR records the change per [`agent/rules/adr-required.md`](../agent/rules/adr-required.md).
- **Related:** [ADR-0001](0001-subagent-orchestration-substrate.md) (orchestration substrate — the substantive content being distributed), [ADR-0004](0004-consensus-by-replication.md) (consensus-by-replication; the decision provenance for this ADR), [ADR-0009](0009-pi-runtime-acquisition-strategy.md) / [ADR-0011](0011-toolchain-install-strategy.md) / [ADR-0012](0012-vendored-pi-default.md) (vendor-asset trust posture; constrains κ's base-image choice)
- **Tracking issues:** [#99](https://github.com/TheSemicolon/pi_config/issues/99) (distribution umbrella), [#128](https://github.com/TheSemicolon/pi_config/issues/128) (cross-substrate provenance — κ consumes), [#129](https://github.com/TheSemicolon/pi_config/issues/129) (α content κ bakes), [#131](https://github.com/TheSemicolon/pi_config/issues/131) (ζ — sibling lane), [#139](https://github.com/TheSemicolon/pi_config/issues/139) (κ implementation)

## Context

[ADR-0013](0013-distribution-substrate-strategy.md) selected α + η primary and ζ second-place from a six-option matrix (α/β/γ/δ/ε/ζ) plus a late-added η. Two facts surfaced after ADR-0013 landed that the original analysis did not weigh fully:

1. **ζ structurally cannot reach a substantial slice of the Linux-shaped audience.** libkrun requires `/dev/kvm` accessible to the invoking user. The following host classes do not satisfy that prerequisite by default and therefore cannot run ζ at all: GitHub Codespaces (no `/dev/kvm` exposed in dev-container), container-in-container CI (default GitHub-hosted, GitLab, ADO Linux runners do not pass `/dev/kvm` into job containers), corporate-managed Linux laptops with MDM-blocked `kvm` group or firmware-disabled virtualization, cloud VMs without nested-virt enablement (most Azure non-`Dv5`/non-`v5` and AWS non-`*.metal` instance families by default), and WSL2 without nested-virt enablement. Together these are the dominant "Linux-shaped runtime that isn't a real Linux host" population. ADR-0013's coverage matrix folded all of these into "Linux (any distro)" and assumed ζ reached them; it does not.

2. **ζ's value proposition is microVM isolation, not coverage.** libkrun gives a per-workload kernel (libkrunfw), default-deny egress (`--net` is opt-in; `--allow-host` is allowlist-only), and vsock-mediated SSH-agent forwarding (private keys never enter the guest filesystem). For `pi_config`'s threat model — running an agent that may execute attacker-influenced code via the `bash` tool — these are load-bearing security properties, not packaging conveniences. ADR-0013's "second-place by adoption breadth" framing understated this; ζ is unique in the matrix as the *only* substrate providing kernel-level isolation, and that uniqueness is what justifies ζ's continued first-class status independent of coverage.

A 3-replica research round (`smolvm-expert` + `docker-expert` + `pi-agent-expert`, all `PASS_WITH_WARNINGS`, unanimous-RATIFY per [ADR-0004](0004-consensus-by-replication.md)) confirmed that an OCI/GHCR container substrate **κ** is technically viable, complementary (not competitive) to ζ, and reuses ~80–85% of ζ's plumbing (entrypoint shim, `PI_CODING_AGENT_DIR=/persistent` redirect, vendored-binary layout, secret env passthrough, persistence-model R1 from ADR-0013). The research surfaced one critical risk: if κ is documented as "another sandboxed pi distribution" the κ-vs-ζ trust-boundary distinction collapses in recipients' minds and ζ's security claim erodes. The decision is to add κ *and* explicitly reframe what ζ is *for* in the project's mental model.

## Considered options

**A — Add κ as sibling to ζ, reframe ζ as the sandbox substrate.**
Substrate matrix becomes α + η + ζ + κ. ζ's role is defined by its sandbox posture (per-workload kernel, default-deny egress, vsock SSH-agent), not by its coverage rank. κ's role is coverage/portability for hosts that can't run ζ. Documentation enforces the trust-boundary distinction above the fold. ζ keeps its smolvm-pack maintenance lane (#131); κ gets its own lane (#139). Reuses cosign-keyless infrastructure that #128 already requires. Both substrates inherit persistence model R1 unchanged.

**B — Add κ; deprecate ζ.**
κ reaches more hosts, has standard tooling, ships native cosign-keyless OCI signatures. Drop ζ to reduce maintenance load. **Rejected.** Loses the only substrate in the matrix providing kernel-level isolation. The agent-sandboxing capability is a deliberate security investment, not a coverage convenience; deprecating it because a more-portable-but-shared-kernel alternative exists inverts the priority. The ADR-0013 "second-place" framing made this rejection harder than it should have been; this ADR fixes that framing as part of the decision.

**C — Keep ADR-0013 as-is; do not add κ.**
Recipients on `/dev/kvm`-less hosts route to α (clone + `setup.sh`). Lowest maintenance load. **Rejected.** α requires cloning, personalizing 18 files (per #129), and host-installing pi + node + toolchain. The κ research showed roughly the *majority* of "Linux user who tried `pi_config`" attempts fall on hosts where ζ won't boot; sending all of them to α is a meaningful UX downgrade with no reciprocal benefit. The κ implementation is one Dockerfile, one GHA workflow, one wrapper script, plus shared infrastructure with #128 and #129 that exists regardless. Cost is bounded; benefit is real.

**D — Replace ζ with κ + a documented `setup.sh --sandboxed` mode.**
Move sandboxing into a host-installed posture (firejail, bubblewrap, systemd-nspawn). **Rejected.** Host-installed sandboxes are weaker than libkrun's microVM model (shared kernel; LSM-dependent; varies across distros; firejail has had a meaningful CVE history). Also blurs the distribution-vs-runtime-isolation concern. ζ is structurally simpler than this alternative and provides a stronger boundary.

## Decision outcome

**Selected: Option A — add κ as a sibling substrate; reframe ζ as the sandbox substrate.**

### Updated substrate matrix

| Substrate | Role | Reach | Sandbox posture |
|---|---|---|---|
| **α** (GitHub Template + personalization sweep) | Source-of-truth; fork-and-customize; upgrade via `git pull upstream main` | Universal (any host with `git`) | Host-process; relies on host's user-level isolation |
| **η** (`wsl --import` rootfs) | Windows easy-button | Default Win11 + `VirtualMachinePlatform` | WSL2 utility-VM boundary; not marketed as sandbox |
| **ζ** (smolvm pack) | **The sandbox substrate** | Linux + macOS-arm64 with `/dev/kvm` accessible | **Per-workload kernel (libkrunfw); default-deny egress; vsock SSH-agent forwarding** |
| **κ** (OCI image on GHCR) | Coverage/portability where ζ cannot reach | Codespaces, CI runners, MDM laptops, no-KVM cloud VMs, WSL2 without nested-virt, macOS-Intel, Windows-with-Docker-Desktop | Shared-kernel; **explicitly not a sandbox** |

### Role split (load-bearing for documentation)

- **ζ is preserved as a load-bearing security capability.** ADR-0013's "second-place by adoption breadth" wording is superseded by this ADR. ζ's continued investment is justified by what it uniquely provides (microVM-grade isolation), not by where it ranks on a coverage matrix it was never the right substrate to win.
- **κ is a distribution channel, not a sandbox.** Recipients who want sandboxing route to ζ. The κ-vs-ζ trust-boundary distinction must appear above the fold in any "which substrate?" documentation. Egress allowlisting (ζ's `--allow-host`) is explicitly *not* a κ feature — there is no clean OCI analog and we will not imperfectly emulate it.
- **κ does not displace η for Windows.** η requires only the `VirtualMachinePlatform` Windows feature; κ-on-Windows requires Docker Desktop or rootful WSL2 Docker. Default Win11 Enterprise hosts get η; hosts that already run Docker Desktop may prefer κ. Recipient choice; not a hierarchy.
- **Persistence model R1 from ADR-0013 transfers verbatim** to κ (`PI_CODING_AGENT_DIR=/persistent` env redirect + `-v $HOME/.pi-agent-data:/persistent` host bind mount + entrypoint shim seeding `/persistent` with symlinks to read-only repo content on first run).

### Cross-substrate amendments

This ADR also surfaces two changes that apply beyond κ:

1. **`PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1` are baked into the default env of every sealed-substrate artifact** (κ image, ζ pack, η rootfs). Sealed artifacts must not beacon `pi.dev/api/latest-version` on launch; recipients verifying signed artifacts have already opted into a known-good version pin. Tracked retro-application to ζ as a comment on [#131](https://github.com/TheSemicolon/pi_config/issues/131); to η as a comment on [#130](https://github.com/TheSemicolon/pi_config/issues/130). κ adopts directly via [#139](https://github.com/TheSemicolon/pi_config/issues/139).
2. **#128 cross-substrate provenance policy is refined**: cosign-keyless is now the *floor* for any OCI substrate (κ), not the target state. SHA256SUMS remains the floor for non-OCI substrates (η rootfs tarball, ζ `.smolmachine` pack). The OCI digest + Fulcio + Rekor + SLSA `provenance: true` shape is a single-step opt-in via `docker/build-push-action`; gating it behind a "target state" tier was an over-cautious reading of the policy. Surface to [#128](https://github.com/TheSemicolon/pi_config/issues/128) for inclusion in the policy authoring.

### Sequencing

ADR-0013's sequencing is preserved; κ slots in parallel to ζ:

1. ✅ LICENSE — done (#132)
2. **α** — #129
3. **Cross-substrate provenance policy** — #128 (parallel with α)
4. **η** — #130 (blocked on #129 + #128)
5. **ζ** — #131 (blocked on #129 + #128)
6. **κ** — #139 (blocked on #129 + #128; parallel to ζ; no ordering dependency on ζ)

## Consequences

**Updated coverage matrix (after full implementation, including κ):**

| Recipient host | Sandbox path | Coverage path |
|---|---|---|
| Linux (bare-metal desktop, KVM + group access) | ζ — `pack run …` | α / κ |
| Linux (Codespaces, CI-in-container, MDM laptop, no-KVM VM) | (sandbox unavailable; document the gap) | κ — `docker run …` |
| macOS arm64 | ζ — `pack run …` | α / κ |
| macOS Intel | (sandbox unavailable on macOS-Intel; ζ excludes it) | α / κ |
| Windows 11 (default Enterprise / VBS-enabled) | (sandbox unavailable; ζ structurally excluded by VBS+HVCI) | η — `wsl --import` |
| Windows 11 (`/dev/kvm` enabled, VBS off) | ζ (best-effort, contingent on nested-virt) | η / κ-via-Docker-Desktop |

The "sandbox path" column is the load-bearing addition relative to ADR-0013. Where ζ is unavailable, the matrix is honest that *no substrate provides agent-grade sandboxing on that host class* — recipients choose between coverage and isolation, and the project documents the trade rather than papering over it.

**Documentation obligations:**

- README "which substrate?" section must put the κ-vs-ζ trust-boundary distinction above the fold, not in a footnote. The footgun the research round flagged ("I'll run untrusted agent code in `docker run ghcr.io/.../pi_config`") is the single largest risk this ADR creates and the one most cheaply mitigated by aggressive documentation.
- κ implementation issue (#139) acceptance criteria explicitly include the trust-boundary explainer and the wrapper script. Both are non-negotiable.

**Maintenance cost:** one new Dockerfile, one new GHA workflow (`oci-publish.yml`), one wrapper script (`pi-config-run` or equivalent), and a cross-substrate smoke job. Reuses the cosign-keyless infrastructure #128 already requires for ζ and η. Net incremental load is bounded; sharper boundary on what each substrate is *for* reduces ongoing decision overhead.

**Risk: κ-as-sandbox erosion.** If recipients (or future contributors) come to think of κ as "the easier-to-use sandboxed pi," ζ's investment becomes hard to justify and the project drifts toward "pick whichever Docker command you remember." Mitigations: the trust-boundary docs above the fold; the explicit "not a sandbox" disclaimer in #139; this ADR's reframing of ζ as the sandbox substrate (not the coverage second-place) so future readers understand ζ's role from its name in the matrix, not from a buried sentence. Worth re-reading on every substrate-docs change.

**Open question deferred to implementation:** does the wrapper script ship as `pi-config-run`, as a `bin/pi-config` symlink, as a Homebrew formula, or as several? The research did not converge on one shape; #139 owns the call.
