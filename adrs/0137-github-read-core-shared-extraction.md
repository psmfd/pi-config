---
status: Accepted
date: 2026-08-13
---

# ADR-0137: github-read's core moves to `shared/`, and repo-dash is an interactive-only consumer that registers no tools

**Status:** Accepted — approved with the #981 implementation plan on 2026-08-13.

**Related:** [ADR-0123](0123-typed-read-only-github-and-git-tools.md) (the typed read-only GitHub tools whose core this relocates), [ADR-0088](0088-cross-extension-import-boundary.md) (the cross-extension import boundary this obeys, and whose resolution shape this reuses), [ADR-0065](0065-inline-shared-modules-for-coupled-extension-mirrors.md) (the `../shared/` inlining mechanism whose flatness constrains the layout), [ADR-0030](0030-shared-foundation.md) (the `shared/` foundation), [ADR-0021](0021-extension-type-checking-and-linting.md) (per-extension `tsconfig.json`). Curated plan Track 1.2.

## Context and Problem Statement

The curated feature plan specifies `repo-dash` as summonable pi-tui panels "over `github-read`'s typed readers." That phrasing hides a boundary question. The read machinery — `buildOperationPlan`, `assertReadOnlyPlan`, `runGh`, the field-projection formatter, and the seven per-domain plan builders — lives *inside* the `github-read` extension. A second extension cannot simply import it:

- **ADR-0088** established that cross-extension imports are a defect class, added `validate.sh §6b-quater` and `sync-mirror.sh`'s `verify_no_orphan_cross_imports` as fail-closed gates, and **explicitly rejected** "generalize the ADR-0065 inline mechanism to inline arbitrary cross-extension imports" on the grounds that it "encodes a cross-extension dependency as supported rather than removing it."
- A `../github-read/` import from `repo-dash` would in fact *pass* `§6b-quater` today, because both extensions ship inside the `pi-config` mirror and the gate only fails when the importer is config-mirror-shipped and the target is excluded. Passing the gate is not the same as being correct: it contradicts the policy stated in `CLAUDE.md`, and it breaks the day either extension is promoted to a standalone mirror target — which is exactly the ADR-0042/ADR-0088 failure that produced an unloadable `pi` on every distributed install of v1.19.0.

The second question the plan leaves open is what `repo-dash` is *allowed to be*. It is described as "interactive-TUI-only, no model-callable surface," which is a meaningful security posture — it must not become a second, untyped path to GitHub data for the model — but nothing recorded it as a constraint.

## Decision Drivers

- **The gate's silence is not permission.** A cross-extension import that passes only because of today's mirror layout is a latent break, and the failure mode is an extension that loads in the dev monorepo and dies in distribution.
- **Do not add a second read-only-assertion site.** `assertReadOnlyPlan` and its `SAFE_PREFIXES` are a security control. Duplicating them into `repo-dash` would create a fourth lockstep site of the kind ADR-0071/ADR-0088 exist to prevent, and a drifted copy would mean one consumer enforcing weaker argv safety than the other.
- **Behaviour preservation must be checkable.** A refactor of a security-relevant path is only safe if "nothing changed" is provable by the existing tests rather than asserted.
- **`shared/` has a structural constraint that is not obvious.** See below — it dictated the layout and is the most reusable finding here.

## The `shared/` flatness constraint

`shared/` is **structurally flat**: a subdirectory such as `shared/github-read/catalog.ts` is not merely unconventional, it is unsupported by the mirror tooling, and it fails *silently* rather than loudly. Two mechanisms in `scripts/sync-mirror.sh` enforce this:

1. **`_closure_in_dir`** (the ADR-0065 inline closure resolver) resolves each seed by basename — `f="$dir/${cur}.ts"` — and discovers dependencies with `grep -oE '(from|import) "\./[A-Za-z0-9_-]+\.ts"'`. Neither the file probe nor the dependency pattern admits a `/`.
2. **`verify_inline_imports`** (the fail-closed staged-tree check) matches specifiers with `grep -oE '(from|import) "(\./|(\.\./)+)shared/[A-Za-z0-9_-]+\.ts"'`. A subdirectory specifier does not match the character class, so it is **not verified at all** — the check would skip it rather than fail on it.

A nested module would therefore ship unverified and break the first time an excluded extension needed it inlined. The conforming shape is the **prefix family** already used twice in `shared/`: `expertise-api-{config,health,http,search}.ts` and `package-agent-{canonical,grant-contract,review-contract}.ts`.

## Considered Options

### How repo-dash reaches the typed readers

