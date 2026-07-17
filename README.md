# pi-config

[**pi**](https://github.com/earendil-works/pi) is an AI coding agent — a terminal
CLI from earendil-works that runs LLM coding sessions in your shell. **pi-config**
is a curated, public distribution of an orchestration configuration for it: a
layered set of domain sub-agents, on-demand skills, behavioral rules, and safety
guardrails that turn a stock pi install into an opinionated, multi-agent
engineering assistant.

> **This is a derived mirror.** It is a wholly-generated, curated subset of a
> private source-of-truth repository, published so the configuration can be
> cloned and installed. The first-party extensions ship from their own mirrors
> (below). The source repository and exact commit for the current state are
> recorded in [`.mirror-provenance`](.mirror-provenance) (a plain-text file at
> the repo root).

## What you get

After install, `pi` is ready to use from your terminal with the full
orchestration config active:

- **The pi runtime** — fetched from the independently rebuilt, **attested**
  `psmfd/pi` release and sha256-verified before use (see [Provenance](#provenance-and-trust)).
- **A developer toolchain** — `gh`, `yq` (mikefarah), `shellcheck`, `gitleaks`,
  `jq`, `yamllint`, `markdownlint-cli2`, and Node.js 24 via `nvm`. Vendored tools
  are sha256-verified and install per-user (no `sudo`).
- **Orchestration config** — domain sub-agents (AWS, Azure, Docker, Terraform,
  Ansible, .NET, shell, security review, and more), on-demand skills, and
  behavioral rules, all loaded by pi only when needed.
- **Safety guardrails** — secrets and destructive-command guards, a GitHub
  identity guard, and more, delivered as the pi extensions listed below.

## Requirements

- **macOS** or **Debian/Ubuntu Linux**.
- **`git`** and **`bash`** already installed. `setup.sh` installs everything else
  (Node, the toolchain, the pi runtime) per-user.
- A few tools (`jq`, `yamllint`) install via the system package manager and are
  **opt-in** behind `PI_ALLOW_SUDO_APT=1` — `setup.sh` never uses `sudo` unless
  you ask it to.

## Quickstart

Always preview first — every install command supports `--dry-run`, which prints
exactly what it would do and changes nothing.

### One-shot install (recommended)

Fetch and run the installer; it clones this mirror, runs `setup.sh`, and installs
the first-party extensions from their own public mirrors:

```bash
curl -fsSL https://raw.githubusercontent.com/psmfd/pi-config/main/install.sh -o install.sh
bash install.sh --dry-run        # preview
bash install.sh                  # or: --dir ~/pi-config to choose the location
```

This mirror ships **generic config only** — no maintainer personalizations.

By default `install.sh` installs the **latest release tag** (a coherent, reviewed
snapshot whose extension pins match the config). Pass `--ref main` for the
bleeding-edge integration branch, or `--ref vX.Y.Z` to pin an exact release.

### Manual install

```bash
git clone https://github.com/psmfd/pi-config ~/pi-config
cd ~/pi-config && ./setup.sh --dry-run    # preview, then drop --dry-run to install
```

`setup.sh` is idempotent. It installs `nvm` + Node.js 24, fetches and
sha256-verifies the developer toolchain, installs the pi runtime, seeds config
from templates, and symlinks `~/.pi` to the clone. See [`setup.sh --help`](setup.sh)
for the full flag and environment-variable list (skip phases, `sudo` gates, an
npm-install opt-out, and more).

## Updating

Once installed, update from **inside your clone** with the shipped `update.sh`:

```bash
cd ~/pi-config        # or wherever you installed it
./update.sh --check   # report installed vs latest release; changes nothing
./update.sh           # update to the latest release
```

`update.sh` resolves the latest release tag, updates the clone, and re-runs the
installer so the pi runtime and extension pins move together — you don't re-run
`install.sh` yourself (a saved copy carries stale extension pins). It refuses to
run if you have uncommitted edits to tracked files (pass `--force` to override);
your live `agent/settings.json` and `agent/models.json` are never touched.

- **Preview:** `./update.sh --dry-run` prints what it would do.
- **Roll back / pin:** `./update.sh --ref v1.17.0` moves to a specific release.
  An explicit `--ref` is what authorizes a downgrade; without it, `update.sh`
  refuses to move to an older version.
- **Release notes:** the update prints the GitHub Release URL for the target tag
  and the commit range since your previous version.

## Verifying a release

Release tags are **SSH-signed** and releases are **immutable** (their tag→commit
binding is locked server-side). `update.sh` verifies the tag signature
**fail-closed** before applying an update, and `install.sh` verifies it
best-effort at first install — both need only `ssh-keygen` (ships with OpenSSH).

To verify a tag yourself, add the published release-signer key to an
allowed-signers file and run:

```bash
# key published in the release notes / this repo's scripts/lib/release-signers.txt
echo 'pi-config-release ssh-ed25519 AAAA... pi-config-release' > /tmp/pi-signers
git -C ~/pi-config -c gpg.format=ssh \
    -c gpg.ssh.allowedSignersFile=/tmp/pi-signers verify-tag vX.Y.Z
```

A `Good "git" signature` result confirms the release was signed by the pi-config
release key and its content is intact. See ADR-0087 for the trust model and its
documented residual risks.

## First-party extensions

Twelve pi extensions are distributed as standalone mirrors and installed by
`install.sh`:

| Extension | What it does |
|---|---|
| [`pi-secrets-guard`](https://github.com/psmfd/pi-secrets-guard) | Blocks secrets from being written or surfaced |
| [`pi-bash-destructive-guard`](https://github.com/psmfd/pi-bash-destructive-guard) | Guards against destructive shell commands |
| [`pi-artifact-handoff`](https://github.com/psmfd/pi-artifact-handoff) | Stages large outputs for line-anchored human review before merge |
| [`pi-web-fetch`](https://github.com/psmfd/pi-web-fetch) | Allowlisted, auditable web fetch |
| [`pi-cache-meter`](https://github.com/psmfd/pi-cache-meter) | Measures prompt-cache hit ratio to diagnose context efficiency |
| [`pi-token-meter`](https://github.com/psmfd/pi-token-meter) | Per-session, per-model token-usage counter (totals + cost by model, including subagents) |
| [`pi-gh-identity-guard`](https://github.com/psmfd/pi-gh-identity-guard) | Blocks mutating `gh`/`git push` when the active GitHub identity is wrong for the repo |
| [`pi-compaction-optimizer`](https://github.com/psmfd/pi-compaction-optimizer) | Deterministic context-compaction summaries with a local pre-compaction snapshot archive |
| [`pi-expertise-client`](https://github.com/psmfd/pi-expertise-client) | Local loopback client for a developer's agent-expertise-api (search + create) |
| [`pi-indexing`](https://github.com/psmfd/pi-indexing) | Semantic codebase search (cocoindex-code) with idle-gated background re-indexing |
| [`pi-context-manager`](https://github.com/psmfd/pi-context-manager) | Cache-safe, zero-token context pruning of oversized tool results |
| [`pi-auto-router`](https://github.com/psmfd/pi-auto-router) | Per-prompt model selection plus deterministic matrix status, review, and explicit refresh |

Capability policy remains human-reviewed and is never written by routing. The
standalone auto-router mirror publishes the complete
[matrix lifecycle and JSON v1 contract](https://github.com/psmfd/pi-auto-router/blob/main/MATRIX_LIFECYCLE_V1.md),
including snapshot hashes/generations, inert rows, registry reload guidance,
review proposals, and source-control validation.

## Provenance and trust

Running an install script is a trust decision, so the supply chain is explicit:

- **Wholly derived, recorded:** this mirror is regenerated from the private
  source on each release; the source repository and commit SHA for the current
  state are in [`.mirror-provenance`](.mirror-provenance).
- **Attested runtime:** the pi runtime is rebuilt from source in `psmfd`-controlled
  workflows and the resulting binary is cryptographically attested before use,
  rather than pulled from an unverified third party (ADR-0038). Each mirror sync
  records its source commit (ADR-0050). Full rationale is in the mirror's
  [Architecture Decision Records](adrs/).
- **Verified tooling:** vendored binaries are pinned and sha256-verified at
  install time; this public repository is scanned by GitHub CodeQL.

## Contributing

This repository is a **derived artifact**: its content is generated from a
private source, and a direct push here is overwritten on the next sync. So:

- **Report issues** — bugs, install failures, or documentation gaps — on this
  repository's issue tracker. That is the right place; they are triaged and fixed
  upstream, then flow back here on the next release.
- **Pull requests** against this mirror cannot land directly (the next sync would
  overwrite them). Open an issue instead; the maintainer actions accepted changes
  in the upstream source.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 TheSemicolon.
