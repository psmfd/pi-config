---
status: Accepted
date: 2026-05-26
---

# ADR-0021: Type-checking and linting for `agent/extensions/`

**Status:** Accepted
**Date:** 2026-05-26
**Tracking issue:** [#234](https://github.com/TheSemicolon/pi_config/issues/234)
**Implementation tracker:** [#247](https://github.com/TheSemicolon/pi_config/issues/247)
**Related:** [ADR-0001](0001-subagent-orchestration-substrate.md) (substrate for `agent/extensions/`), [ADR-0011](0011-toolchain-install-strategy.md) (developer toolchain install strategy — precedent for npx-pinned tooling), [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md) (network-capable extension surface), [ADR-0019](0019-compaction-optimizer-extension.md) (compaction-optimizer extension — primary consumer of the new contract)

## Contents

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
  - [Axis A — Type-check scope](#axis-a--type-check-scope)
  - [Axis B — Lint tool](#axis-b--lint-tool)
  - [Axis C — Dependency strategy](#axis-c--dependency-strategy)
  - [Axis D — CI integration](#axis-d--ci-integration)
  - [Axis E — Vendored `subagent` extension](#axis-e--vendored-subagent-extension)
- [Decision Outcome](#decision-outcome)
- [Consequences](#consequences)
- [Implementation Plan](#implementation-plan)
- [Open Questions Deferred](#open-questions-deferred)
- [Pre-implementation Verification (Agent Efficacy)](#pre-implementation-verification-agent-efficacy)
- [More Information](#more-information)

## Context and Problem Statement

`agent/extensions/` contains TypeScript across six extensions (`subagent` vendored from pi 0.78.0, plus `compaction-optimizer`, `web-fetch`, `bash-destructive-guard`, `secrets-guard`, `artifact-handoff`). Pi loads each extension at runtime via [jiti](https://github.com/unjs/jiti); there is no build step in the operator's machine.

The repo currently has:

- **No `tsconfig.json`** anywhere (per-extension or repo-root)
- **No `package.json`** anywhere
- **No `eslint.config.*` / `.eslintrc.*`** anywhere
- **No `tsc` or `eslint` invocation in `scripts/validate.sh`** (the required status check on `main`)

The test pattern in `scripts/test-compaction-optimizer.sh` uses `npx --yes tsx@4.19.2 --test test/*.test.ts` — no committed `node_modules`, no lockfile. That establishes a precedent for **npx-pinned, no-install tooling**.

The `linter` subagent flagged this gap during `/review` of PR #216 (compaction-optimizer PR2). The risk:

> Type errors and lint-class defects in extensions land unchecked until they fail at pi-load time in a live session. The compaction-optimizer extension is now ~1500+ lines of TypeScript across two PRs with zero structural type-checking in CI.

The async-heavy filesystem-mutating nature of `compaction-optimizer/lib/archive.ts` (chains of `fs.open`/`fs.writeFile`/`fs.link`/`fs.unlink`, `Promise.all` over user-supplied callbacks, `.catch(() => undefined)` patterns) is exactly the codebase where **floating-promise** and **misused-promise** bugs are most likely to slip past behavioral tests and surface only when a real compaction races a filesystem operation in production.

This ADR decides whether and how to gate that surface in CI. The implementation is tracked separately in [#247](https://github.com/TheSemicolon/pi_config/issues/247).

## Considered Options

### Axis A — Type-check scope

| Option | Sketch | Trade-off |
|---|---|---|
| **A1. Per-extension `tsconfig.json`** | One `tsconfig.json` per extension dir. `validate.sh` iterates and runs `tsc --noEmit` against each. | Each extension is independently loaded by pi at runtime; pi makes no assumption that extensions share a build graph. Per-extension tsconfig matches that reality. Vendored `subagent` gets isolated configuration (it has a different ownership/update cadence — snapshot bumps from upstream). |
| A2. Repo-root shared `tsconfig.json` | Single tsconfig at repo root with `include` covering `agent/extensions/**/*.ts`. | Simpler config, but conflates per-extension contracts. A vendored-extension type error and an own-extension type error become indistinguishable. Cross-extension imports become syntactically possible — currently they cannot happen because pi loads each `index.ts` in isolation. |
| A3. None | Skip type-checking. | Status quo. Defects land in operator sessions. |

**Decision: A1 — per-extension `tsconfig.json`.** Mirrors pi's runtime loading model. Isolates vendored `subagent` from our own extensions for snapshot-bump cleanliness.

### Axis B — Lint tool

Three serious contenders + null option:

| Option | Type-aware rules | Cold install via npx | Config burden | Maturity |
|---|---|---|---|---|
| **B1. ESLint v9 + `@typescript-eslint`** | **Yes** (uses tsc internally via `parserOptions.project`) | Heavy (~150–250 MB cold; ~15–25 s on a clean GH Actions runner) | Flat config + per-rule maintenance; `recommended-type-checked` preset is a reasonable starting baseline | Mature, industry standard |
| B2. Biome (v1.x / v2 in 2026) | No (AST-only, native Rust) | Light (~30 MB single binary; ~3–5 s cold) | Single `biome.json` (~20 lines) | Mature for v1 rule set; v2 still landing |
| B3. Oxlint (Oxc project) | No (AST-only) | Lightest (~25 MB; ~1–2 s cold) | Single config | Still 0.x at end of 2025; project explicitly positions as ESLint *complement* not replacement |
| B4. None | n/a | n/a | n/a | Status quo |

**Key disqualifier for B2/B3:** Both Biome and Oxlint do AST-only linting. The bug class most likely to slip past behavioral tests in this repo is **floating promises** — an `await` we forgot, a `.then()` we didn't `return`, a callback returning a Promise we didn't surface. `@typescript-eslint/no-floating-promises` catches these via tsc's return-type information. Biome's `noFloatingPromises` works AST-only and **misses cases where the floating-promise nature is only knowable from the return type of an external function** (e.g., `fs.unlink(path).catch(noop)` — Biome sees `.catch()` and is satisfied; ESLint via tsc sees that the catch handler's return is implicitly `Promise<undefined>` and the surrounding context expects sync). For an extension surface that's full of `fs.*` chains, that miss rate matters.

**Counter-argument for B2:** If we *don't* commit to type-aware rules, ESLint loses to Biome on every other axis (install footprint, cold start, single tool, free formatting). The decision hinges on whether we commit to type-aware linting. **We do** — see the Axis B preamble for why.

**Oxlint (B3):** Ruled out for now. Project's own documentation positions it as "use Oxlint for fast feedback, ESLint for correctness" — that's a tell. No type-aware rules. Worth a revisit at v1.x stable + when TS rule coverage matures; revisit triggers a successor ADR.

**Decision: B1 — ESLint v9 + `@typescript-eslint`** with type-aware rules ON (`recommended-type-checked` preset as base).

### Axis C — Dependency strategy

| Option | Sketch | Trade-off |
|---|---|---|
| **C1. `npx --yes <tool>@<pinned-version>`** | Same pattern as `scripts/test-compaction-optimizer.sh` (`npx --yes tsx@4.19.2`). No committed `node_modules`, no lockfile. Each CI step cold-installs. | Reproducible via the pinned version. Matches existing precedent. Cost: ~15–25 s cold-install per CI run for ESLint. No lockfile maintenance burden. |
| C2. Commit `package.json` + lockfile, `node_modules` gitignored | Operators run `npm install` once. CI runs `npm ci`. | Faster CI (cached `node_modules`). But introduces `package.json` at repo root — first one — which conflicts with the "no build step" framing in ADR-0019 and creates expectation that operators must run installs. Lockfile drift becomes a PR-burden. |
| C3. Vendor `node_modules` | Commit the full dependency tree. | Bypasses install entirely. But `@typescript-eslint` pulls hundreds of MB of transitive deps; vendoring them defeats the "lightweight" framing of the rest of the repo (per ADR-0011's spirit). |

**Decision: C1 — `npx --yes`-pinned, no committed `node_modules`.** Continues the precedent from `scripts/test-compaction-optimizer.sh`. The CI cost (~15–25 s per run) is acceptable; future optimization via `actions/cache` keyed on the flat-config hash can cut it to ~2 s without changing the contract.

### Axis D — CI integration

| Option | Sketch | Trade-off |
|---|---|---|
| **D1. Two sibling scripts called from `scripts/validate.sh`** | Add `scripts/typecheck-extensions.sh` and `scripts/lint-extensions.sh`, each mirroring `scripts/test-compaction-optimizer.sh`'s shape. Both called from `validate.sh`. | Keeps `validate` as the single required status check on `main` (matches the unlock-procedure framing in `AGENTS.md` Boundaries). Operators run one command (`./scripts/validate.sh`) and get all gates. |
| D2. Separate `.github/workflows/extensions-tc.yml` | New required status check, parallel to `validate`. | Faster CI wall-clock (parallel jobs). But adds a second required status check to `main` branch protection — a new operational concern, and the unlock procedure (in `AGENTS.md`) would need to enumerate it. |
| D3. Inline in `validate.sh` | No new scripts; embed the `npx` calls directly in `validate.sh`. | Inflates a 600-line script that's already at the edge of maintainability. Loses the per-script `VERBOSE=1` ergonomics from `test-compaction-optimizer.sh`. |

**Decision: D1 — two sibling scripts called from `scripts/validate.sh`.** Operators get one entry point; CI gets one required status check; each script remains independently runnable for local iteration.

### Axis E — Vendored `subagent` extension

The vendored `subagent` extension under `agent/extensions/subagent/` is pinned to pi 0.78.0 with **one active local patch** (`tool_execution_*` UI refresh, described in `agent/extensions/subagent/README.md` and pi_config issue #46).

| Option | Sketch | Trade-off |
|---|---|---|
| **E1. In-scope for typecheck + lint** | Same rules as our own extensions. The patched copy gets the same type-safety guarantees. | A type error introduced by a snapshot bump (which is the failure mode we worry about: bump overwrites the local patch and we don't notice) is exactly what we want CI to catch. Cost: snapshot bumps may need a follow-up patch to satisfy stricter type rules upstream lacks. |
| E2. Excluded as upstream-owned | Skip linting it; rely on upstream's quality bar. | Cheaper, but a snapshot bump that breaks the patch silently passes CI and surfaces only at runtime — exactly the failure mode we're guarding against. |

**Decision: E1 — vendored `subagent` is in-scope.** The local patches need the same safety net as our own code. If upstream ever ships type-unclean code, the snapshot-bump PR records the friction and we decide per-bump whether to (a) carry an additional patch, (b) widen the eslint suppressions for `subagent/` only, or (c) escalate upstream.

## Decision Outcome

**Adopted: A1 + B1 + C1 + D1 + E1.**

| Axis | Decision |
|---|---|
| A — Type-check scope | Per-extension `tsconfig.json` |
| B — Lint tool | ESLint v9 + `@typescript-eslint` (type-aware rules ON, `recommended-type-checked` baseline) |
| C — Dependency strategy | `npx --yes <tool>@<pinned-version>`; no committed `node_modules` |
| D — CI integration | Two sibling scripts (`scripts/typecheck-extensions.sh` + `scripts/lint-extensions.sh`) called from `scripts/validate.sh` |
| E — Vendored `subagent` | In-scope (same rules as own extensions) |

## Consequences

### Positive

- **Type errors and floating-promise bugs in extensions are caught in CI**, not at pi-load time in operator sessions. The single most-prone codebase (`compaction-optimizer/lib/archive.ts`, with its async `fs.*` chains) gets the most relevant guardrail.
- **Snapshot bumps of vendored `subagent`** become a CI-checked event. If upstream ships a type-unclean version of an emitter we depend on (e.g., the parallel-mode `### [<agent>] <status>` header that PR #245 hardened against), CI flags it.
- **No build step for operators.** Pi continues to load extensions via jiti; the type-check is purely a developer/CI gate.
- **Mirrors existing precedents.** Per-script ergonomics match `test-compaction-optimizer.sh`. Npx-pinned tooling matches `tsx@4.19.2`. Single required status check matches the `main`-branch unlock framing in `AGENTS.md`.
- **Reversible.** ADRs supersede; if Biome v2 ships a type-aware floating-promise rule and we want to switch, a successor ADR records the swap without touching extension code.

### Negative

- **CI cold-install adds ~15–25 s per run** for ESLint + `@typescript-eslint`. Acceptable; cacheable later via `actions/cache` keyed on the flat-config hash.
- **Flat-config maintenance burden.** `@typescript-eslint` ships breaking changes between majors (v7→v8 was non-trivial). Mitigated by pinning the major in the script and treating bumps as deliberate decisions.
- **First adoption of `eslint.config.js` at repo root.** That file is the only piece of build configuration in a repo that has otherwise resisted `package.json`/lockfile creep. The constraint is documented here and in the implementation tracker: the file is for ESLint flat config only; it does not imply broader adoption of npm-style project structure.
- **Possible upstream patch friction.** If vendored `subagent` type errors after a snapshot bump, we either carry a fix-up patch (small cost) or widen a `subagent/`-scoped suppression (documented as a per-bump decision in the snapshot-bump PR).

### Neutral

- **No `package.json` is committed.** The npx invocations contain the full version pin; reproducibility is enforced via the script, not via a lockfile.
- **`AGENTS.md` rule table gains one entry** (`extension-type-check-and-lint`) when the implementation lands — not as part of this ADR. The rule synopsis will reference this ADR.

## Implementation Plan

Tracked in [#247](https://github.com/TheSemicolon/pi_config/issues/247). Summary:

1. Add `tsconfig.json` to each of the six extension directories (`strict: true`, `noEmit: true`, ES2022, `NodeNext` resolution, per-extension `include`).
2. Add `eslint.config.js` at repo root. Type-aware rules ON. `parserOptions.project` enumerates all six tsconfigs.
3. Add `scripts/typecheck-extensions.sh` and `scripts/lint-extensions.sh` mirroring `scripts/test-compaction-optimizer.sh`.
4. Wire both into `scripts/validate.sh` after the existing compaction-optimizer test step.
5. Fix every finding the new checks surface. Likely includes missing `await`/explicit `void` on a handful of `fs.*` chains, plus `any` cleanup in tool-argument handlers.
6. Add the new files to the doc-sync map in `rules/post-implementation-review.md`.
7. Author a one-page `agent/rules/extension-type-check-and-lint.md` synopsis and add it to the `AGENTS.md` rule table.

Acceptance criteria are enumerated in #247.

## Open Questions Deferred

- **`actions/cache` for ESLint cold-install.** Worth doing only if CI minutes become a binding constraint; deferred to a follow-up issue from the implementation PR if motivated by measurement.
- **Oxlint or Biome v2 revisit.** When either ships type-aware floating-promise rules at production maturity, a successor ADR can swap B1 for B2/B3 without touching extension code (assuming the new tool reads our existing tsconfigs).
- **Format enforcement (prettier or Biome's formatter).** Out of scope for this ADR. The repo has no formatting tool today; adding one is a separable decision.
- **Repo-wide `markdownlint-cli2` / `shellcheck` / `yamllint` integration into the new `scripts/lint-extensions.sh` umbrella.** Out of scope; those tools already run elsewhere with their own ergonomics.

## Pre-implementation Verification (Agent Efficacy)

This ADR was authored without subagent fan-out for the following reason recorded honestly per `rules/agent-first-selection.md` ("Skills are not agents" / handle inline when no agent covers the domain):

> No agent in the catalog covers "evaluate JS lint tooling for a small-to-medium TypeScript repo". The closest fit is `linter` but it *runs* lint tools rather than researching their trade-offs. Per the rule, handling inline is the correct choice when no agent covers the domain. The decision is therefore based on the orchestrator's general knowledge of the 2026 JS lint-tool landscape, validated against the user's "convince me" challenge.

The web-fetch extension's first-party-docs allowlist already covers `eslint.org` and `www.typescriptlang.org`, allowing future ADR amendments to cite primary docs. **Biome and Oxlint are not yet on the allowlist** — a follow-up entry in pi_config issue #238 will track adding `biomejs.dev` and `oxc.rs` if a successor ADR motivates the change.

The "convince me" exchange that produced the B1 decision is preserved in the [Axis B](#axis-b--lint-tool) trade-off table. The user's challenge specifically asked why ESLint over alternatives; the response (floating-promise type-aware rules) is the load-bearing argument and is recorded here verbatim.

## More Information

- [pi_config issue #234](https://github.com/TheSemicolon/pi_config/issues/234) — original umbrella surfaced by `linter` during `/review` of #216
- [pi_config issue #247](https://github.com/TheSemicolon/pi_config/issues/247) — implementation tracker
- [ADR-0011](0011-toolchain-install-strategy.md) — precedent for hybrid vendor + distro toolchain (general repo-toolchain philosophy)
- [ADR-0019](0019-compaction-optimizer-extension.md) — primary consumer; the async-heavy `archive.ts` is the load-bearing motivator
- `scripts/test-compaction-optimizer.sh` — npx-pinned tooling precedent
- `agent/extensions/subagent/README.md` — vendored-extension snapshot-bump procedure (the failure mode E1 guards against)
- [`@typescript-eslint` recommended-type-checked preset](https://typescript-eslint.io/users/configs#recommended-type-checked) — baseline rule set adopted by reference
- [Biome lint rules](https://biomejs.dev/linter/rules/) — alternative B2 reference
- [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) — alternative B3 reference
