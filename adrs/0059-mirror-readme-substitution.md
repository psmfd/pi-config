---
status: Accepted
date: 2026-06-25
---

# ADR-0059: the config mirror ships a curated public README, substituted at stage time

**Status:** Accepted
**Date:** 2026-06-25
**Closes:** [#404](https://github.com/psmfd/pi_config/issues/404) (curated end-user README for the pi-config mirror)
**Related:** [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the replace-mode sync this extends), [ADR-0042](0042-standalone-extension-distribution.md) (extension mirrors keep their own overlay README — the precedent for a mirror-specific README), [ADR-0051](0051-sendable-one-shot-installer.md) (`install.sh`, the end-user entry point the README leads with), [ADR-0049](0049-genericize-runtime-config-via-templates.md) (config genericization — the README states the mirror ships generic config only).

## Context and Problem Statement

The `pi-config` mirror is `replace`-mode: the staged tree wholly defines it, and
`README.md` is in the target's `sources`, so the mirror received this **private
monorepo's dev README verbatim** (only the `emu-examples` sanitizer touched it).
That README is framed for the internal source-of-truth context — its audience
assumptions, layout/validation internals, and workflow references are wrong for
the public mirror, whose audiences are end users cloning `psmfd/pi-config` (or
running the sent `install.sh`) and contributors to the mirror.

The extension mirrors (overlay mode, ADR-0042) already keep their own packaging
README, so the gap is specific to the replace-mode config mirror, which by design
has no overlay to preserve a curated front door.

## Considered Options

1. **Substitute a maintained README at stage time.** Chosen. A curated README
   lives in `pi_config` at `mirror/readme/pi-config.md` (under the already-excluded
   `mirror/` tree, so it never ships as itself); when staging the `pi-config`
   target the engine swaps it in for the staged `README.md`. The public README is
   authored and reviewed in the private repo, and the mirror stays a
   wholly-derived artifact (the README is derived too — from a different source
   file).
2. **Transform the dev README with a `sanitize` sed program.** Rejected: the dev
   and public READMEs differ structurally, not by a few strings; a sed program is
   fragile and unreadable for that scale of change.
3. **Let the mirror keep its own committed README (exclude it from `sources`).**
   Rejected: a `replace`-mode mirror is wholly derived; a hand-edited file living
   only on the mirror breaks that invariant and would be clobbered by any future
   inclusion of `README.md` in `sources`.

## Decision Outcome

**Chosen: option 1.** A new optional manifest field, `readme_substitute`, names a
repo-relative path; `stage_target` overwrites the staged `README.md` with that
file's content (fail-closed if the path is missing). The `pi-config` target sets
`readme_substitute: mirror/readme/pi-config.md`. Sanitize + fail-closed verify +
secret-scan still run over the substituted result, so the curated README is held
to the same leak gates as everything else.

- **Curated content:** end-user quickstart (`install.sh` one-shot, or clone +
  `setup.sh`), what gets installed (runtime, toolchain, config, guardrails), the
  five first-party extension mirrors, a provenance/trust note (attested
  `psmfd/pi` runtime, `.mirror-provenance`, ADR-0038/ADR-0050), and contribution
  guidance that states the mirror is derived (issues here, code changes upstream).
- **Links** in the curated README are authored relative to the **mirror root**
  (where it ships as `README.md`) or as absolute URLs, so they resolve for the
  public reader. `validate.sh`'s intra-repo link check therefore **excludes**
  `mirror/readme/` (its links do not resolve from the source location); the
  markdownlint and secret-scan gates still apply.

### Consequences

- Good: the public mirror presents an appropriately framed front door without
  leaking internal-dev framing, while remaining a wholly-derived artifact.
- Good: the mechanism is generic — any future replace-mode mirror can declare its
  own `readme_substitute`; the field is absent (a no-op) for targets that do not.
- Neutral: the curated README is a second document to maintain alongside the dev
  README; the two intentionally serve different audiences and will diverge.
- Accepted: `validate.sh` cannot check the curated README's relative links (they
  are mirror-root-relative); they are verified by rendering on the mirror. The
  exclusion is documented in `validate.sh` next to the other link-check carve-outs.
