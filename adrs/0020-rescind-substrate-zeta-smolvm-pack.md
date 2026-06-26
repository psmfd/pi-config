# ADR-0020 — Rescind substrate ζ (smolvm pack); remove smolvm support

- **Status:** Accepted
- **Date:** 2026-05-25
- **Supersedes:** [ADR-0016](0016-smolvm-pack-substrate-details.md), [ADR-0017](0017-substrate-zeta-path-b-framing.md)
- **Amends:** [ADR-0013](0013-distribution-substrate-strategy.md) (removes ζ from the substrate matrix), [ADR-0014](0014-oci-substrate-amendment-to-0013.md) (κ becomes the sole non-host-process substrate; the "ζ is the sandbox substrate" reframing is retired with ζ; cross-substrate amendments are retained)
- **Related:** [ADR-0004](0004-consensus-by-replication.md) (decision provenance — this ADR was authored via 3-replica `docs-expert` consensus), [ADR-0011](0011-toolchain-install-strategy.md) (vendor-pin pattern — unaffected; the smolvm entry is removed but the pattern stands), [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md) (web-fetch allowlist — the `smolmachines.com` entry is removed under existing allowlist policy, not a new ADR-0015 amendment)
- **Tracking issue:** #219 (umbrella — full disposition matrix for closed/re-scoped child issues)

## Context and problem statement

[ADR-0017](0017-substrate-zeta-path-b-framing.md) reframed substrate ζ's audience contract as Path B (ship-as-portable-binary, macOS + Debian first-class, Windows deferred), rescinded the "smolvm-installed-locally as a recipient prerequisite" assumption that underpinned [ADR-0016 §D2](0016-smolvm-pack-substrate-details.md#decision-outcome), and **deferred the implementation-shape question to a then-unwritten ADR-0018**. Two work tracks were spawned to fill that deferred slot: #204 (Path-B replacement umbrella) and #207 (Phase-2 substrate-verification fan-out: libkrun-direct vs per-OS-slice composition).

Three load-bearing facts have accumulated since ADR-0017 that, taken together, change the cost/benefit of *filling* the deferred slot vs *closing* it:

1. **The empirical wall is structural, not contingent.** #178 (closed) demonstrated that `smolvm v0.7.2 pack create` reproducibly fails fetching the first layer of debian-based GHCR images inside libkrun on GHA `ubuntu-24.04`. #196 disambiguated the failure to GHA-nested-KVM specifics (not all-Linux). #200 validated that a self-hosted Linux x86_64 runner produces sidecars correctly — at the cost of standing up and maintaining a dedicated host indefinitely. The mac-side path is independently dead: `smolvm-darwin-arm64` ships a host-arch-coupled `agent-rootfs.tar` (aarch64 busybox) with no `--oci-platform` override, so cross-arch sidecar production from macOS is structurally infeasible (documented in #178/#196).

