---
status: Accepted
date: 2026-07-01
---

# ADR-0067: a secondary installer (`install-expertise.sh`) that wires the local expertise backend to pi

**Status:** Accepted
**Date:** 2026-07-01
**Related:** [ADR-0051](0051-sendable-one-shot-installer.md) (the primary `install.sh` this complements), [ADR-0028](0028-agent-expertise-api-client.md) (the `expertise-client` extension it wires), [ADR-0033](0033-codebase-indexing.md) (the indexing engine it bootstraps), [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the mirror that ships it), [ADR-0042](0042-standalone-extension-distribution.md) (the extension mirror it `pi install`s)

## Context and Problem Statement

`install.sh` (ADR-0051) takes a recipient from nothing to a working pi install:
pi + the generic config + the first-party extension mirrors, including
`pi-expertise-client`. But the expertise-client extension is only the *client
half*. After `install.sh` a recipient has the tool wiring but:

- no local `agent-expertise-api` service to talk to,
- no API key wired into the extension, so every expertise call refuses (ADR-0028
  requires a key for all calls), and
- the code-indexing engine (`cocoindex-code` / `ccc`, ADR-0033) is not installed
  — it is acquired out-of-band and is deliberately outside `setup.sh`'s fetch flow.

The maintainer asked for a *second* shareable installer that closes this gap:
stand up the local service surface of `agent-expertise-api` from public packages,
generate and wire the linkage, and install the pi dependencies that `setup.sh`
does not — specifically the code-indexing engine — so expertise (and semantic
code search) are ready to use after setup.

The upstream `agent-expertise-api` repo already ships the hard parts: a native
OS-service installer (`scripts/install.sh`, Archetype A2), a cosign-verified
release path (`--from-release`), a dependency bootstrap (`--install-deps`), a
control wrapper (`expertise-apictl`) that health-gates on `/health/ready`, and
migrations. Re-implementing any of that here would duplicate maintained,
security-reviewed upstream logic.

## Considered Options

1. **Document the manual steps** (clone the API repo, run its installer, hand-edit
   `secrets.env` for a dev auth mode, generate a key, copy it into the extension's
   `.env.local`, `pipx install cocoindex-code`). Rejected: high friction, and the
   manual key-copy step is exactly the error-prone wiring the request wants gone.
2. **Reimplement the service install in pi_config.** Rejected: duplicates the
   upstream signed-tarball install, migrations, and service-manager wiring, and
   re-solves the dependency-bootstrap problem upstream already owns.
3. **Compose stack.** Rejected for the default: the request was explicitly the
   *local service based surface* (A2 native service), not containers; Compose also
   pulls in Docker as a host dependency.
4. **A sendable `install-expertise.sh` that delegates to the upstream A2 installer
   and owns only the linkage + the pi-side indexing dependency.** Chosen.

## Decision Outcome

**Chosen: option 4** — a tracked, sendable `install-expertise.sh` at the repo
root, shipped in the `psmfd/pi-config` mirror alongside `install.sh`. It uses only
public packages (`psmfd/agent-expertise-api` releases, `psmfd/pi-expertise-client`,
PyPI `cocoindex-code`) and:

1. **Ensures the client extension** — `pi install git:github.com/psmfd/pi-expertise-client`
   if it is not already present (installed git extensions live at
   `~/.pi/agent/git/<host>/<owner>/<repo>`, where its `.env.local` must land).
