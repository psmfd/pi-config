---
status: Accepted
date: 2026-08-13
---

# ADR-0134: hashline-edit is vendored source from pi-hashline-edit, not an npm dependency

**Status:** Accepted — approved with the #976 implementation plan on 2026-08-13.

Companion: [ADR-0135](0135-core-tool-override-policy.md) (the override design this vendoring serves). Tracking issue: #976.

## Context and Problem Statement

The curated feature plan's Track 1.1 (`notes/curated-feature-plan.md`) calls for hash-anchored editing as the pilot of the local-first soak pipeline. The original plan wording assumed vendoring the published `@oh-my-pi/hashline` npm package. Research (2026-08-13, four-agent fan-out under #976) invalidated that path on three independent grounds:

1. **Runtime import constraint.** pi loads extensions through jiti with `tryNative: false`; an extension can import only packages pi bundles (ADR-0099 records this for bash-parser). No npm runtime dependency is possible, whatever the package.
2. **Dependency weight.** `@oh-my-pi/hashline` hard-depends on `@oh-my-pi/pi-natives` — a ~143 MB-per-platform native N-API addon bundling the entire oh-my-pi native layer — and ships raw TypeScript gated on `engines.bun >= 1.3.14`.
3. **Contract churn.** The package's LLM-facing patch syntax was rewritten 4–5 times in ~11 weeks, with breaking changes landing at patch-version bumps.

Meanwhile two third-party pi extensions reproduce hashline behavior in pure extension space without that package. The question: which source do we vendor, and under what drift-control contract?

## Considered Options

- **A. Vendor `RimuruW/pi-hashline-edit` source** (MIT, v0.8.3) — a purpose-built pi `read`/`edit` override with three small pure-JS deps (`diff`, `xxhashjs`, `file-type`), its own ADRs and test suite.
- **B. Vendor `@oh-my-pi/hashline` source** — truest to the original, but requires patching out the native addon (losing block ops), replacing Bun APIs, and tracking a 2.3-releases/day upstream.
- **C. First-party reimplementation** from upstream's prompt/grammar as spec — full control, longest build, re-learns the failure-path lessons.

## Decision Outcome

**Chosen: Option A.** `RimuruW/pi-hashline-edit` v0.8.3 (commit `ba7db994`) is vendored into `agent/extensions/hashline-edit/` under a subagent-style content-hash manifest:

- **Pristine snapshot committed**: `upstream/pi-hashline-edit-v0.8.3-src.tar.gz` + recorded sha256, making drift validation hermetic (no network, no cache population — a deliberate difference from `validate-subagent-drift.sh`, whose upstream snapshot is too large to commit).
- **`PATCH_MANIFEST.json`** records per-file upstream/local content hashes plus in-scope local additions; `scripts/validate-hashline-drift.sh` (wired into `validate.sh` and `scripts/test-hashline-edit.sh`) fails on any unrecorded divergence.
- **Dependencies inlined, not installed** (the ADR-0099 constraint): the pinned jsdiff 8.0.2 UMD bundle is vendored verbatim as `vendor/jsdiff/diff.cjs` (BSD-3-Clause, sha256-recorded) behind a typed ESM wrapper; `xxhashjs` is replaced by a first-party reference-vector-tested xxHash32 (`vendor/xxh32.ts`); `file-type` is replaced by a minimal magic-byte sniffer (`vendor/file-sniff.ts`) with a documented precision delta.
- **Patch table** lives in the extension README; every local change to upstream files must appear there and in the manifest.
- **Bump procedure**: fetch new tag → re-apply patch table → regenerate manifest → treat `prompts/**` changes as a model-contract re-integration, not a routine bump.
- The upstream vitest suite is not vendored; upstream CI validates the pinned tag, and a node:test suite covers the patched integration surface per repo convention.

## Consequences

- **Good** — proven pi-native integration shape; smallest patch surface (7 recorded patches); upstream to track is pi-shaped, not fork-shaped.
- **Good** — hermetic drift validation; a contributor patching vendored source without registering it fails `validate.sh` locally and in CI.
- **Good** — zero runtime npm dependencies, consistent with every other extension in the repo.
- **Bad** — we owe the divergence bookkeeping: hash-anchor behavior here will drift from oh-my-pi's original as both evolve; the README's provenance section records the lineage so comparisons stay honest.
- **Bad** — ~40 KB binary tarball committed to the repo (accepted: it is the price of hermetic validation, and orders of magnitude below the pi snapshot that forced the subagent validator's cache design).
- **Neutral** — upstream token-savings claims are not inherited: the 61 % figure is a single-model output-token result driven by retry-loop elimination; the soak phase (#976) measures our own baseline instead.
