---
status: Accepted
date: 2026-06-24
---

# ADR-0049: ship runtime config as `*.example.json` templates; gitignore the live files and seed on install

**Status:** Accepted
**Date:** 2026-06-24
**Related:** [ADR-0013](0013-distribution-substrate-strategy.md) (distribution substrate — this removes a personalization leak from any substrate that ships the repo), [ADR-0026](0026-copilot-models-forward-fix-via-models-json.md) (the `models.json` forward-fix registry whose generic form becomes the template), [ADR-0010](0010-setup-install-trust-posture.md) / [ADR-0012](0012-vendored-pi-default.md) (`setup.sh` install posture this seeding step joins)

## Context and Problem Statement

`agent/settings.json` and `agent/models.json` were tracked in the repo. Because
`setup.sh` symlinks the whole repo to `~/.pi`, those tracked files are the live
runtime config — so every operator's edits (default provider, default model,
enabled models, theme) churn the working tree, and any clone or template
instantiation inherits whoever-committed-last's personal choices.

Two concrete problems:

- **Personalization leak.** The committed `settings.json` carried a specific
  provider/model and an `enabledModels` list assuming a particular account's
  Copilot entitlements. A recipient of the repo (via the GitHub-Template path of
  ADR-0013, or the forthcoming public distribution mirror) would inherit those
  rather than start from a neutral default.
- **Permanent working-tree churn.** The maintainer's live config (e.g. a local
  MLX provider/model and a theme) shows as an uncommitted modification forever,
  obscuring real diffs and risking an accidental `git add -A` of personal config.

`models.json` is a near-degenerate case: its committed form is already generic
(`{"providers": {}}` plus the ADR-0026 forward-fix documentation), but it shares
the same churn problem the moment an operator adds a provider entry.

## Considered Options

1. **Keep tracking the live files.** Status quo. Rejected: it is the source of
   both problems above; no amount of `.gitignore`-free convention stops the leak.
2. **Track `*.example.json` templates; gitignore the live files; seed on install.**
   The repo carries `agent/settings.example.json` (a starter template that
   already existed) and `agent/models.example.json` (new). The live
   `agent/settings.json` / `agent/models.json` are gitignored and
   operator-owned. `setup.sh` copies a template to its live path on first
   install if the live file is absent, and never overwrites an existing live
   file. Chosen.
3. **Generate config interactively at install time.** A prompt-driven wizard.
   Rejected: overkill for two files, adds a non-TTY/CI code path, and pi's own
   `/login` + settings UI already own provider/model selection after first run.

## Decision Outcome

**Chosen: option 2.**

- **Templates tracked:** `agent/settings.example.json` (the pre-existing starter
  template — `github-copilot` default provider/model, `compactionOptimizer:
  hybrid`, a `ghIdentityGuard.expectedIdentity` placeholder for the recipient to
  fill, and a small `enabledModels` set; it carries no operator-specific live
  state) and `agent/models.example.json` (new; verbatim the generic committed
  `models.json` — `{"providers": {}}` plus the ADR-0026 forward-fix docs).
- **Live files gitignored:** `agent/settings.json` and `agent/models.json` are
  added to `.gitignore`. They are operator-owned; their content (provider, model,
  theme, registered Copilot models) never enters version control.
- **Seeding (`setup.sh` §2c):** for each of `settings` / `models`, if the live
  file is absent, copy `<name>.example.json` → `<name>.json`. An existing live
  file is left untouched — operator config always wins. The step is `--dry-run`
  aware and emits convention-shaped `OK`/`WARN`/`INFO` lines.
- **Validation:** `validate.sh` gains a guard that both `*.example.json`
  templates exist (and `settings.example.json` parses as strict JSON; the
  JSONC `models.example.json` is checked for presence), and that the live
  `*.json` files are not tracked — so the seed source cannot silently rot nor
  the live files re-enter version control.

### Consequences

- Good: a fresh checkout/clone/template/mirror starts from a neutral, working
  config with zero inherited personalization; the maintainer's live config stops
  showing as permanent working-tree churn.
- Good: removes a class of accidental-commit risk for personal provider/model
  choices, complementing the secrets-guard layers.
- Good: unblocks the distribution substrates (ADR-0013 and the public mirror
  that follows this ADR) — there is no longer personal config in the tracked
  surface they ship.
- Neutral: operators who *want* to version their config can still do so out of
  band (a private overlay), but the default is local-only.
- Bad: a one-time migration wrinkle — the previously-tracked files are removed
  from the index (`git rm --cached`) while kept on disk; existing checkouts keep
  their live files and `setup.sh` will not clobber them.

### Relationship to the distribution mirror

This ADR is a precursor to the public `psmfd/pi-config` distribution mirror
(tracked separately): by the time that mirror is synced, the tracked config
surface is already generic, so the mirror needs no per-sync scrubbing of
`settings.json` / `models.json`. The mirror sync simply omits the gitignored
live files and ships the `*.example` templates, and the recipient's `setup.sh`
seeds them exactly as a direct checkout would.