2. **The upstream platform-coverage gap is unresolved.** smolvm v0.7.2 publishes only `darwin-arm64` and `linux-x86_64` assets. No `linux-arm64` binary exists upstream, so [`ubuntu-24.04-arm`](https://github.com/actions/runner-images) (AWS Graviton) is structurally unavailable as a build platform regardless of GHA's KVM exposure. `agent/vendor/smolvm/README.md` § "Platform coverage" already documents `fetch_smolvm_binary()` refusing these triples with `upstream-coverage-gap` errors.

3. **The Path-B replacement search has not converged.** ADR-0017's Phase-2 (#207) was meant to confirm or reject libkrun-direct as a shared cross-platform abstraction. The most defensible macOS-first-class candidate (Apple Containerization) requires macOS 26 + Apple Silicon — not yet a realistic v1 floor. Today-shippable alternatives (krunkit + libkrun via Homebrew) reintroduce the daemon-on-host prerequisite that ADR-0017's audience contract explicitly forbids.

In parallel, [ADR-0014](0014-oci-substrate-amendment-to-0013.md) added substrate κ (OCI/GHCR) as the explicit coverage answer for the substantial audience ζ was structurally unable to reach (Codespaces, container-in-container CI, MDM-managed corporate laptops, no-`/dev/kvm` cloud VMs, macOS-Intel, Windows-with-Docker). κ has been the load-bearing distribution channel since ADR-0014 landed; ζ's distinctness has rested entirely on its sandbox role.

The question this ADR answers is **not** "which substrate replaces ζ?" — that question was the one deferred to ADR-0018, and the Phase-2 work to answer it has not produced a deliverable substitute. The question this ADR answers is **"do we replace ζ, rescind it, or keep paying the operational tax?"**

## Considered options

### A — Rescind ζ entirely; reduce the substrate matrix to α + η + κ — **chosen**

Remove the smolvm pin, the packaging tree, the `pack-release.yml` workflow, the `smolvm-expert` subagent, the web-fetch `smolmachines.com` allowlist entry, and the smolvm cross-references in adjacent agent skills. Close the deferred ADR-0018 slot with a numbering note. Mark ADR-0016 and ADR-0017 `superseded by ADR-0020`. Re-evaluate sandbox-substrate coverage only if and when user demand justifies the maintenance load that the Phase-2 search could not.

**Why chosen.** Removes the upstream-defect-coupled lane (#178 chain) *and* the open-ended Path-B replacement search (#204/#207) in one operation. The maintenance surface that goes away is concrete and recurring (vendored pin + validate script + bake source + release workflow + agent surface + adjacent cross-references). What is given up — a project-shipped sandbox channel — was structurally degraded already by the empirical chain; the v0.7.2 ζ that exists today is not the substrate ADR-0014 reframed ζ to be. κ structurally covers the v1 distribution audience. The honest substrate matrix is healthier than the aspirational one.

### B — Replace ζ with a Path-B substrate per the ADR-0018 deferred slot

Continue the Phase-2 substrate-verification work (#207), commit to one of libkrun-direct / per-OS-slice composition / Apple-Containerization-tracked, and ship an ADR-0018 + implementation.

**Rejected.** The Phase-2 work has not produced a deliverable v1 candidate. The macOS-first-class options either require an unrealistic OS floor (Apple Containerization) or reintroduce the daemon-on-host prerequisite (krunkit-via-Homebrew) that ADR-0017's audience contract forbids. Continuing imposes indefinite maintenance load on a substrate whose distinct audience (the sandbox audience) is small and whose distribution audience is already covered by κ. Rescission is reversible by a future ADR if user demand materializes — #194 (CelestoAI/SmolVM — a separate project, name-collision-only with `smol-machines/smolvm`) is the natural starting point for any future re-evaluation.

### C — Continue with operational workarounds (self-hosted x86_64 runner per #200)

Stand up and maintain a dedicated self-hosted Linux x86_64 runner for sidecar production, keep the existing ζ topology, accept the operational tax, defer the Path-B question indefinitely.

**Rejected.** Operationally heavy for a substrate whose audience contract is already compromised. The runner cost is recurring (a host to provision, secure, update, monitor); the benefit is bounded to producing two `.smolmachine` sidecars per release. The deeper issue (smolvm-as-prerequisite, the structural macOS host-arch coupling, the no-`linux-arm64`-upstream gap) is untouched by the workaround. Rejected because the cost is permanent and the benefit is bounded.

## Decision outcome

**Adopt option A.** Rescind substrate ζ. Reduce the substrate matrix to **α (GitHub Template)** + **η (WSL2 rootfs)** + **κ (OCI/GHCR per ADR-0014)**. Remove all smolvm-coupled code surfaces in a single PR (umbrella #219); archive the two highest-value prose artifacts (`agent/skills/smolvm-expert/SKILL.md`, `packaging/zeta/README.md`) under `docs/archive/smolvm/` per the user's archive preference; preserve ADR-0016/0017 in `adrs/` with frontmatter flipped to `superseded by ADR-0020`, per MADR convention and `agent/rules/adr-required.md` (supersession by addition, not edit).

This ADR also explicitly closes **ADR-0017's "Phase 4 smolvm cleanup" deferral.** ADR-0017 left `agent/vendor/smolvm/`, `scripts/validate-smolvm-vendor.sh`, and `agent/skills/smolvm-expert/SKILL.md` in place pending a Phase-4 cleanup that was contingent on the new substrate's identity. With the substrate rescinded rather than replaced, Phase 4 is satisfied by this ADR's removal sequence — there is no successor substrate to migrate to, so the cleanup is unconditional rather than migration-gated.

## Post-rescission substrate coverage

With ζ removed, the supported substrate matrix is:

| Substrate | Role | Audience |
|---|---|---|
| **α** (GitHub Template + personalization sweep, ADR-0013) | Source-of-truth fork-and-customize | Anyone willing to clone, run `personalize.sh`, and own a fork. Zero host prerequisites beyond `git`. |
| **η** (`wsl --import` rootfs, ADR-0013) | Windows easy-button | Recipients on default Windows 11 with WSL2 enabled. |
| **κ** (OCI image on GHCR, ADR-0014) | Portable distribution | Linux + macOS + Windows-with-Docker hosts. Shared-kernel isolation. |

κ structurally covers the audience ζ was *unable* to reach — Codespaces, container-in-container CI runners, MDM-managed corporate Linux laptops, cloud VMs without nested virt, WSL2 without nested-virt enablement, macOS-Intel, Windows-with-Docker — at the explicit cost of shared-kernel rather than per-workload-kernel isolation. **No substrate in the post-rescission matrix provides agent-grade microVM isolation.** This is the honest trade the empirical chain forced: ζ was the only such capability in the original matrix, and the Path-B replacement search did not converge on a deliverable substitute. Recipients with hard kernel-isolation requirements compose κ (or α) with host-side sandboxing of their own choosing (Apple Containerization on macOS 26+, Firecracker / Cloud Hypervisor / firejail / bubblewrap / systemd-nspawn on Linux) at their own discretion; the project does not ship a kernel-isolated channel in v1 post-rescission.

This is an **accepted capability gap, not a tracked follow-up.** Re-opening sandbox-substrate coverage at the project level requires a successor ADR; #194 (CelestoAI/SmolVM) is the natural starting point if and when such a successor is justified. Until then, no work is queued.

This section resolves #220.

## Numbering note (ADR-0018 slot)

[ADR-0017](0017-substrate-zeta-path-b-framing.md) reserved the ADR-0018 number for the substrate-implementation answer it deferred. [ADR-0019](0019-compaction-optimizer-extension.md) (compaction-optimizer) deliberately jumped that reserved slot to avoid blocking on substrate work. ADR-0020 conceptually fills the deferred ADR-0018 slot with the opposite resolution — rescission rather than re-architecture — and **no `adrs/0018-*.md` will be written.** The ADR-0018 number remains unallocated; per `agent/rules/adr-required.md`, ADR numbers are not reused, so the gap is a permanent artifact of the supersession history.

## Consequences

### Positive

- Maintenance surface reduction: one vendor pin (`agent/vendor/smolvm/`), one validate script (`scripts/validate-smolvm-vendor.sh`), one fetch helper (`scripts/lib/fetch-smolvm-binary.sh`), one build driver (`scripts/pack-build.sh`), one packaging tree (`packaging/zeta/`), one release workflow (`.github/workflows/pack-release.yml`), one agent wrapper + skill (`agent/agents/smolvm-expert.md`, `agent/skills/smolvm-expert/`), one web-fetch allowlist entry (`smolmachines.com`), and adjacent cross-references in `agent/skills/{wsl2,hyperv}-expert/SKILL.md`. All removed.
- The substrate matrix's audience contracts become honest. Each retained substrate has a real audience and a workable production path; no aspirational entries remain.
- The Path-B replacement search (#204, #207) closes with a documented resolution rather than indefinite Phase-2 work.
- One fewer upstream coupling (`smol-machines/smolvm`'s release cadence, platform-asset choices, and `pack create` correctness) is on the critical path for our release pipeline.

### Negative

- **No project-shipped microVM-isolated channel in v1.** The "ζ is the sandbox substrate" reframing that [ADR-0014](0014-oci-substrate-amendment-to-0013.md) introduced is retired with ζ. Recipients who require kernel-level agent isolation must compose host-side sandboxing themselves (see § Post-rescission substrate coverage).
- **The "κ-vs-ζ trust-boundary above the fold" documentation obligation that ADR-0014 imposed is retired.** With no ζ to contrast against, leading any "which substrate?" prose with "κ is not the sandbox; ζ is" reads as a reference to an absent capability. κ documentation should now describe κ on its own terms (a portable distribution channel with shared-kernel isolation), not as a contrast against a substrate the project no longer ships. README updates in the umbrella PR enforce this.
- **Breaking change classification.** The PR carrying this ADR deletes a published GitHub Actions workflow (`pack-release.yml`) and a public subagent name (`smolvm-expert`). The PR title uses `feat!:` to record the API-surface break. No downstream consumers are known to depend on these surfaces (confirmed during plan approval), so the breaking-change classification is preservative rather than impactful.

### Neutral

- **Vendor-pin pattern (ADR-0011) is unaffected.** Deleting `agent/vendor/smolvm/` reduces the toolchain-pin surface from N+1 to N entries; the pattern's contract is unchanged. `agent/vendor/{pi,nvm,gh,yq,shellcheck}/` and their matching `scripts/validate-*-vendor.sh` scripts remain load-bearing.
- **ADR-0014 cross-substrate amendments survive unmodified.** The two cross-substrate amendments ADR-0014 introduced — (i) `PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1` baked into every sealed-substrate artifact, and (ii) cosign-keyless as the floor for OCI substrates — still apply to η and κ. Rescinding ζ vacates neither.
- **Agent catalog count drops from 22 to 21 wrapper-paired skills.** `agent/AGENTS.md`'s prose count and the generated agent-catalog table both update in the umbrella PR; the doc-sync pair is enumerated in `agent/rules/post-implementation-review.md`.
- **Web-fetch allowlist contraction is governed by existing ADR-0015, not by a new amendment.** Removing `smolmachines.com` from `agent/extensions/web-fetch/index.ts` is an allowlist-membership change under ADR-0015's existing policy (the allowlist contracts only via deliberate edit), not a policy change. No ADR-0015 amendment is needed; this ADR records the contraction for future audit traceability.
- **Archive disposition.** `agent/skills/smolvm-expert/SKILL.md` and `packaging/zeta/README.md` are preserved under `docs/archive/smolvm/` for historical continuity; the SKILL.md's `name:` / `description:` / `disable-model-invocation:` frontmatter is stripped during the move to prevent accidental re-indexing as an active skill. Superseded ADRs (0016, 0017) remain in `adrs/` per MADR's supersession-not-deletion convention and constitute the canonical archive for the substrate decision history. Deleted code surfaces (Dockerfile, entrypoint shim, fetch helper, validate script, workflow YAML, agent wrapper) are recoverable from git history under the pre-rescission tag; their standalone reference value is low and the ADRs document their existence and rationale.

### Issue disposition (cross-references)

| Issue | Disposition | Rationale |
|---|---|---|
| #219 | umbrella (closes on merge) | This ADR is the work item. |
| #220 | resolved by § Post-rescission substrate coverage | Absorbed into this ADR. |
| #131 | close-as-superseded | Original ζ implementation umbrella; superseded by this ADR. |
| #204 | close-as-superseded | Path-B replacement umbrella; resolved by rescission rather than replacement. |
| #207 | close-as-not-planned | Phase-2 verification fan-out moot under rescission. |
| #196 | close-as-completed | Disambiguation findings folded into § Context above. |
| #200 | close-as-not-planned | Self-hosted-runner workaround moot. |
| #162, #163, #170, #176 | close-as-not-planned | ζ subtasks under #131; bookkeeping closures (see #219 for the full table). |
| #166 | re-scope, leave open | Drop the `fetch-smolvm-binary.sh` half (file deleted by this ADR); the `fetch-pi-binary.sh` hardening remains in scope. |
| #139 | unaffected | κ OCI substrate; arguably becomes higher-priority post-rescission. |
| #194 | unaffected | Different project (CelestoAI/SmolVM); reserved as the entry point if sandbox-substrate coverage is ever reopened. |

## Supersession map

| Prior decision | Disposition |
|---|---|
| [ADR-0016](0016-smolvm-pack-substrate-details.md) — substrate ζ implementation details: hybrid R1 topology, 2 guest-arch `.smolmachine` sidecars, ghcr.io dual-publish, `debian:bookworm-slim` base, env-var-name auth indirection, sentinel-gated update story | **Superseded** by this ADR. ζ is rescinded; all six decisions (D1–D6) lapse with the substrate. ADR-0016's body is preserved; frontmatter status flips to `superseded by ADR-0020` (bolded-line format preserved, no YAML injection, per `agent/rules/adr-required.md`). |
| [ADR-0017](0017-substrate-zeta-path-b-framing.md) — substrate ζ audience contract (Path B: single-file portable; macOS + Debian first-class; Windows deferred); rescinds smolvm-as-recipient-prerequisite; defers implementation to ADR-0018 | **Superseded** by this ADR. The audience contract and the Phase-2 substrate-verification work it spawned are closed by rescission rather than by an ADR-0018 implementation answer. ADR-0017's body is preserved; frontmatter status flips to `superseded by ADR-0020` (same format-preservation note as above). |
| [ADR-0013](0013-distribution-substrate-strategy.md) — distribution-substrate strategy (α + η + ζ) | **Amended** by this ADR. The substrate matrix reduces to α + η + κ (κ was added by ADR-0014). ADR-0013 is not edited; this ADR records the change per `agent/rules/adr-required.md`. |
| [ADR-0014](0014-oci-substrate-amendment-to-0013.md) — add OCI/GHCR substrate κ; reframe ζ as the sandbox substrate | **Amended** by this ADR. The "ζ is the sandbox substrate" reframing is retired with ζ; κ becomes the sole non-host-process substrate. The two cross-substrate amendments ADR-0014 introduced (`PI_OFFLINE=1` baseline; cosign-keyless floor for OCI substrates) **survive unmodified** and continue to apply to η and κ. ADR-0014 is not edited. |

## Agent efficacy (consensus-by-replication record)

Per `agent/rules/consensus-by-replication.md` and `agent/rules/research-parallelism.md` § Agent Efficacy Reporting, this ADR was authored via 3-replica `docs-expert` consensus on seven open authoring decisions plus surfaced novel concerns. The full agreement matrix lives in the orchestrator session's Agent Efficacy Report and in the working plan at `.review/rescind-zeta-smolvm/PLAN.md` (Tier 3, non-durable). Summary:

- **Unanimous (3:0).** Repurpose "Considered options" as the rescission trichotomy; absorb #220 as a standalone section; balanced tone (retrospective in Context, forward-looking in Decision Outcome); explicit acknowledgement of the ADR-0018 placeholder; brief archive disclosure in Consequences.
- **Majority (2:1).** No Contents block — adopt the ADR-0013/14/16/17 bold-line frontmatter family shape, not ADR-0019's YAML+Contents-block hybrid; three-option Considered Options shape (R1's fourth "defer" option folded into "replace later if demand emerges"); §220 placed as a top-level section rather than nested under Decision Outcome; hybrid backlinks (empirical chain inline, bookkeeping closures via umbrella). Dissent on the Contents-block question and the full-inline-disposition-table question recorded; minority positions adopted only where they carried first-party evidence the majority missed.
- **Singleton novel contributions adopted.** Retiring ADR-0014's "κ-vs-ζ above the fold" doc obligation (R1); explicitly closing ADR-0017's Phase-4 deferral (R1); preserving the ADR-0014 cross-substrate amendments (`PI_OFFLINE=1`, cosign-keyless floor) explicitly (R2); including #166's partial re-scope in the disposition table (R2); SKILL.md frontmatter-strip rationale in the archive sentence (R3); supersession-flip edits preserving the existing bolded-line frontmatter format (R3); this Agent Efficacy section itself (R3).
- **Multi-instance corroborations adopted.** Breaking-change classification (R1+R2), vendor-pin posture preemptive sentence (R1+R2), AGENTS.md skill-count drift attribution (R2+R3), web-fetch allowlist contraction governed by existing ADR-0015 (R2+R3).

Two of the three replicas verdicted `INFO`; the third also `INFO`. No replica verdicted `NEEDS_CHANGES` (i.e., no replica argued the rescission itself was wrongly framed).

## References

- [ADR-0013](0013-distribution-substrate-strategy.md), [ADR-0014](0014-oci-substrate-amendment-to-0013.md), [ADR-0016](0016-smolvm-pack-substrate-details.md), [ADR-0017](0017-substrate-zeta-path-b-framing.md) — the substrate-decision chain this ADR closes
- [ADR-0004](0004-consensus-by-replication.md) — fan-out shape used to author this ADR
- [ADR-0011](0011-toolchain-install-strategy.md) — vendor-pin pattern (unaffected by removal of the smolvm entry)
- [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md) — web-fetch allowlist policy (`smolmachines.com` removal is under existing policy, not a new amendment)
- [`agent/rules/adr-required.md`](../agent/rules/adr-required.md) — ADR conventions (supersession by addition, not edit; numbers not reused)
- [`agent/rules/post-implementation-review.md`](../agent/rules/post-implementation-review.md) — doc-sync map for the AGENTS.md skill-count edit
- Umbrella tracking issue #219 — full child-issue disposition table
- Working plan `.review/rescind-zeta-smolvm/PLAN.md` and issue mapping `.review/rescind-zeta-smolvm/ISSUE-MAPPING.md` — Tier 3 per ADR-0006/0007; non-durable, not linked from on-`main` text beyond this reference
