# Expertise native runtime pin

This directory pins the first candidate local-expertise native runtime
generation. It is installation input, not a claim that A2 or Linux ARM64
support is complete. The vendored surface and its committed test archive are
recorded in [ADR-0158](../../../adrs/0158-manifest-carried-vendored-runtime-generation.md).

`linux-arm64-v1.json` is a closed manifest for one generation:

- sqlite-vec `v0.1.9` (`vec0.so`), upstream tag commit
  `e9f598abfa0c06b328d8fe5da9c3760cce74be10`; the release archive digest and
  the independent extracted `vec0.so` digest were measured in the
  [A2 evidence](../../../notes/local-expertise-a2-feasibility.md).
- A recorded compatibility tuple: pi `v0.84.2-psmfd.1`, embedded Bun `1.3.10`,
  SQLite `3.51.2`. The installer records this tuple; it does not compare it to
  the running host. P4 enforces it.

This generation covers the sqlite-vec native artifact only. The wrapper,
launcher, worker, extension, and model closure that ADR-0157 assigns to the
installed generation remain P4 to P5 work.

## What the installer does

`scripts/install-expertise-runtime.py` (wrapped by
`scripts/install-expertise-runtime.sh`) installs byte copies; the generation
never symlinks into the repository or the download cache. It:

1. loads every `linux-arm64-v*.json` in this directory as the trusted set and
   targets the highest version;
2. acquires the release archive into
   `<passwd home>/.cache/agent-expertise/runtime-downloads/<sha256>-<asset>`
   with `curl` (HTTPS only, including redirects) unless a digest-matching
   copy is cached, and removes a cached copy whose digest does not match;
3. extracts exactly the manifest inventory into a private staging directory,
   validating member names, types, sizes, and digests as it goes;
4. validates the staged generation (type, owner, exact mode, link count, size,
   SHA-256, closed inventory, installed manifest bytes), fsyncs, and renames it
   into `generations/`;
5. writes the selector `current-generation` atomically. The selector is JSON:
   `{"schemaVersion":1,"generation":"<id>","manifestSha256":"<digest>"}`; the
   digest is the canonical trusted manifest's SHA-256.

A run against an existing valid generation revalidates it offline and does not
reacquire the archive. The installer refuses to select a generation older than
the one currently selected.

## Production use

```bash
scripts/install-expertise-runtime.sh                   # install or revalidate
scripts/install-expertise-runtime.sh --check-manifest  # validate manifests only
```

Prerequisites: `python3`, and `curl` for a first acquisition. The production
entry accepts no manifest, archive, root, or platform override. It derives the
account home from the operating-system user database, never from `HOME` or
`XDG_DATA_HOME`, and installs at
`<passwd home>/.local/share/agent-expertise/runtime`. Exit codes: 0 installed,
selected, or revalidated; 1 classified refusal; 2 configuration or environment
failure; 3 unexpected filesystem error.

## P4 private native preflight

`agent/extensions/shared/expertise-native-runtime.ts` is a shared library
module, not a pi extension. Its production initializer derives the passwd home,
validates the installed tree against the single code-owned policy
(`PRODUCTION_NATIVE_POLICY`, ADR-0159), and accepts no path, manifest, artifact,
generation, platform, runtime, or policy override. The installed selector and
manifest must hash to the digests that policy pins; the policy is a constant,
not a lookup keyed by the installed manifest. The running pi is identified by
the SHA-256 of the executable at `<passwd home>/.cache/pi_config/pi-<version>/pi/pi`.
`XDG_CACHE_HOME` is not consulted, so a host that relocates the pi cache fails
closed with `P4_RUNTIME_PI_PATH`.

Before Bun receives the canonical artifact path, it independently revalidates the
selector, closed generation inventory, path components, ownership, exact modes,
link counts, manifest and artifact digests, and the running pi/Bun/SQLite/glibc
tuple. Its bounded ELF parser requires ELF64 little-endian AArch64/System V, the
measured program-header profile, non-executable stack, no W+X load segment, no
interpreter, exact dynamic dependencies, no RPATH/RUNPATH/TEXTREL, and the exact
GLIBC symbol-version requirements measured from the pinned artifact.

