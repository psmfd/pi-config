---
status: Accepted
date: 2026-06-23
---

# ADR-0048: make scan-secrets repo-agnostic and shareable across repos

**Status:** Accepted
**Date:** 2026-06-23
**Related:** [ADR-0037](0037-secret-scanner-tooling-strategy.md) (gitleaks vendor pin / scanner tooling), [ADR-0011](0011-toolchain-install-strategy.md) (vendor+distro toolchain, `~/.local/bin` install pattern), [`scripts/scan-secrets.sh`](../scripts/scan-secrets.sh), [`scripts/lib/install-helpers.sh`](../scripts/lib/install-helpers.sh) (`_ih_link_local_bin`), psmfd/pi_config#393, psmfd/pi#34

## Context and Problem Statement

`scripts/scan-secrets.sh` was repo-local by construction: it anchored
`REPO_DIR` to its own location (`$(dirname "${BASH_SOURCE[0]}")/..`) and `cd`'d
there, so it could only ever scan pi_config itself. The `psmfd/pi` mirror — which
must run a gitleaks gate over each upstream-sync import range — had no scanner of
its own; its runbook (`.psmfd/sync-upstream.sh validate`) only emitted a manual
"run gitleaks yourself" warning. Other ecosystem repos face the same gap.

We want **one** scanner, version-pinned once, usable by pi_config, the mirror,
and future repos, with **each repo keeping its own `.gitleaks.toml`** (the
mirror's allowlists are deliberately different from pi_config's). Two sub-problems:

1. The scanner must target an arbitrary repository, not its own checkout.
2. The mirror's sync needs a **commit-range** scan (`OLD..NEW`), which the
   existing `--working-tree` / `--history` modes do not express.

## Considered Options

- **Per-repo copies of the script.** Rejected: copies drift silently; no single
  source of truth.
- **Git submodule / sourcing pi_config by path.** Rejected: heavy setup, couples
  consumers to a checkout location, fragile across machines and CI.
- **Parameterize the one script + install it once to `~/.local/bin`.** Chosen for
  the local/manual path — it reuses the existing `_ih_link_local_bin` mechanism
  already used for `gh`/`yq`/`shellcheck`, and the symlink targets the live repo
  file so `git pull` updates the tool.

For the **CI** delivery vehicle a different mechanism is required. Because
`psmfd/pi` is **public** and `pi_config` is **private**, a public repo cannot
consume a private repo's reusable workflow, so the mirror's CI cannot call a
pi_config-hosted reusable workflow. Instead the mirror runs a self-contained
`psmfd-secrets-scan.yml` that invokes a **pinned public container**
(`ghcr.io/gitleaks/gitleaks` by digest) over the push/PR commit range against the
mirror's own `.gitleaks.toml`. This ADR records that mirror-CI decision too — the
mirror cannot host its own ADRs (its `adrs/` path is not in the overlay
allowlist, so mirror-governance decisions live in pi_config, per the ADR-0045 /
ADR-0046 precedent); the operational rollout is tracked in psmfd/pi#34. The
vendored binary (this repo) and the mirror's CI image are pinned to the same
gitleaks version for coherence.

## Decision Outcome

Refactor `scan-secrets.sh` to be repo-agnostic and install it as a shared tool:

- **`--repo-dir DIR`** (default: `git -C "$PWD" rev-parse --show-toplevel`) —
  resolves the target repo from the invocation context, not the script location.
  This is what makes a single `~/.local/bin/scan-secrets` serve every repo.
- **`--config PATH`** (default: `<repo>/.gitleaks.toml` when present) — keeps each
  repo's config authoritative; falls back to gitleaks' built-in defaults.
- **`--range OLD..NEW`** — new mode built on `gitleaks git --log-opts`, with a
  full-clone guard and a null-`OLD` fallback (all-zero SHA → scan all history
  reachable from `NEW`, covering first-push / force-push bases).
- **`--self-test`** — hermetic assertions for the range / null-SHA parsing,
  gated by `validate.sh` so a parser regression is caught before scan time.
- Report cache is repo-scoped (`~/.cache/scan-secrets/<repo-slug>/`).
- Output follows the bracket-label / 0-1-2 exit-code convention; helpers are
  defined inline because the script runs standalone from `~/.local/bin`.
- `setup.sh` installs it via `_ih_link_local_bin`.

The 0/1/2 exit contract, redacted output, and the `--working-tree` / `--history`
behaviors are preserved unchanged, so existing callers are unaffected.

### Consequences

- **Good:** one scanner, one version pin, consumable everywhere; the mirror's
  manual gitleaks gate becomes a real `scan-secrets --range` call; per-repo
  config stays authoritative.
- **Trade-off:** consumers must have run pi_config's `setup.sh` (the same
  assumption already made for `gh`/`yq`). CI does not depend on the script — it
  uses the pinned container — so this assumption is local-only.
- **Follow-up:** keep the binary pin (ADR-0037) and the mirror's CI image digest
  on the same gitleaks version.
