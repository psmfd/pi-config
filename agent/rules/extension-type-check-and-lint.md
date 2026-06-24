---
description: Type-check and lint every agent/extensions/* via per-extension tsconfig + ESLint v9 type-aware rules (ADR-0021)
---

# Rule: extension-type-check-and-lint

**Scope:** Every change touching `agent/extensions/**/*.ts`.

**Synopsis:** All TypeScript under `agent/extensions/` must type-check clean against its per-extension `tsconfig.json` and pass ESLint v9 with `@typescript-eslint` type-aware rules with **zero errors** (warnings allowed). Both checks run from `scripts/validate.sh` (the required `validate` workflow on `main`) via `scripts/typecheck-extensions.sh` and `scripts/lint-extensions.sh`. Implementation details are recorded in [ADR-0021](../../adrs/0021-extension-type-checking-and-linting.md).

## What the rule enforces

| Surface | Tool | Threshold |
|---|---|---|
| `agent/extensions/<name>/**/*.ts` (each of 6 extensions, including vendored `subagent`) | `tsc --noEmit -p <ext>/tsconfig.json` | Zero type errors |
| `agent/extensions/**/*.ts` (excluding `compaction-optimizer/archive/**` and `node_modules/**`) | ESLint v9 + `@typescript-eslint` (`recommended-type-checked` baseline) | Zero errors; warnings allowed (currently 87, predominantly `no-unsafe-*` in vendored `subagent`) |

The type-aware ESLint rules deliberately enabled as **errors** are the ADR-0021 motivating set:

- `@typescript-eslint/no-floating-promises` (the load-bearing rule for `archive.ts`-style async/fs chains)
- `@typescript-eslint/no-misused-promises`
- `@typescript-eslint/await-thenable`
- `@typescript-eslint/no-unused-vars` (with `_`-prefix exemption)
- `@typescript-eslint/consistent-type-imports`

Rules left as **warnings** (so they surface without blocking CI):

- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/no-unsafe-*` (very noisy against pi SDK; revisit when SDK types tighten)
- `@typescript-eslint/require-await`

## Test files

`**/*.test.ts` get `@typescript-eslint/no-floating-promises` disabled by file override. `node:test`'s `test("name", async () => {})` registers a Promise the runner manages; awaiting it is not the canonical pattern.

## Dependency cache

ADR-0021 Axis C: no `package.json` or `node_modules` is committed at the repo root. `scripts/lib/extension-deps.sh` installs pinned versions of `typescript`, `@types/node`, `eslint`, `typescript-eslint`, the pi SDK packages (`@earendil-works/pi-*`), and `typebox` into `$HOME/.cache/pi_config/extension-deps/<hash>/` keyed by a manifest-hash of the pinned versions. A symlink at `<repo-root>/node_modules` points into that cache so `tsc` and `eslint` resolve modules via the standard upward `node_modules` walk. `.gitignore` covers `/node_modules`.

A single marker `agent/extensions/package.json` containing only `{"type": "module"}` exists to satisfy `module: NodeNext` ESM/CJS interop checks against the ESM-only pi SDK. It declares **no** dependencies.

## Local iteration

- Type-check only: `./scripts/typecheck-extensions.sh` (VERBOSE=1 for raw tsc output).
- Lint only: `./scripts/lint-extensions.sh` (FIX=1 to auto-fix; VERBOSE=1 for raw eslint output).
- Both via the umbrella validator: `./scripts/validate.sh`. Node/npx and the pinned extension dependency cache are required validation prerequisites; if these checks cannot run, the umbrella validator fails instead of treating them as optional skips.

## Exemptions

- **The vendored `subagent` extension is in-scope** per ADR-0021 Axis E. A snapshot bump that introduces type errors must either (a) carry an additional patch in `agent/extensions/subagent/` and document it in that directory's `README.md`, (b) widen a `subagent/`-scoped ESLint suppression for new warning classes only (errors are non-negotiable), or (c) escalate upstream. The decision is recorded in the snapshot-bump PR's body.
- **Generated runtime archives** under `agent/extensions/compaction-optimizer/archive/**` are excluded via ESLint `ignores` and are not part of any `tsconfig.json` `include`.

## Failure mode

If a PR introduces a type error, a new ESLint error, or an environment state that prevents required extension checks from running, the `validate` workflow fails. `scripts/typecheck-extensions.sh` and `scripts/lint-extensions.sh` are independently runnable for local iteration. Adding suppressions instead of fixing the cause is discouraged; when justified (e.g., genuine pi SDK type gaps), use `// eslint-disable-next-line <rule> -- <reason>` with a concrete reason in the comment.
