---
status: Accepted
date: 2026-07-10
---

# ADR-0088: Cross-extension import boundary — shared `secret-scan`, and a fail-closed gate against unresolvable cross-extension imports

**Status:** Accepted
**Date:** 2026-07-10
**Closes:** #635
**Amends:** [ADR-0071](0071-secret-pattern-lockstep-reconciliation.md) — relocates one of its three enumerated lockstep copies (the TS pattern set) from `expertise-client/lib/secret-scan.ts` to `shared/secret-scan.ts`. ADR-0071's substantive decision (reconcile the pattern set, enforce three-copy lockstep) stands unchanged; only the file path of the TS copy moves, so this amends rather than supersedes.
**Related:** [ADR-0042](0042-standalone-extension-distribution.md) (the standalone-mirror exclusion that made the import unresolvable — the root cause), [ADR-0065](0065-inline-shared-modules-for-coupled-extension-mirrors.md) (the `../shared/` inlining this fix uses and the resolution-check this gate generalizes), [ADR-0030](0030-shared-foundation.md) (the `shared/` foundation the pattern set moves into)

## Context and Problem Statement

`pi` failed to load on every distributed install of v1.19.0:

```text
Cannot find module '../expertise-client/lib/secret-scan.ts'
from '.../agent/extensions/expertise-indexer/canonicalize.ts'
```

`expertise-indexer` ships **inside** the config mirror (it is not in the
`pi-config` target's `exclude:` list) but hard-imported `scanRawString` from
`../expertise-client/lib/secret-scan.ts` at two sites (`canonicalize.ts:61`,
`candidate-gate.ts:35`). `expertise-client` is **excluded** from the config
mirror (ADR-0042: distributed as its own `psmfd/pi-expertise-client` overlay
mirror, `pi install`ed to `agent/git/.../pi-expertise-client/`, never a sibling
under `agent/extensions/`). The relative sibling import resolves in the dev
monorepo (both are siblings) but is unresolvable in every distributed layout, so
the extension — and, via `subagent`'s import of `expertise-indexer`, the whole
load — fails.

Two distinct defects: (1) the specific coupling, and (2) the absence of any gate
that would catch it — ADR-0065's fail-closed resolution check only covers
`../shared/` imports, so a `../<other-extension>/` import into an excluded
extension shipped unchecked.

A prior inline comment (`secret-scan.ts:102-105`) had deliberately kept
`scanRawString` out of `shared/` to avoid "a fourth lockstep site." That comment
is inline rationale, not an ADR, and its premise is a miscount: relocating the
existing TS copy is a **move**, not a new copy — the lockstep-site count stays at
three.

## Considered Options

| Option | Verdict |
|---|---|
| **Move `scanRawString`+`SECRET_PATTERNS` to `shared/secret-scan.ts`; both extensions import from `../shared/`; add `inline: [secret-scan]` to `pi-expertise-client`** | **Chosen.** DRY; resolves in the config mirror (`shared/` ships there) and in the standalone mirror (ADR-0065 inlining). A move, so the lockstep-site count stays three (bash hook + `secrets-guard/index.ts` + `shared/secret-scan.ts`). |
| Duplicate `scanRawString` into `expertise-indexer` with a lockstep comment | Rejected. Localized, but genuinely adds a **fourth** lockstep copy (the exact thing ADR-0071 avoided) and a fourth `validate.sh §6b-bis` entry. |
| Generalize the ADR-0065 inline mechanism to inline arbitrary cross-extension imports | Rejected. Over-general; encodes a cross-extension dependency as supported rather than removing it. |

## Decision Outcome

1. **Move** `SECRET_PATTERNS` + `scanRawString` from
   `expertise-client/lib/secret-scan.ts` into
   `agent/extensions/shared/secret-scan.ts` (a self-contained module, no
   imports). `expertise-client/lib/secret-scan.ts` keeps its `CreateParams`-shaped
   `scanForSecrets`/`collectStrings`, importing `SECRET_PATTERNS` from
   `../../shared/secret-scan.ts`. `expertise-indexer`'s two call sites import
   `scanRawString` from `../shared/secret-scan.ts`.
2. **Add `inline: [secret-scan]`** to the `pi-expertise-client` target so its
   standalone overlay mirror inlines the module (ADR-0065) — without this the
   fix would merely relocate the same unresolvable-import failure into that
   mirror.
3. **Repoint `validate.sh §6b-bis`** to `shared/secret-scan.ts` as the canonical
   TS lockstep copy (a path swap; still three sites).
4. **Add a fail-closed systemic gate** against unresolvable cross-extension
   imports, in two layers:
   - `validate.sh §6b-quater` (dev-time, pre-merge — catches it earliest): for
     every `../<dir>/*.ts` import in a tracked extension file, resolve it by real
     path; fail if the importing extension is config-mirror-shipped and the
     target extension is excluded (or if the importer is itself an
     excluded/standalone extension, which never co-ships a sibling). `../shared/`
     and same-extension imports are exempt. Path resolution is by `cd`+`pwd`, not
     slug matching, so same-extension `test/ -> ../lib/x.ts` imports do not
     false-positive.
   - `sync-mirror.sh` `verify_no_orphan_cross_imports` (release-time backstop):
     over the staged tree for both modes, fail if any non-`shared/` `../<dir>/`
     import does not resolve to a file present in the stage.

## Consequences

**Positive:**

- Fixes #635 — pi loads on distributed installs again.
- The gate makes this failure class impossible to reship: it fails on the current
  (pre-fix) code and passes after the fix, and guards every future
  shipped-extension import.
- `scanRawString` is now genuinely shared (it was already called "the shared
  scanRawString gate" in the code) without increasing lockstep sites.

**Negative / accepted:**

- `pi-expertise-client` now carries an inlined `shared/` closure (one small
  module) — the established ADR-0065 cost.
- The `secret-scan.ts:102-105` rationale is reversed; ADR-0071 is amended for the
  TS-copy location (its three-site lockstep model is otherwise preserved).

## Doc-Impact

- `agent/extensions/shared/secret-scan.ts` (new), `expertise-client/lib/secret-scan.ts`
  (trimmed), `expertise-indexer/{canonicalize,candidate-gate}.ts` (repointed).
- `mirror/targets.yml` (`inline: [secret-scan]`), `scripts/validate.sh` (§6b-bis
  path + new §6b-quater), `scripts/sync-mirror.sh` (backstop + self-test).
- `agent/extensions/shared/README.md`, `agent/extensions/expertise-indexer/README.md`,
  `docs/outbound-mirror-sync.md`, `CONTRIBUTING.md` (Validation section), README
  ADR index.
