---
status: Accepted
date: 2026-06-26
---

# ADR-0062: portable READMEs for extension mirrors (sanitize-sed + fail-closed portability gate)

**Status:** Accepted
**Date:** 2026-06-26
**Tracking issue:** #433
**Related:** [ADR-0042](0042-standalone-extension-distribution.md) (standalone extension mirrors), [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the sync engine), [ADR-0059](0059-mirror-readme-substitution.md) (`readme_substitute`, supplemented here), [ADR-0061](0061-mirror-sync-github-app-auth.md) (sync auth)

## Context and Problem Statement

Extension mirrors (`psmfd/pi-<name>`) receive each extension's `README.md`
**verbatim** from this private monorepo via the overlay sync (ADR-0042/ADR-0050).
The source READMEs are authored for the monorepo, where relative links resolve.
On a standalone public mirror three reference classes break or leak:

1. **Monorepo-relative links to non-shipped files** — `](../../../adrs/…)`,
   `](../../rules/…)`, `](../../../hooks/…)`, `.review/`, `.github/workflows/`,
   `CODEOWNERS`. The target does not exist in the mirror → 404.
2. **Private-repo issue/PR hyperlinks** — `github.com/psmfd/pi-config/…`
   and `github.com/psmfd/pi-config/…` (the `pi_config` repo is **private**). These
   404 for any public visitor and disclose the private slug.
3. **Cross-extension relative links** — `](../artifact-handoff/README.md)` — a
   separate repo (`psmfd/pi-artifact-handoff`) in mirror-land.

The live mirrors already ship these defects (e.g. `psmfd/pi-secrets-guard`'s
README carries a `../../` link and a `psmfd/pi-config` issue URL). The
engine's fail-closed publish gate (`verify_clean` over `DENYLIST_REGEX`) did not
catch them: the private slugs were never on the denylist, and broken relative
links are not "secret" strings. So the breakage shipped silently.

## Considered Options

1. **Source rewrite** — edit the source READMEs to absolute public URLs. Rejected:
   degrades in-monorepo navigation, couples source authoring to the mirror URL
   scheme, and `validate.sh`'s relative-link check stops covering absolute URLs,
   so a future broken absolute link is ungated.
2. **Curated `readme_substitute` for every extension** (ADR-0059). Rejected as the
   default: 8+ hand-authored READMEs that immediately and permanently diverge from
   their source — documentation debt by construction. Retained for the narrow case
   where the source README is dominated by content that must be *omitted*.
3. **Per-extension sanitize-sed at sync time + a fail-closed portability gate.**
   Chosen. Keeps sources unchanged (monorepo navigation intact), transforms on the
   way out, and a verify step makes any miss fail the publish instead of shipping
   broken.

A three-expert review (docs / shell / code-review) converged on option 3 as the
default with option 2 as a documented exception, and surfaced the denylist gap.

## Decision Outcome

**Chosen: option 3, hybrid with a narrow option-2 exception.**

- **Per-extension `mirror/sanitize/<name>.sed`** (the existing ADR-0050 `sanitize`
  mechanism, precedent `emu-examples.sed`). Rewrite rules by class:
  - monorepo-relative ADR/rule/hook/script links →
    `https://github.com/psmfd/pi-config/blob/main/<path>` (those files ship on the
    config mirror);
  - private-repo issue/PR links → de-linked to plain `#NNN`;
  - cross-extension links → the sibling mirror's landing URL;
  - a prose backstop rewrites any surviving private slug to the public form.
  Programs are POSIX BRE, BSD/GNU-safe (no `\b`, no `-E`), and anchored to markdown
  link syntax so they are no-ops on source files.
- **Curated `readme_substitute`** for an extension whose README is dominated by
  monorepo-infrastructure cross-links that must be omitted, not rewritten. Applied
  to `artifact-handoff` (`.review/`, the CI workflow, `CODEOWNERS`).
- **Fail-closed `verify_portable` gate** (forcing function) over each **overlay**
  staged tree, run after `verify_clean`. It **hard-fails** the sync if any
  `](../` monorepo-relative link or any `(TheSemicolon|psmfd)/pi_config` private
  slug survives. Scoped to overlay targets: the replace-mode config mirror
  legitimately ships ADRs/docs that reference the source repo, so the global
  `DENYLIST_REGEX` is left unchanged and the config mirror is out of this gate's
  scope (its own portability is tracked separately).

### Consequences

- Good: source READMEs stay monorepo-navigable; mirrors are clean; a missed link
  or a new unhandled link form fails the publish rather than shipping broken.
- Good: adding an extension is one `.sed` file (or one curated README) beside the
  `targets.yml` entry — no engine change; the gate auto-applies to every overlay.
- Bad: per-extension sed maintenance, and the BSD/GNU-portable link regexes are
  more intricate than literal-string substitutions. The fail-closed gate is the
  backstop that converts "silent drift" into "blocked publish".
- Bad: the config mirror still ships private-slug references in its ADRs/docs —
  explicitly out of scope here, tracked as a follow-up.
