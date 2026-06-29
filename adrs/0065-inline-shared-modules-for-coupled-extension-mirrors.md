---
status: Accepted
date: 2026-06-27
---

# ADR-0065: inline the `shared/` closure into the `shared/`-coupled extension mirrors at sync time

**Status:** Accepted
**Date:** 2026-06-27
**Tracking issue:** #380
**Related:** [ADR-0030](0030-shared-foundation.md) (in-repo `shared/` library — unchanged in the monorepo; this records its *distribution form*), [ADR-0042](0042-standalone-extension-distribution.md) (standalone extension mirrors — deferred the three coupled extensions and named "inline at sync time" as the intended shape without specifying the mechanism), [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the generic `sync-mirror.sh` + `mirror/targets.yml` engine this extends), [ADR-0058](0058-extension-version-bump-protocol.md) (overlay version bump / `--changed` semantics this interacts with)

## Context and Problem Statement

ADR-0042 distributes each first-party extension as a standalone `psmfd/pi-<name>` mirror. The five **leaf** extensions (zero `shared/` imports) plus the three later leaves (`gh-identity-guard`, `compaction-optimizer`, `expertise-client`) are live. The remaining three — `auto-router`, `context-manager`, `indexing` — were deferred because each imports `agent/extensions/shared/` by relative path, and ADR-0030 deliberately keeps `shared/` an in-repo, **non-published** library (no `index.ts`, no package, relative `../shared/*.ts` imports).

ADR-0042 named the intended resolution — "the modules each one uses are **inlined** into its mirror at sync time" — but recorded no mechanism. ADR-0050 reserved an `inline:` manifest field "until those mirrors exist" but the engine does not honor it. #380 must settle the strategy and specify the mechanism so the three mirrors can be built like Batch A.

The coupling is small but has a non-obvious shape:

| Extension | Direct `../shared/` imports | Transitive closure (what must actually ship) |
|---|---|---|
| `indexing` | `state.ts` | `state.ts` |
| `context-manager` | `signals.ts`, `state.ts` | `signals.ts`, `state.ts` |
| `auto-router` | `candidates.ts`, `signals.ts`, `notify.ts` (type), `state.ts` | `candidates.ts`, **`cost.ts`**, `signals.ts`, `notify.ts`, `state.ts` |

The wrinkle: `shared/candidates.ts` imports `./cost.ts`. So `auto-router`'s shipped set must include `cost.ts` even though `auto-router` never imports it directly. Intra-`shared/` imports are the only transitive edge today (`state.ts`, `signals.ts`, `notify.ts` import only Node builtins), but treating the closure as the unit of work — not the direct-import list — is what makes the mechanism robust as `shared/` evolves.

A second coupling is specific to `auto-router`: it **value-imports** `@earendil-works/pi-ai` and invokes `complete()` at runtime (`classifier.ts`), unlike the leaf mirrors which carry the SDK only as `peerDependencies` (ADR-0042).

## Considered Options

### Top-level strategy (the #380 question)

1. **(a) Publish `shared/` as its own repo/package** each mirror depends on. Rejected: contradicts ADR-0030's explicit "do not publish" stance; introduces a fourth coordinated release pipeline and a version-skew surface for three friend-install extensions.
2. **(b) Inline the imported `shared/` closure into each mirror at sync time.** Chosen. Each mirror stays self-contained and `pi install`-able with no extra dependency; the cost is divergence management, which the sync engine already owns.
3. **(c) Status quo — keep the three in `pi_config` only.** Rejected: leaves the suite's three headline extensions undistributable, defeating ADR-0042's goal for exactly the extensions most worth sharing.

### How the inline set is specified (sub-decision under (b))

- **(i) Manifest lists the full closure verbatim; engine copies + rewrites.** Simple engine, but re-creates the `cost.ts` foot-gun in the manifest: the operator must hand-maintain the transitive closure, and a miss produces a mirror that fails CI typecheck only after push.
- **(ii) Manifest declares the *direct* seed set; engine resolves the transitive closure** by following intra-`shared/` relative imports, then fail-closes if any `../shared/` specifier survives the rewrite. Chosen: the manifest stays semantic ("what this extension imports"), the `cost.ts` case is handled automatically, and a fail-closed verify makes a missed module an aborted sync rather than a red downstream CI run — consistent with `verify_clean`/`verify_portable`.

## Decision Outcome

**Chosen: option (b), implemented via sub-decision (ii).** `agent/extensions/shared/` remains canonical and unpublished in the monorepo (ADR-0030 unchanged); the inline copy is purely a distribution artifact, exactly as ADR-0042 framed it.

### Manifest

Each coupled target declares its **direct** `../shared/` imports in the existing reserved `inline:` list (module basenames, e.g. `inline: [state]`). The leaf mirrors keep `inline: []`. Example:

```yaml
  - name: pi-indexing
    repo: psmfd/pi-indexing
    mode: overlay
    strip_prefix: agent/extensions/indexing
    sources:
      - agent/extensions/indexing
    sanitize:
      - pi-indexing
    inline: [state]
```

Resolved seed sets: `pi-indexing → [state]`, `pi-context-manager → [signals, state]`, `pi-auto-router → [candidates, signals, notify, state]`.

### Engine (`scripts/sync-mirror.sh`)

