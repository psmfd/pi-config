---
status: Accepted
date: 2026-07-21
---

# ADR-0115: git-native stale-file prune for overlay mirror pushes

**Status:** Accepted
**Date:** 2026-07-21
**Related:** [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the outbound sync engine this hardens), [ADR-0042](0042-standalone-extension-distribution.md) (overlay-mode standalone extension mirrors), [ADR-0062](0062-mirror-readme-portability.md) / [ADR-0065](0065-inline-shared-modules-for-coupled-extension-mirrors.md) (the sanitize + inline-closure stage this prunes against), pi_config #813 (this defect), #835 (stale ADR-0042 `tsconfig.json` classification, surfaced here), #836 (a `--dry-run`-reachable prune preview, deferred).

## Context and Problem Statement

`scripts/sync-mirror.sh` pushes a derived snapshot of each extension's source into a standalone public mirror repo. Its `push_target` applies the freshly-staged tree to a clone of the mirror with two modes (`sync-mirror.sh` apply block):

- **replace** (the config mirror) — `rsync -a --delete`: the mirror is wholly derived, so extraneous files are deleted.
- **overlay** (the 12 extension mirrors) — `rsync -a` with **no `--delete`**: the mirror also carries mirror-owned packaging (`.github/**`, `package.json`, `package-lock.json`, `LICENSE`, `.gitignore`, `.mirror-provenance`, `.markdownlint-cli2.yaml`) that the stage does not produce and must be preserved.

Because overlay mode never deletes, a source file **removed upstream** lingers in the mirror forever. Concretely (#813), `psmfd/pi-expertise-client` still tracked four orphaned `lib/{config,health,http,search}.ts` — stale pre-ADR-0095 copies of logic that moved to `shared/expertise-api-*.ts` — and `psmfd/pi-auto-router` still tracked root-level `{anthropic,copilot}-discovery.ts` (+ their tests), stale copies of logic moved to `shared/`. Both mirrors' own `index.ts` imports only the current `shared/` modules, so the orphans are dead files: divergent, auth-shaped, publicly visible code that no longer reflects source.

A cross-mirror audit found exactly these two affected mirrors; the other ten overlay mirrors were clean. The fix must prune source-derived files removed upstream **without** deleting mirror-owned packaging, on a change that force-pushes to public repos.

## Considered Options

1. **`rsync -a --delete` + `--filter='protect …'` / `--exclude` packaging rules.** Rejected. It reintroduces the exact class of confidently-assumed-safe behavior that *created* #813: the fix would depend on filter/protect-pattern parity between two independently-implemented rsync engines (openrsync on macOS dev/CI, GNU rsync on Linux CI), a feature this codebase has zero test coverage for, whose divergence fails **silently** as a deleted packaging file rather than a loud error.
2. **A packaging *allowlist* the prune skips.** Rejected as the primary mechanism. A leaky list — a new packaging file type added later and forgotten becomes deletable — and it must be maintained in lockstep with the mirror overlay forever.
3. **A git-native set-difference prune, scoped to top-level names the current stage produced.** Chosen.

## Decision Outcome

**Option 3.** `push_target`'s overlay branch keeps the additive `rsync -a` copy and then prunes git-natively: `overlay_prune_set` prints the files git-**tracked** in the clone (`git ls-files`) that the current stage no longer produces, and `git rm` removes exactly that set before the commit.

The safe prune scope is **"top-level path components the current stage run actually produced."** Packaging files live under top-level names the stage never produces (nothing under `agent/extensions/<name>/` is named `.github`, `package.json`, `.gitignore`, …), so they are **structurally unreachable** as prune candidates — no allowlist maintenance is required for the primary safety property. `lib/` *is* a stage-produced top-level name, so the four orphaned `lib/*.ts` (files left in the clone's `lib/` that the current stage's `lib/` no longer contains) are correctly the prune set, while `.github/`, `package.json`, and every other packaging surface are excluded because their top-level name was never staged.

Three independent safety gates back this:

- **`OVERLAY_PROTECTED_TOPLEVEL`** — a static protected-name list (`.github`, `.gitignore`, `.mirror-provenance`, `.markdownlint-cli2.yaml`, `LICENSE`, `package.json`, `package-lock.json`, `install.sh`, `update.sh`) checked as a **second, independent** gate. Never needed given the scoping above, but cheap insurance against a future stage-generation bug that emits a colliding top-level name.
- **Independent empty-stage recheck** — `push_target` re-verifies the stage is non-empty itself rather than trusting `stage_target`'s earlier refusal; a prune step must not stake its safety on a single distant call site.
- **Magnitude gate** — `OVERLAY_PRUNE_MAX` (default 25) plus a 50%-of-tracked-files ceiling. A `strip_prefix`/manifest bug that under-stages a target makes everything else look prunable; an anomalously large prune set is refused outright (printing the full candidate list) and requires an explicit, documented `OVERLAY_PRUNE_MAX=<n>` override after human review. The set is fully computed before any mutation, so there is no partial-delete window.

The pruned set is logged per `script-output-conventions` (`detail` / `VERBOSE` full listing, an `info` summary, `err` + full list on magnitude refusal). `overlay_prune_set` and `_in_list` are pure functions over on-disk fixtures, gated by the existing `--self-test` mode (`validate.sh`).

Why git-native over rsync: `git rm` is a single, well-specified, heavily-tested primitive that refuses paths outside the repo, has no macOS-vs-Linux behavioral divergence, and leaves the additive `rsync -a` copy (the part that already works) untouched.

### One-time remediation is separate and required

The durable fix prevents *future* staleness; it does **not** retroactively clean the existing drift. The `--changed` early-skip returns before the apply block whenever the mirror's recorded `source_sha` already postdates the upstream removal (which is *why* the files are stale), and every automated invocation passes `--changed` with no periodic full sync. The eight existing orphans across the two affected mirrors are therefore removed by a **one-time manual `git rm` + push** to each mirror — safe in any order relative to this fix, since current source lacks the files and no sync can re-add them.

## Consequences

- **Positive:** overlay mirrors no longer accumulate dead files removed upstream; the recurring staleness class (#813) is closed at the pipeline level; the prune is unit-tested and shellcheck-clean under the bash-3.2 floor.
- **Neutral:** `push_target` gained a bounded prune step that runs only under `--push`; a `--dry-run`-reachable preview is a tracked ergonomic follow-up (#836).
- **Accepted:** the primary safety relies on the invariant that packaging top-level names are never staged from `agent/extensions/<name>/`; the `OVERLAY_PROTECTED_TOPLEVEL` second gate exists precisely so a future violation of that invariant fails safe rather than deleting packaging. The static list must track new packaging file types the mirror overlay introduces (ADR-0042/0087).
