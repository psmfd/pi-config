---
status: Accepted
date: 2026-06-24
---

# ADR-0051: a sendable one-shot installer (`install.sh`) on top of the verified public mirror

**Status:** Accepted
**Date:** 2026-06-24
**Related:** [ADR-0013](0013-distribution-substrate-strategy.md) (distribution substrates — this revives its deferred option ε under the condition ADR-0013 itself set), [ADR-0050](0050-outbound-distribution-mirror-sync.md) (the public mirror this installs from), [ADR-0042](0042-standalone-extension-distribution.md) (the extension mirrors it `pi install`s), [ADR-0049](0049-genericize-runtime-config-via-templates.md) (the generic config it relies on)

## Context and Problem Statement

The goal from the outset was "a distributable script I can send out that installs
our setup generically, without my personalizations." ADR-0013 enumerated a
**ε one-shot installer (`curl … | bash`)** option and **deferred** it: "Bypasses
verification; trains recipients to run unaudited remote shell scripts … Reasonable
as an *added convenience on top of a verified substrate later*, not as the
substrate itself."

That condition is now met. The substrate exists and is verified:

- The public config mirror `psmfd/pi-config` ([ADR-0050](0050-outbound-distribution-mirror-sync.md)) is a tracked-only, sanitized, secret-scanned artifact — recipients can clone it.
- The runtime config is generic by construction ([ADR-0049](0049-genericize-runtime-config-via-templates.md)) — no maintainer personalizations travel.
- The first-party extensions are published as their own verified mirrors ([ADR-0042](0042-standalone-extension-distribution.md)).

What is missing is the convenience layer: one file a recipient runs to go from
nothing to a working install.

## Considered Options

1. **No installer; document the manual steps** (clone mirror, run setup.sh,
   `pi install` each extension). Rejected: high friction; the manual extension
   list drifts.
2. **`curl … | bash` hosted one-liner.** Rejected as the *default* delivery:
   this is the exact provenance concern ADR-0013 flagged — piping an unaudited
   remote script to a shell. May be offered later as an *additional* convenience
   for those who accept it, but it is not the primary form.
3. **A sendable `install.sh` file.** Chosen. The maintainer sends the file (or
   the recipient downloads it); the recipient can read it before running
   `bash install.sh`. No curl-pipe, so the script is auditable before execution —
   materially better provenance than ε's original `curl | bash` framing.

## Decision Outcome

**Chosen: option 3** — a tracked, sendable `install.sh` at the repo root.

It:

1. Clones the public mirror `psmfd/pi-config` (default ref `main`; `--ref` to
   override). Release-tag pinning replaces the `main` default once the mirror
   cuts releases — deferred, since no mirror release exists yet.
2. Optionally runs `scripts/personalize.sh --init` when `--owner/--repo/--gh-login`
   are supplied (for recipients who will host their own fork); skipped for a
   plain consumer install.
3. Runs the mirror's `setup.sh` — installs pi + the toolchain, seeds
   `agent/{settings,models}.json` from the generic templates, symlinks `~/.pi`.
4. `pi install`s the five published extension mirrors
   (`git:github.com/psmfd/pi-<name>@v0.1.0`). Because the mirror excludes those
   five extension directories ([ADR-0050](0050-outbound-distribution-mirror-sync.md)), the clone never
   carries them and nothing double-loads.

`--dry-run` prints every action; `--skip-extensions` stops at the config install;
`PI_*` environment variables pass through to `setup.sh`.

### Consequences

- Good: fulfils the original "send a script" ask with auditable provenance,
  reusing the verified substrates rather than bypassing them.
- Good: the generic-config and excluded-extension properties mean a recipient
  gets a clean, personalization-free install with the first-party extensions
  sourced from their own attested mirrors.
- Neutral: pins the mirror's `main` branch for now; a release-tag pin is a
  follow-up that depends on the mirror cutting releases (tied to pi_config
  releases via the sync).
- Bad / accepted: `install.sh` hardcodes the `psmfd` mirror slugs and the five
  extension names; a new extension mirror means a one-line edit here in addition
  to `mirror/targets.yml`.
- Bad / accepted: a recipient still runs a shell script that installs a toolchain
  and symlinks `~/.pi`. This is the same trust posture as cloning and running
  `setup.sh` directly (ADR-0010); the installer adds no new privilege, and being
  a readable file (not a `curl | bash` stream) keeps it auditable.