A new `inline_stage` step runs in `sync_one` **after `stage_target` and before `sanitize_stage`** (so the rewritten content is sanitized, verified, and secret-scanned like everything else):

1. Read the target's `inline:` seed list. Empty ⇒ no-op (every existing target).
2. **Resolve the transitive closure** by scanning `import ... from "./<mod>.ts"` specifiers within the seed modules under `agent/extensions/shared/`, following edges until fixpoint. Today this turns `[candidates, …]` into `[candidates, cost, …]`.
3. **Stage tracked-only**, mirroring the engine's core safety property: copy each `agent/extensions/shared/<mod>.ts` into `$stage/shared/<mod>.ts` via `git ls-files` (an untracked shared file can never ship). The mirror lands them under a `shared/` subdir at the repo root (the extension itself is at root after `strip_prefix`).
4. **Rewrite import specifiers** in the staged extension files: `../shared/<mod>.ts` → `./shared/<mod>.ts`. Intra-`shared/` specifiers (`./cost.ts`) are already correct in the new subdir and are left untouched.
5. **Fail-closed verify:** abort the target if any `\.\./shared/` specifier survives in the staged tree, or if a resolved closure module is missing from the stage. A clean dry-run therefore means the inline is complete and correct, matching the `verify_portable` contract.

`inline_stage` exposes a `--self-test` path (closure resolution + rewrite over fixtures) so `validate.sh` gates it, consistent with the script's other helpers.

### `--changed` change detection (ADR-0050/0058 interaction)

`--changed` compares a target's `sources` against the SHA in its `.mirror-provenance`. Inlined modules live under `agent/extensions/shared/`, which is **not** in a coupled target's `sources` — so a change to canonical `shared/` would not, by default, re-sync the coupled mirrors. The engine therefore folds each coupled target's **resolved inline closure paths** into its change-detection set: a commit touching `shared/state.ts` marks `pi-indexing`, `pi-context-manager`, and `pi-auto-router` as changed. This keeps the inlined copies current with canonical `shared/`, satisfying #380's "stay current with the canonical `shared/`" tie-in and ADR-0050's "fan out only where it matters" property.

### `auto-router` runtime dependency

`pi-auto-router`'s overlay `package.json` declares `@earendil-works/pi-ai` as a real `dependencies` entry (not `peerDependencies`), so `pi install`'s `npm install --omit=dev` resolves the package that `complete()` is value-imported from at runtime. This is a deliberate, documented divergence from ADR-0042's peerDep baseline, justified by the value-import-and-invoke usage. The exact version is pinned to the SDK version the mirror's CI typechecks against. Confirmation is via the friend-install acceptance check in #380 (install into a clean `~/.pi`, run a route, observe `complete()` resolve).

### Sanitization of inlined modules

`sanitize_stage` / `verify_clean` / `verify_portable` run over the **whole** staged tree, including the new `shared/` subdir. Any monorepo-relative markdown link or private slug in a shared module's comments is caught by the same fail-closed gates; the target's `mirror/sanitize/pi-<name>.sed` covers them, identically to how the extension's own files are made portable (ADR-0062). Shared modules carrying only plain-text ADR references (not `](../…)` links) need no transform.

### Scope

This ADR records the decision and the mechanism. The implementation (engine change + manifest entries + the three mirror repos/overlays + doc counts) is Batch-B work under #380, executed per the established extraction pattern (security panel incl. OWASP-for-AI → harden → repo + overlay + sed → wire `targets.yml` → dry-run → sync `v0.1.0` → onboard via `add-mirror-to-installation.sh`), starting with `indexing` (lightest closure).

## Consequences

- **Good:** the three suite extensions become friend-installable with no new published package and no change to ADR-0030's monorepo posture; mechanism reuses every ADR-0050 safety property (tracked-only staging, fail-closed verify, secret-scan); closure resolution removes the `cost.ts` foot-gun; folding the closure into `--changed` keeps inlined copies from silently drifting.
- **Bad / accepted — divergence cost:** the inlined copy is a point-in-time fork of `shared/` per mirror; a `shared/` change re-syncs (and re-versions, per ADR-0058) all coupled mirrors. This is the inherent cost of (b) over (a) and is the explicit trade for self-contained mirrors.
- **Bad / accepted — engine complexity:** a small import-graph resolver and rewrite step are new logic with a `--self-test`; the alternative (i) pushed that burden into the hand-maintained manifest, which was judged worse.
- **Bad / accepted — `auto-router` SDK divergence:** one mirror carries a runtime `dependencies` entry the others do not, a small inconsistency in the overlay set, documented here and in that mirror's README.
- **Follow-ups:** the three mirrors and their security follow-ups are tracked under #380 / the extension-suite track; `inline:` semantics documented in `mirror/targets.yml` schema comments and `docs/outbound-mirror-sync.md`.

## More Information

- #380 (decision + acceptance), ADR-0042 (mirror shape), ADR-0030 (`shared/` foundation), ADR-0050 (sync engine), ADR-0058 (`--changed` / version bump).
- Closure facts verified against the tree at draft time: `shared/candidates.ts → ./cost.ts` is the only intra-`shared/` edge; `state.ts`, `signals.ts`, `notify.ts` import only Node builtins.
