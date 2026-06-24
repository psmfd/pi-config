# ADR-0013 — Distribution-substrate strategy: GitHub Template (α) + WSL2 rootfs (η) primary; smolvm pack (ζ) second-place for Linux/macOS

- **Status:** Accepted
- **Date:** 2026-05-20
- **Related:** [ADR-0001](0001-subagent-orchestration-substrate.md) (orchestration substrate — the substantive content being distributed), [ADR-0004](0004-consensus-by-replication.md) (consensus-by-replication; the decision provenance for this ADR), [ADR-0009](0009-pi-runtime-acquisition-strategy.md) / [ADR-0011](0011-toolchain-install-strategy.md) / [ADR-0012](0012-vendored-pi-default.md) (vendor-asset trust posture mirrored by the cross-substrate provenance policy)
- **Tracking issues:** [#99](https://github.com/TheSemicolon/pi_config/issues/99) (parent), [#126](https://github.com/TheSemicolon/pi_config/issues/126) (LICENSE — closed by [#132](https://github.com/TheSemicolon/pi_config/pull/132)), [#128](https://github.com/TheSemicolon/pi_config/issues/128) (cross-substrate provenance), [#129](https://github.com/TheSemicolon/pi_config/issues/129) (α impl), [#130](https://github.com/TheSemicolon/pi_config/issues/130) (η impl), [#131](https://github.com/TheSemicolon/pi_config/issues/131) (ζ impl), [#133](https://github.com/TheSemicolon/pi_config/issues/133) (skill-content fair-use disclosure)

## Context

`pi_config` started as a single-author orchestration-config repo with `~/.pi` symlinked to a working tree. Issue [#99](https://github.com/TheSemicolon/pi_config/issues/99) is the long-running thread asking *how this repo gets redistributed*: forks, instantiations, sharable installs. The substantive content worth distributing is the agent catalog, the rules, the prompts, the vendored-extension snapshots, the ADRs, and the validate/setup scripts — in roughly that order of stickiness.

Six options were sketched on #99 over its history: **α GitHub Template**, **β release tarball**, **γ Yeoman/Plop generator**, **δ pi-native bundle**, **ε one-shot installer script**, plus a later **ζ smolvm pack** added when smolvm packs became viable. A seventh option, **η `wsl --import` rootfs for Windows**, was added in a follow-up #99 comment during the substrate-decision research round itself, after the paired `hyperv-expert`/`wsl2-expert` work in [#123](https://github.com/TheSemicolon/pi_config/pull/123) and [#124](https://github.com/TheSemicolon/pi_config/pull/124) made the host-prerequisite analysis possible.

Two structural facts shaped the analysis:

1. The **content shape is markdown + shell + agent-config + ADRs**, not compiled code. There is no platform-specific binary in the repo; vendored binaries (`agent/vendor/{pi,nvm,gh,yq,shellcheck}/`) are pinned by sha256 per ADR-0009/0011/0012 and live in the repo as references, not as the substrate's primary payload.
2. **`pi install` (pi 0.74.x) is first-class only for `extensions/`, `skills/`, `prompts/`, `themes/`.** It does not cover the residual surface this repo carries: `agent/rules/`, `agent/AGENTS.md`, `agent/settings.json`, `agent/agents/` wrappers. Any pi-native distribution mechanism would only reach part of the payload — the rest must travel by some other channel.

A LICENSE was a precondition to substrate work — fork-and-redistribute is legally ambiguous without one. That precondition was resolved as MIT in [#126](https://github.com/TheSemicolon/pi_config/issues/126) / [#132](https://github.com/TheSemicolon/pi_config/pull/132) immediately before this ADR.

## Considered options

**α GitHub Template + personalization sweep.**
Mark the repo as a GitHub Template; ship tooling to rewrite the `TheSemicolon`-referencing identity surfaces on a forked clone (currently 18 files). Recipients clone, personalize, set this repo as `upstream`, and pull updates with `git pull upstream main`. Source-of-truth lives on GitHub; recipients own their fork's `~/.pi` symlink path. Lowest-friction permissive-license redistribution path; preserves git history; works cross-platform (anything with `git`). Doesn't ship a sealed artifact — recipients must accept clone-and-personalize friction.

**β Release tarball.**
A versioned `.tar.gz` (or `.zip`) shipped as a GitHub release asset. SHA256 + cosign-keyless attestation per #128. Recipients download, verify, extract, run `setup.sh`. Sealed artifact; verifiable; no git history; updates require re-download. Implicit shape underneath α (any release of the template ships as a tarball anyway) and implicit shape underneath η (the rootfs *is* a tarball with extra OOBE metadata). Has no standalone advantage over α + η.

**γ Yeoman / Plop generator.**
A scaffolding tool that asks recipients personalization questions and produces a fresh repo. Mismatched to a markdown-content + ADR-history repo: scaffolders are designed for code skeletons with templated identifiers, not for an evolving repository whose ADRs explicitly reference prior states. Loses git history. Loses `git pull upstream main` upgrade path. Adds a build-time tool dependency.

**δ pi-native bundle (`pi install` everything).**
Distribute via pi's first-class resource-install mechanism. Capability ceiling: `pi install` only covers `extensions/`, `skills/`, `prompts/`, `themes/` (verified against pi 0.74.x by the `pi-agent-expert` round). The residual surface — `agent/rules/`, `agent/AGENTS.md`, `agent/settings.json`, `agent/agents/` wrappers, `setup.sh`, the vendored extensions, the ADRs, the hooks — has no `pi install` analog. Whatever channel handles the residual ends up handling the first-class items too, by inclusion. δ collapses into α with a known capability gap rather than standing alone.

**ε One-shot installer script.**
`curl … | bash`. Deferred / disposed: revisit-only. Bypasses verification; trains recipients to run unaudited remote shell scripts; provenance story is materially worse than every other option here. Reasonable as an *added convenience* on top of a verified substrate later, not as the substrate itself.

**ζ smolvm pack.**
Bake a smolvm pack with pi + node + this config preinstalled. Recipients run `smolvm pack run -v $HOME/.pi-agent-data:/persistent ...`. Persistence model R1 = `PI_CODING_AGENT_DIR=/persistent` env redirect + entrypoint shim seeding `/persistent` with symlinks to read-only repo content. Sandboxed; zero-host-install; verified positive against current smolvm with a version floor. **Structurally cannot run inside WSL2** — libkrun requires `/dev/kvm`, which is unavailable on the default Win11 Enterprise posture (VBS + HVCI + Credential Guard suppress nested-virt exposure). Reaches Linux + macOS-arm64 cleanly; macOS-Intel falls through to α; Windows is structurally unreachable.

**η `wsl --import` rootfs for Windows.**
Build a rootfs tarball from a base distro (Ubuntu LTS) + bake pi_config content via Docker export + ship with `Install.ps1` doing `wsl --import` on a Windows host. Lowest host-prereq bar of any Windows-reaching substrate — needs only the `VirtualMachinePlatform` Windows feature, no nested-virt, no `/dev/kvm`. Default Win11 Enterprise hosts work without policy changes (verified by `hyperv-expert`). `/etc/wsl-distribution.conf` OOBE schema needs a `wsl --version` floor pin; `wsl --unregister <Distro>` is **destructive** (wipes `ext4.vhdx` including `~`) and must carry a user-visible warning; in-place updates use `git pull && ./setup.sh` *inside* the imported distro, not `wsl --unregister` + re-import.

## Decision outcome

Substrate-label legend (recap from § Considered options): **α** = GitHub Template + personalization sweep; **η** = `wsl --import` rootfs for Windows; **ζ** = smolvm pack.

**Primary substrate: α (GitHub Template) + η (`wsl --import` rootfs for Windows).**
α is the source-of-truth, fork-and-customize, upgrade-via-`git pull upstream main` channel; it absorbs δ as a known capability gap (`pi install` covers part of the payload, `setup.sh` covers the rest). η is the Windows easy-button reaching the substantial slice of the audience on default Windows 11 Enterprise that ζ-on-Windows structurally cannot.

**Second-place substrate: ζ (smolvm pack), Linux/macOS only.**
Sandboxed, zero-host-install UX. Incremental coverage value over α is small (α already reaches the same audience), but the sandboxing is a meaningfully different posture. **ζ explicitly excludes WSL2** — see Context point 2 above.

**Disposed:**

- **β** — implicit in α (any α release tags ship as tarballs) and η (the rootfs *is* a tarball). No standalone work.
- **γ** — markdown shape mismatch. Loses git history; loses `git pull upstream main`; adds a build dep. Not adopted.
- **δ** — absorbed into α with the capability gap recorded above. Not pursued separately.
- **ε** — revisit-only, contingent on having a verified substrate to *be* the source of the curl-able script. Not adopted as a primary substrate.

**Sequencing.**

1. **LICENSE** — done in #132.
2. **α** — #129, blocked on this ADR.
3. **Cross-substrate provenance policy** — #128, parallel with α; mandatory before any sealed-artifact substrate (η, ζ, β-shaped α release tarballs) ships.
4. **η** — #130, blocked on #129 (bakes α content) + #128 (sealed-artifact provenance).
5. **ζ** — #131, blocked on #129 + #128.

## Consequences

**Coverage matrix (after full implementation).**

| Recipient host | Primary path | Second-place |
|---|---|---|
| Linux (any distro) | α — fork + `setup.sh` | ζ — `smolvm pack run …` |
| macOS arm64 | α — fork + `setup.sh` | ζ — `smolvm pack run …` |
| macOS Intel | α — fork + `setup.sh` | (falls through to α) |
| Windows 11 (default Enterprise / VBS-enabled) | η — `wsl --import` + `setup.sh` inside the distro | (ζ structurally unavailable) |
| Windows 11 (`/dev/kvm` enabled, VBS off) | η | ζ — `smolvm pack run …` (best-effort)[^kvm-best-effort] |

[^kvm-best-effort]: "Best-effort" because the configuration (VBS off, `/dev/kvm` exposed inside WSL2) is non-default on Windows 11 Enterprise and not part of the routinely-tested matrix. ζ on this configuration should work mechanically — the `/dev/kvm` precondition libkrun needs is present — but is not a verified-positive cell.

**Cross-substrate preconditions (mandatory before any sealed-artifact substrate ships).**

- **License clarity** — #126/#132 (closed). MIT covers repo-authored configuration; vendored upstream binaries retain their own licenses (per #132 README addendum).
- **Provenance policy** — #128. SHA256SUMS floor + cosign-keyless target. Mirrors the vendor-pinning trust posture of ADR-0009/0011/0012.
- **Personalization sweep enumerated** — #129. Identifies all `TheSemicolon`-referencing identity surfaces (currently 18 files, including the LICENSE copyright line and the README `## License` section added by #132).

**Known gaps acknowledged.** The two-round research surfaced eleven advisory gap-notes; the ones with material consequences for implementation are recorded here:

1. **δ residual surface.** `pi install` cannot ship `rules/`, `AGENTS.md`, `settings.json`, or wrappers. α + `setup.sh` is the de facto answer; document this explicitly in the α implementation (#129) so future "why not pi-native?" questions answer themselves.
2. **smolvm version floor.** ζ depends on `pack run -e KEY=VALUE`. The minimum verified-positive smolvm release must be pinned in #131 before ζ ships.
3. **`wsl --version` floor for η.** The `/etc/wsl-distribution.conf` OOBE schema referenced in § Considered options requires a runtime-version floor; the live schema at <https://learn.microsoft.com/en-us/windows/wsl/build-custom-distro> evolves, and `Install.ps1` must reject hosts below the schema-supporting `wsl --version`. Pin the floor in #130 acceptance criteria.

4. **macOS-Intel cohort.** ζ does not reach macOS-Intel (no smolvm bake target in the recommended 2-pack matrix). α covers them. If the bake matrix expands to 4 packs (`linux/amd64` + `linux/arm64` + `darwin/amd64` + `darwin/arm64`), release-job cost roughly doubles. Decision deferred to #131.
5. **`wsl --unregister` destructive UX.** `Install.ps1` and η's user-visible documentation must mark `wsl --unregister <Distro>` as **DESTRUCTIVE** — it wipes `ext4.vhdx` including the home directory. Tracked in #130 acceptance criteria.
6. **Skill-content fair-use posture.** Disclosure is recommended for a redistribution-target repo (the MIT grant covers our synthesis; vendor-doc fair use is a separate posture). Tracked in #133.
7. **Windows-on-ζ structurally unavailable for default-config hosts.** Documented above; not a defect to fix.

**Implementation ownership.** Each substrate has its own tracking issue and lands in its own PR. This ADR codifies the strategy; it does not prescribe implementation specifics beyond the sequencing constraint.

## Decision provenance

This ADR is the codification of a two-round research process executed under [ADR-0004](0004-consensus-by-replication.md). The process is recorded here because the decision is multi-substrate and surfaces in many downstream PRs; future contributors looking back at *why* α + η + ζ shipped should be able to retrace the reasoning without re-running the round.

**Round 1 — divergent fan-out (3 lenses).** One agent per substrate-relevant domain, distinct prompts:

- `smolvm-expert` — analyzed ζ's persistence model, bake matrix, registry namespace, and the WSL2 structural blocker. Produced persistence model R1 (env redirect + entrypoint shim + host volume) and the V1 (node-less verification) carry-over to #119.
- `wsl2-expert` — analyzed η's `wsl --import` flow, `/etc/wsl-distribution.conf` OOBE schema, the `wsl --unregister` destructiveness, and the cross-substrate provenance need (initially scoped to η; reframed cross-substrate in Round 2).
- `hyperv-expert` — analyzed Windows-host prerequisites for both ζ-on-Windows (dead under default VBS+HVCI+Credential Guard) and η (works on default Win11 Enterprise, no policy changes). Confirmed the structural block on `/dev/kvm` exposure inside WSL2.

A separate δ-capability check (`pi-agent-expert`) confirmed the `pi install` first-class set against pi 0.74.x and produced the absorption-into-α decision.

**Round 2 — consensus-by-replication (3× `pi-agent-expert`, identical brief).** Asked to ratify or reject the Round-1 synthesis (b1 framing: α + η primary, ζ second-place, β/γ/δ/ε disposed). Outcome: **unanimous 3/3 RATIFY** with eleven advisory gap-notes — all of which are either recorded above (the six material ones) or absorbed into the cross-substrate provenance policy (#128) and the ADR-obligation that produced this document.

**Aggregation.** Both rounds composable per ADR-0004's "divergent fan-out + consensus-by-replication composability" clause. Most-severe-wins does not apply (the question was strategic-recommendation, not severity-of-defect); unanimous-RATIFY was the agreed acceptance gate.

The full recommendation comment (the substantive output that this ADR codifies) lives at [#99 comment](https://github.com/TheSemicolon/pi_config/issues/99#issuecomment-4501097254).

## References

- [#99](https://github.com/TheSemicolon/pi_config/issues/99) — parent tracking issue, includes the recommendation comment and the sub-issue task list
- [ADR-0001](0001-subagent-orchestration-substrate.md) — the orchestration substrate this repo is the configuration of
- [ADR-0004](0004-consensus-by-replication.md) — consensus-by-replication framework that governed this decision's provenance
- [ADR-0009](0009-pi-runtime-acquisition-strategy.md), [ADR-0011](0011-toolchain-install-strategy.md), [ADR-0012](0012-vendored-pi-default.md) — vendor-asset trust posture mirrored by the cross-substrate provenance policy in #128
- [`agent/rules/file-issues-first.md`](../agent/rules/file-issues-first.md), [`agent/rules/documentation-in-plan.md`](../agent/rules/documentation-in-plan.md) — process rules that produced the seven-issue tracking shape under #99
