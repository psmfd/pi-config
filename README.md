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

## First-party extensions

Five pi extensions are distributed as standalone mirrors and installed by
`install.sh`:

| Extension | What it does |
|---|---|
| [`pi-secrets-guard`](https://github.com/psmfd/pi-secrets-guard) | Blocks secrets from being written or surfaced |
| [`pi-bash-destructive-guard`](https://github.com/psmfd/pi-bash-destructive-guard) | Guards against destructive shell commands |
| [`pi-artifact-handoff`](https://github.com/psmfd/pi-artifact-handoff) | Stages large outputs for line-anchored human review before merge |
| [`pi-web-fetch`](https://github.com/psmfd/pi-web-fetch) | Allowlisted, auditable web fetch |
| [`pi-cache-meter`](https://github.com/psmfd/pi-cache-meter) | Measures prompt-cache hit ratio to diagnose context efficiency |

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
