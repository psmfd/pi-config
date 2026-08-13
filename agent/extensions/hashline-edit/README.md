# hashline-edit

Hash-anchored `read`/`edit` (and optional `grep`) override for pi — the
Track 1.1 pilot of the local-first soak pipeline
([`notes/curated-feature-plan.md`](../../../notes/curated-feature-plan.md),
tracking issue #976,
ADR-0134 vendoring / ADR-0135 override design).

Every line the model sees via `read` carries a short content hash
(`LINE#HASH`, 2-char default). Edits anchor on those hashes instead of
`oldText` matching: a stale anchor is rejected with a structured re-read
hint rather than fuzzily relocated, and a snapshot-based three-way merge
recovers distant-drift cases without guessing. The design goal is fewer
failed-edit retry loops, which is where the upstream token savings actually
come from.

## Provenance

Vendored source from
[RimuruW/pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit)
**v0.8.3** (commit `ba7db994`, MIT — see `LICENSE.upstream`), itself derived
from oh-my-pi's hashline design. The pristine upstream snapshot is committed
at `upstream/pi-hashline-edit-v0.8.3-src.tar.gz` (sha256-pinned);
`scripts/validate-hashline-drift.sh` fails validation when the vendored
source drifts from `PATCH_MANIFEST.json`'s recorded state. Bump procedure:
fetch the new tag, re-apply the patch table below, regenerate the manifest,
and treat any change to `prompts/**` as a model-contract re-integration, not
a routine bump.

## Patch table (vs. pristine v0.8.3)

| # | Files | What and why |
|---|---|---|
| 1 | `src/merge.ts`, `src/edit-diff.ts`, `vendor/jsdiff/` | npm `diff` dependency replaced by the vendored jsdiff 8.0.2 UMD bundle (`diff.cjs`, BSD-3-Clause, sha256 in `vendor/jsdiff/CHECKSUMS`) behind a typed ESM wrapper — pi's jiti `tryNative:false` loader cannot import third-party npm packages (ADR-0099). `.cjs` extension forces CJS loading; the UMD wrapper defeats ESM named-export detection. |
| 2 | `src/hashline/hash.ts`, `vendor/xxh32.ts` | npm `xxhashjs` dependency replaced by a first-party canonical xxHash32 (reference-vector-tested). Hashes are session-ephemeral, so cross-implementation equality is not load-bearing. |
| 3 | `src/file-kind.ts`, `vendor/file-sniff.ts` | npm `file-type` dependency replaced by a minimal magic-byte sniffer (4 image types + common binary containers). Routing (text/image/binary) unchanged; unlisted binaries fall to the null-byte heuristic with a generic description. |
| 4 | `index.ts` | `PI_HASHLINE_EDIT=0` (or `false`) off-switch: leaves core `read`/`edit`/`grep` untouched for the session. |
| 5 | `src/edit.ts`, `src/containment.ts` | Workspace containment on the mutation path (pi_config addition, ADR-0135): the symlink-resolved target must stay inside the realpath'd session cwd, and `.git/**` writes are refused. Core-tool parity note: core `edit` has no such restriction; this extension is deliberately stricter. |
| 6 | `src/read.ts`, `src/grep.ts`, `src/edit.ts` | `@sinclair/typebox` import specifier → `typebox` (the name pi bundles and `extension-deps.sh` pins). |
| 7 | `src/fs-write.ts`, `src/edit.ts` | Repo lint/typecheck conformance under `noUncheckedIndexedAccess` + type-aware ESLint: one non-null assertion, two non-Error rethrow wraps, one redundant cast removed. No behavior change beyond non-Error rethrow values being wrapped in `Error`. |

## Env overrides (enumerated per extension conventions)

| Variable | Effect |
|---|---|
| `PI_HASHLINE_EDIT=0` | Disable the extension for the session (no overrides registered). |
| `PI_HASHLINE_ALLOW_OUTSIDE_CWD=1` | Permit mutation targets outside the session cwd (matches core `edit`'s permissiveness). |
| `PI_HASHLINE_ALLOW_GIT_WRITES=1` | Permit writes under `.git/` (refused by default). |
| `PI_HASHLINE_DEBUG=1` | Upstream: notify "Hashline Edit mode active" at session start. |

Upstream also reads an optional `hashline.json` (hash length, grep toggle,
replaceText toggle) — see `src/config.ts`.

## Refusal policy

- **Stale/unknown anchor** — hard rejection with a structured message
  (re-read hint, current-context snippet); never fuzzy relocation. A
  snapshot three-way merge (`fuzzFactor` 0) may transparently recover
  distant drift; on any ambiguity it fails closed to the rejection.
- **Containment breach** (`[E_CONTAINMENT]`) — outside-cwd or `.git/**`
  mutation targets are refused with the operator override named in the
  message. Read paths are never restricted.
- **No-op loops** (`[E_NOOP_LOOP]`) / **duplicate payloads**
  (`[E_DUPLICATE_EDIT]`) — escalating rejections that break model retry
  loops.

## secrets-guard interplay

This extension overrides the tool name `edit`, so `secrets-guard`'s
tool-call handler still fires; its `edit` branch understands both the core
shape (`edits[].newText`) and this extension's shape (`edits[].lines[]`,
`newText`, and the pre-normalization JSON-string dialect). Any change to the
edit input schema here MUST be mirrored in
`agent/extensions/secrets-guard/index.ts` (`checkWriteLikeCall`) and its
tests — see that README's "Tool-call coverage" section.

## Testing

`scripts/test-hashline-edit.sh` runs `test/*.test.ts` (node:test via pinned
tsx): xxh32 reference vectors, ported upstream hash/apply cases, three-way
merge through the vendored jsdiff, the magic-byte sniffer, containment
(including symlink escape and both overrides), and registration/off-switch.
The upstream vitest suite is not vendored — upstream CI validates the pinned
tag; this suite covers the patched integration surface.
