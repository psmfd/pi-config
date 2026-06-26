---
status: Accepted
date: 2026-06-26
---

# ADR-0063: config-mirror portability and global private-slug enforcement

**Status:** Accepted
**Date:** 2026-06-26
**Tracking issue:** #435
**Supplements:** [ADR-0062](0062-mirror-readme-portability.md) (extension-mirror portability)
**Related:** [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the sync engine), [ADR-0059](0059-mirror-readme-substitution.md) (`readme_substitute`)

## Context and Problem Statement

ADR-0062 made the **extension** mirrors portable and explicitly left the **config**
mirror (`psmfd/pi-config`, replace mode) out of scope, tracked as #435. The config
mirror ships the whole `adrs/`, `docs/`, `agent/rules/`, and `README` corpus, which
references the **private** source repo `psmfd/pi-config` (formerly
`psmfd/pi-config`) roughly 1,700 times — predominantly issue and PR
hyperlinks (markdown links whose target is an `…/issues/NNN` or `…/pull/NNN` URL)
that 404 for any public visitor, plus bare slug mentions that disclose the private
repo.

ADR-0062 deliberately did **not** add the private slug to the engine's global
`DENYLIST_REGEX`, because doing so would have failed the config-mirror sync (the
slug was pervasive and, inside the monorepo, legitimate). With #435 sanitizing the
config mirror, that constraint is lifted.

A key asymmetry with the extension mirrors: the config mirror **ships `adrs/`**, so
intra-repo relative links (an ADR cross-referencing another ADR) **resolve** on the
mirror. The extension-mirror `verify_portable` relative-link gate must therefore
stay overlay-scoped — it would wrongly reject the config mirror's valid relative
links. Only the private-slug class is common to both.

## Considered Options

1. **Per-target denylist** — give the config target its own slug denylist, keep the
   global one slug-free. Rejected: more machinery; once every target sanitizes the
   slug, a single global assertion is simpler and strictly stronger.
2. **Curated substitutes** for the config corpus. Rejected: the ADR/doc corpus is
   the product; hand-curating ~50 ADRs is untenable double-maintenance.
3. **A `mirror/sanitize/pi-config.sed` + promote the slug to the global denylist.**
   Chosen.

## Decision Outcome

**Chosen: option 3.**

- **`mirror/sanitize/pi-config.sed`** (added to the `pi-config` target's `sanitize`
  list after `emu-examples`): de-links private issue/PR hyperlinks to their link
  **text** (the URL is dropped, so an issue link with text `#100` becomes plain
  `#100`), and rewrites any
  surviving private slug — bare prose, a tree/blob/commit link — to the public
  mirror form `psmfd/pi-config`. It does **not** touch relative links, which resolve
  on the config mirror. POSIX BRE, BSD/GNU-safe, same rule family as the ADR-0062
  extension seds.
- **Global `DENYLIST_REGEX` now includes `(TheSemicolon|psmfd)/pi_config`.** Every
  target sanitizes the slug (extensions via ADR-0062 seds, the config mirror via the
  new sed), so the engine's fail-closed `verify_clean` enforces slug-freeness
  **uniformly across all targets** — the single forcing function ADR-0062's
  overlay-scoped `verify_portable` could not provide for the config mirror.

### Consequences

- Good: the public config mirror no longer ships 404-ing private issue/PR links or
  discloses the private slug; enforcement is one global assertion, fail-closed.
- Good: source ADRs/docs keep their convenient relative links and private-repo issue
  hyperlinks for in-monorepo reading — the transform is staged-copy-only.
- Bad: rewriting bare slug mentions to `psmfd/pi-config` is slightly imprecise in the
  few ADRs that narrate the source/mirror split (a sentence may read as if the public
  mirror were the source). Accepted as strictly better than shipping the private slug;
  the issue-link **text** is always preserved, so traceability is not lost.
- Bad: a future new private-slug *form* not matched by the sed fails the publish
  (fail-closed) — the intended behavior, surfaced at dry-run.
