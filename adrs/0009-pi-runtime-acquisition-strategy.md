# ADR-0009: Pi runtime acquisition strategy — pin and fetch upstream release binary

**Status:** Accepted (consumption live as the default install path per [ADR-0012](0012-vendored-pi-default.md); the legacy `npm install -g` flow remains available behind `PI_USE_VENDORED=0`)
**Date:** 2026-05-19
**Related:** [ADR-0001](0001-subagent-orchestration-substrate.md) (parallel decision — vendoring extensions we patch; not superseded); [ADR-0010](0010-setup-install-trust-posture.md) (consumes this ADR's `fetch_pi_binary()` library through `setup.sh`)

## Context and Problem Statement

`pi_config` currently bootstraps pi by installing the published npm package globally: `setup.sh` runs `npm install -g @earendil-works/pi-coding-agent`. This requires `node` and `npm` on the host (today gated by a hand-installed Node 20+ runtime; the dependency installer rework in [#102](https://github.com/TheSemicolon/pi_config/issues/102) tightens that to `nvm`-managed Node 24.x) and yields a globally-installed `pi` whose version is whatever was current at install time, with no pin and no checksum verification.

Three concerns motivate a different acquisition strategy:

1. **No pin.** `npm install -g @earendil-works/pi-coding-agent` produces non-reproducible installs. A reinstall a day later picks up a different `pi`. The repo carries no record of which pi version a given commit was authored against, which complicates bug attribution and bisect.
2. **No verification.** The npm install path trusts the registry chain end-to-end. We have no in-repo artifact attesting "this is the pi binary we expect to be running."
3. **"Fully built" intent.** The desired contributor experience is `git clone && ./setup.sh` on a fresh machine, with `pi` running afterward. The npm path requires node + npm + registry access + global-install permissions; the binary path requires only `curl + tar + sha256sum`, all coreutils.

A 3-replica `pi-agent-expert` consensus round (per [ADR-0004](0004-consensus-by-replication.md)) evaluated whether to vendor pi *source* (analogous to our vendored `subagent` extension under ADR-0001) or to vendor a release-binary pin. Unanimous outcome: source vendoring is **feasible-but-not-advised** (release cadence ≈ 3 patch releases per day, ~80 transitive deps including 18 prebuilt `koffi` platform triples and WASM blobs, ~150–300 MB on-disk if `node_modules/` were committed); binary-pin-and-fetch is **feasible-and-advised** and is the canonical "fully built" answer pi itself ships via `bun build --compile`.

Full research transcript and aggregate findings recorded in [#103](https://github.com/TheSemicolon/pi_config/issues/103).

## Considered Options

* **Option A** — **Status quo: `npm install -g @earendil-works/pi-coding-agent`** with no pin, no verification, dependency on global node + npm.
* **Option B** — **Vendor pi source** (commit `dist/` + `package.json` + `node_modules/` into `agent/vendor/pi/`), analogous to the `subagent` extension snapshot under ADR-0001.
* **Option C** — **Pin and fetch upstream release binary.** Commit `agent/vendor/pi/{VERSION,CHECKSUMS,README.md}`; `setup.sh` (via a sourceable library function) downloads the matching per-platform archive from `https://github.com/earendil-works/pi/releases/`, verifies sha256 against the in-repo `CHECKSUMS`, extracts to a cache directory, symlinks `bin/pi`.
* **Option D** — **Build pi binaries ourselves in CI** from the upstream `pi-mono` monorepo and publish to our own release surface.

## Decision Outcome

Chosen option: **C — pin and fetch upstream release binary**.

`earendil-works/pi` publishes per-platform Bun-compiled binaries on GitHub Releases (verified `v0.75.3` against the live API): six assets covering `{darwin,linux,windows} × {arm64,x64}`, each carrying a `digest: sha256:...` field exposed via the REST/GraphQL API. The digests are authoritative for our checksum file — no separate `SHA256SUMS` artifact needed.

The implementation lives at:

```text
agent/vendor/pi/
├── VERSION             # single line, e.g. "v0.75.3" (tag form)
├── CHECKSUMS           # sha256  filename pairs, one per platform asset
└── README.md           # pin provenance + bump procedure + license/redistribution posture

scripts/lib/fetch-pi-binary.sh   # sourceable POSIX-sh; provides fetch_pi_binary()
scripts/validate-pi-vendor.sh    # validator wired into scripts/validate.sh
```

`fetch_pi_binary()`:

1. Reads `agent/vendor/pi/VERSION` (tag form, e.g. `v0.75.3`).
2. Detects host triple via `uname -ms` → `pi-{linux,darwin}-{arm64,x64}.tar.gz`.
3. Downloads `https://github.com/earendil-works/pi/releases/download/<tag>/<asset>` if not already cached.
4. Verifies sha256 against the in-repo `CHECKSUMS` (mandatory; no skip flag).
5. Extracts to `~/.cache/pi_config/pi-<tag>/`.
6. Emits the absolute path to the binary on stdout for the consumer to symlink.

The consumer in this PR is the `--self-test` mode of the library script itself. The production consumer — `setup.sh`'s `fetch_pi_binary()` call gated on `PI_USE_VENDORED=1` — lands in [#102](https://github.com/TheSemicolon/pi_config/issues/102). The deprecation of the npm path once the vendored path is validated by ≥1 non-author install is tracked in [#107](https://github.com/TheSemicolon/pi_config/issues/107).

### Relationship to prior decisions

This ADR **does not supersede** [ADR-0001](0001-subagent-orchestration-substrate.md). ADR-0001 governs vendoring of *extensions we patch* (a fork concern with a patch zone we own); pi core is unpatched-upstream and this is a *distribution* concern (acquiring the upstream artifact reproducibly). The two decisions are orthogonal and coexist:

| Surface | Vendoring shape | Governing ADR |
|---|---|---|
| `agent/extensions/subagent/` | Source snapshot with local patches | ADR-0001 |
| `agent/vendor/pi/` | Tag-and-digest pin; binary fetched at install time | ADR-0009 |

The two pins should usually track each other (a subagent extension snapshot from pi N.M.P should pair with a pi runtime pin to N.M.P). At time of authoring, the subagent extension is pinned at `0.74.0` and re-verified clean against `0.75.3` (PR #104); the runtime is pinned to `v0.75.3`. Future bumps should consider both pins together. Mismatch is not an error per se — the subagent extension's contract is the public extension API, not the internal `dist/` shape — but a mismatch wider than one or two minor versions warrants an audit.

### Tradeoffs

* Good: Reproducible installs — `VERSION` + `CHECKSUMS` pin the runtime exactly. Two installs of the same commit yield byte-identical `pi` binaries.
* Good: Verification before execution — sha256 check is mandatory and runs before the binary is symlinked into a path used by `setup.sh`.
* Good: Removes `node` and `npm` as `setup.sh` runtime prerequisites for the pi binary itself (node is still useful for many extensions, but pi-the-binary doesn't need it).
* Good: Repo size unchanged. Binaries live in `~/.cache/pi_config/` per XDG conventions; only ~0.5 KB of `CHECKSUMS` + one line of `VERSION` are committed.
* Good: License posture is thin — we *fetch* binaries at install time, we do not *redistribute* them. No third-party NOTICE aggregation obligation.
* Good: Bump procedure is mechanical and reviewable (single-commit `VERSION` + `CHECKSUMS` change visible in PR diff).
* Bad: Adds a network dependency at `setup.sh` time. Mitigated by cache reuse on repeat installs; first-time install on an air-gapped box still requires offline asset placement (documented in vendor README).
* Bad: GitHub Releases bandwidth is the single point of availability. If `earendil-works/pi` releases go away, our install path breaks. Mitigation: the pinned VERSION + CHECKSUMS lets a future operator drop a manually-obtained matching binary into the cache and have the verification step accept it.
* Bad: Per-platform asset matrix is upstream's; if upstream stops publishing a triple we use, our `fetch_pi_binary()` for that triple breaks. Mitigation: bump procedure includes verifying that all expected triples are still present in the new tag's asset list.
* Bad: Windows-host support is deferred. The fetch script understands `pi-windows-{arm64,x64}.zip` exists but exits with a clear error on Windows hosts until `setup.sh` itself grows Windows/WSL support (per #99's existing scope carve-out).

## Bump procedure (canonical)

1. Pick the new pi version (tag form, e.g. `v0.76.0`).
2. Verify all expected assets exist: `gh release view <tag> --repo earendil-works/pi --json assets -q '.assets[].name'` should list six entries covering the `{darwin,linux,windows} × {arm64,x64}` matrix.
3. Refresh the checksum file:

   ```sh
   gh release view <tag> --repo earendil-works/pi --json assets \
     -q '.assets[] | "\(.digest|sub("sha256:";""))  \(.name)"' \
     > agent/vendor/pi/CHECKSUMS
   ```

4. Update `agent/vendor/pi/VERSION` to the new tag.
5. Smoke test: `scripts/lib/fetch-pi-binary.sh --self-test` on the host. The produced binary's `pi --version` should match (or be consistent with) the new pin.
6. Consider whether the `agent/extensions/subagent/` snapshot should re-pair (see Relationship to prior decisions above); audit per `subagent/README.md`'s procedure if so.
7. PR with the `VERSION` + `CHECKSUMS` diff, conventional commit `chore(vendor): bump pi runtime to <tag>`, full smoke-test output in the PR body.

## Consequences

* Future PRs that change `agent/vendor/pi/VERSION` must update `CHECKSUMS` in the same commit; `scripts/validate-pi-vendor.sh` enforces structural consistency (file existence, expected platform set, line format).
* The npm install path remains in `setup.sh` during rollout, gated such that `PI_USE_VENDORED=1` is the opt-in. Default flip and eventual removal of the npm branch are tracked in #107.
* **Status update (2026-05-20):** the default-flip landed in #107 / [ADR-0012](0012-vendored-pi-default.md). The vendored path is now the default; the npm path is preserved indefinitely as the explicit `PI_USE_VENDORED=0` opt-out. No removal is scheduled.
* The cache directory `~/.cache/pi_config/` is now a documented surface; `setup.sh` MUST NOT place files outside it for the binary acquisition path.
* Air-gapped installs are documented as a known limitation, with the workaround (manually drop matching archives into the cache; verification still succeeds against committed checksums) recorded in `agent/vendor/pi/README.md`.

## More Information

Research transcript and the live-API checksum verification that informed this decision are recorded in [#103](https://github.com/TheSemicolon/pi_config/issues/103). Empirical basis for the subagent-extension parallel decision is in [ADR-0001](0001-subagent-orchestration-substrate.md). Followups: [#102](https://github.com/TheSemicolon/pi_config/issues/102) (setup.sh integration) and [#107](https://github.com/TheSemicolon/pi_config/issues/107) (npm-path deprecation).