| Option | Verdict |
| --- | --- |
| **Extract the core into `shared/github-read-*.ts`; both extensions import from `../shared/`** | **Chosen.** Directly reuses ADR-0088's own resolution shape (relocate the shared thing into `shared/`, repoint both consumers). Adds no lockstep site, no policy exception, and no standalone-mirror hazard. |
| `repo-dash` imports `../github-read/catalog.ts` | Rejected. Passes `§6b-quater` only incidentally; contradicts the stated policy; breaks on any future mirror split. |
| `repo-dash` builds its own `gh` argv and runner | Rejected. Duplicates `SAFE_PREFIXES` and `assertReadOnlyPlan` into a fourth lockstep site — the precise failure class ADR-0071/ADR-0088 exist to prevent. |
| Cross-extension RPC over `pi.events` | Rejected. Trades a static, type-checked dependency for an untyped runtime one with load-order coupling, and leaves the read-only assertion unverifiable at compile time. |

### Layout inside `shared/`

| Option | Verdict |
| --- | --- |
| **12 flat modules: 5 core (`-types`, `-validation`, `-formatting`, `-runner`, `-catalog`) + 7 per-domain (`-op-*`)** | **Chosen.** Every file is a pure rename, so the move is reviewable as a rename and behaviour preservation is mechanical. |
| One aggregated `shared/github-read-core.ts` | Rejected — **not on tidiness, on correctness.** The seven operation modules contain three constant names that collide with *different values*: `LIST_FIELDS` and `VIEW_BASE_FIELDS` (issues vs. pull-requests) and `CHECK_FIELDS` (actions, a `FieldSpec`, vs. pull-requests, a string). Concatenation would force renames, converting a mechanical move into a semantic edit whose failure mode — a silently wrong field projection — is invisible to the type checker. |
| `shared/github-read/` subdirectory | Rejected. Unsupported and silently unverified; see the flatness constraint above. |
| Move only the subset repo-dash needs | Rejected. `buildOperationPlan` switches over all seven domains, so a partial move splits one switch across two locations, and `assertReadOnlyPlan` — which every consumer needs — lives with it. |

## Decision Outcome

**1. The core relocates to `shared/`, flat, under the `github-read-` prefix family:**

`github-read-types.ts`, `-validation.ts`, `-formatting.ts`, `-runner.ts`, `-catalog.ts`, and `-op-{actions,issues,notifications,projects,pull-requests,repository,security}.ts`. Every file is a rename with import-specifier rewrites only; no logic is edited.

**2. `github-read` keeps exactly what is specific to being a model-facing extension:** `index.ts` (tool registration, domain activation, the untrusted-content framing and result metadata) and `settings.ts` (the user-layer opt-in gate for the `security` and `notifications` domains). The extension is deliberately thin afterwards. That is not a gutted extension — its identity is the *typed tool surface*, and the `gh` mechanics genuinely are a library. The opt-in gate stays with the tool surface because it governs what the **model** may reach; it is tool-surface policy, not read machinery.

**3. Tests follow their subject.** The three suites covering moved code (`catalog-security`, `formatting`, `runner`) move to `shared/test/github-read-*.test.ts` and run under `scripts/test-shared.sh`; `loader` and `settings` stay with the extension. Assertion content is unchanged — only import specifiers and file locations move. The behaviour-preservation claim is that the same suites pass, redistributed 6→3 in `github-read` and 17→20 in `shared` (23 files before and after), not that any file is byte-identical.

**4. `repo-dash` registers no tools.** It may register commands (`pi.registerCommand`), shortcuts (`pi.registerShortcut`), and widgets, and may open `ctx.ui.custom` panels. It MUST NOT call `pi.registerTool`. Every entry point is guarded on `ctx.hasUI`, so `-p`, `--mode json`, and child subagents are unaffected — children always run headless and must never depend on dialogs.

The security consequence is the point: the model's GitHub reach stays exactly `github-read`'s typed, domain-gated, opt-in-guarded tools. `repo-dash` widens what the **operator** can see at a keystroke without widening what the **model** can request — and because both sit on the same `assertReadOnlyPlan`, the operator-facing path inherits the identical argv safety rather than a parallel implementation of it.

## Consequences

- **Positive.** `repo-dash` proceeds without a policy exception; the read-only assertion stays single-sourced across both consumers; `shared/`'s flatness constraint is written down before someone "tidies" a module into a subdirectory and ships it unverified; and the non-obvious reason the operation modules are not merged is recorded next to the modules themselves.
- **Negative / accepted.** `shared/` grows by 12 files (24 → 36 `.ts` modules), which is a real legibility cost. Mitigated by the prefix family keeping them contiguous alphabetically, and judged the correct trade against a semantic-edit refactor of a security path.
- **Negative / accepted.** `github-read` is now a thin registration shell. A future reader may mistake it for dead weight; this ADR and its README are the answer.
- **Follow-up.** If `github-read` or `repo-dash` is ever promoted to a standalone mirror target, that target needs `inline:` seeds for the `github-read-*` closure (ADR-0065). Neither is excluded today, so no `mirror/targets.yml` change is required now — but the ADR-0074 triple makes this the kind of omission that fails silently at release time, so it is recorded here rather than discovered then.