The artifact is opened with `O_NOFOLLOW`, hashed and parsed from that descriptor,
then its pathname inode and metadata are rechecked immediately before Bun reopens
the path. This narrows but cannot eliminate ADR-0156's same-user pathname race.
The private initializer calls `Database.loadExtension()` once, verifies sqlite-vec
`v0.1.9`, and confirms SQL `load_extension()` remains unauthorized before and
after. It exposes no model-callable tool and opens no production expertise store.

## Manifest field contract

The installer enforces exact key sets; an unknown or missing key is a
configuration failure (exit 2).

| Field | Rule |
| --- | --- |
| `schemaVersion` | `1` |
| `generation` | `v<N>-linux-arm64-sqlite-vec-v<X.Y.Z>-<12 hex>`; the hex suffix is the first `files[]` entry's SHA-256 prefix. Any edit to a shipped manifest requires a new generation string; the installer refuses a manifest whose bytes differ from the installed copy under the same name (#1102 tracks binding the name to the whole manifest) |
| `platform` | exactly `{"os":"linux","arch":"arm64"}` |
| `compatibility` | `pi`, `bun`, `sqlite`: the installer records non-empty strings; P4 requires exact equality with its immutable code-owned policy and the running runtime |
| `source.url` | must begin with `https://github.com/asg017/sqlite-vec/releases/download/` |
| `source.asset` | one `.tar.gz` basename |
| `source.sha256` | 64 hex, the archive digest |
| `files[]` | non-empty; each entry has exactly `path`, `archivePath`, `sha256`, `size`, `mode`, `role`, `version` |
| `files[].path`, `files[].archivePath` | normalized POSIX relative paths, unique, no `..`, `.`, or empty components; a single leading `./` in the archive is accepted |
| `files[].mode` | `0600`, or `0700` only when `role` is `executable` |
| `files[].role` | `native-library`, `executable`, or `data` |

## Adding or bumping a generation

- Add a new `linux-arm64-v<N+1>.json`; never edit a shipped manifest.
- Vendor the exact release archive under `scripts/fixtures/p3-expertise-runtime/`
  so the required `validate.sh` stage `9b-p3` exercises the production manifest
  and bytes without network access, and record the digests you measured in
  the A2 evidence note.
- Add a bump-checklist row per `docs/vendor-updates.md` when the compatibility
  tuple changes.
- Replace the constants in `PRODUCTION_NATIVE_POLICY`
  (`agent/extensions/shared/expertise-native-runtime.ts`): generation, selector
  and canonical manifest digests, artifact digest and size, pi executable
  digest, glibc, and the ELF/dynamic profile measured with
  `readelf -h -l -d -V`. Update the byte offsets asserted in
  `scripts/fixtures/p4-native-preflight/probe-extension.mjs` and run the P4
  suite on Linux ARM64. A selector or manifest whose digest the policy does not
  pin fails closed.
- P4 refuses a `generations/` directory holding anything but the pinned
  generation, and the installer does not prune superseded generations. Resolve
  #1105 (with #1102) before a second generation ships.
- Before a second generation ships, add a revocation floor so a selector that
  names a superseded generation is not revalidated as trusted.

## Trust boundary

This is digest attestation, not same-user immutability. The operating user can
replace files and selectors; P4 revalidates drift and enforces path, ELF,
architecture, dynamic ABI, and compatibility checks before its one private
JavaScript load, and confirms SQL `load_extension()` stays denied before and
after it. Rejection legs run that preflight through a loader-free test seam;
the production entry's exact-once load, attempt latch, and denial checks are
exercised only by the Linux ARM64 production legs
(`scripts/fixtures/p4-native-preflight/README.md`). P5 adds final mutation
executors and Landlock confinement. See
[ADR-0156](../../../adrs/0156-capability-confined-native-expertise-loading.md),
[ADR-0157](../../../adrs/0157-provenance-checked-final-expertise-mutation-executors.md),
and [ADR-0159](../../../adrs/0159-code-owned-native-policy-pins-pi-executable-digest.md).

sqlite-vec is dual-licensed under Apache-2.0 or MIT; this repository takes it
under the MIT option. The pinned release artifact is fetched from the upstream
GitHub release URL recorded in the manifest. The digest was established by
measuring one download and comparing the extracted `vec0.so` against the A2
spike's independent measurement; upstream publishes no attestation to
cross-check.