2. **Generates the linkage and seeds it first** — writes a *managed block* into
   `secrets.env` (macOS config dir: `~/Library/Application Support/expertise-api/`;
   `~/.config` is upstream's Linux-only branch) setting
   `ASPNETCORE_ENVIRONMENT=Development`, `Auth__Mode=ApiKey`,
   `Auth__ApiKey=<openssl-generated key>`, plus `Onnx__ModelPath`/`Onnx__VocabPath`
   pinned to the macOS config-dir layout — **before** delegating. The ordering is
   load-bearing (proven by the 2026-07-03 live validation): upstream's installer
   runs `migrate.sh`, which boots the full host and aborts on the
   `Auth:Mode=Oidc` issuers guard unless the override is already in the file.
   The ONNX path pins work around upstream migrate.sh deriving them from a
   Linux-only `PREFIX` default (`~/.local/share`) when invoked without
   `--prefix`; without them `IEmbeddingGenerator` is silently never registered
   on macOS, which is fatal under Development because that environment enables
   eager DI validation (`ValidateOnBuild`).
   Pre-seeding also means launchd's first service start is healthy (no crash-loop
   window) and the key never transits any process environment. Upstream preserves
   an existing `secrets.env` (stub creation skips) and appends its generated DB
   connection string to it only when absent, so seeding first is safe.
3. **Delegates the service stand-up** — clones `agent-expertise-api` at a pinned
   release (default: latest published) and runs its
   `scripts/install.sh --from-release --version <v> --install-deps --bind 127.0.0.1:8080`;
   then restarts via `expertise-apictl` (health-gated, confirming the running
   service reflects `secrets.env`) and writes the same key into the extension's
   `.env.local`.
4. **Bootstraps the indexing engine** — Python ≥3.11 + pipx, then
   `pipx install 'cocoindex-code[full]==<pin>'`, pinned to the version vendored at
   `agent/vendor/cocoindex-code/VERSION` (ADR-0033's single source of truth).

### Local auth posture

The API defaults to `Auth:Mode=Oidc`, which requires an identity provider — not
"ready to go" for a solo local install. The runtime guard permits non-OIDC modes
**only in Development**, so the linkage sets `ASPNETCORE_ENVIRONMENT=Development`
and `Auth:Mode=ApiKey` (the least-privilege dev mode — pure key scheme, no JWT or
LocalDev acceptance). This is the explicit local-only tradeoff the hosting note
(`notes/agent-expertise-api-hosting.md`) flagged as an ADR decision: acceptable
because the bind is loopback-only (enforced here and by ADR-0028), the key is
generated per-install and never echoed, and both `secrets.env` and `.env.local`
are mode 600. It is a Development posture by construction, not a production one. The loopback
check is a strict IP-literal / `localhost` match with a numeric port — deliberately
not a prefix glob, since a hostname merely starting with `127.` (e.g.
`127.0.0.1.attacker.tld`) is treated by Kestrel as a non-literal host and bound as
a wildcard across all interfaces, which would void this control.

### Idempotency and key stability

Re-runs reuse the existing key (parsed back from `secrets.env`) so the extension
stays wired; `--rotate-key` forces a fresh key and re-writes `.env.local`. The
managed block is delimited by markers and rewritten in place, so re-runs never
duplicate it or disturb the operator-owned connection string.

### Scope: macOS-first

The upstream `--install-deps` path is macOS-only today (Homebrew; upstream
`agent-expertise-api#246`/`#247` track Debian/RHEL). On non-macOS hosts the script
`SKIP`s the API stand-up and the indexing bootstrap with a pointer to
#485, which tracks Debian-first
Linux parity (bootstrapping the deps via `apt` ourselves, then delegating the
service install) and a Windows PowerShell peer. The linkage logic is
platform-agnostic; only dependency bootstrap and service-manager specifics differ.

## Consequences

- **Good:** one command turns a fresh `install.sh` install into a working
  expertise + semantic-code-search setup; no manual key copying; upstream owns the
  signed install, migrations, and service wiring; the indexing pin stays in one
  place.
- **Good:** auditable sendable file (no `curl | bash`), consistent with ADR-0051.
- **Bad / accepted:** macOS-only for now (#485); the Development/ApiKey posture is
  a deliberate local-only tradeoff, unsuitable for shared or non-loopback use.
- **Follow-up:** #485 (Linux/Windows parity). Model prefetch is opt-in
  (`--first-index`); by default the ~90 MB embedding model pulls on the indexing
  extension's first background re-index.
</content>
