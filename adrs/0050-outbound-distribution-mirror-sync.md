---
status: Accepted
date: 2026-06-24
---

# ADR-0050: a generic, manifest-driven outbound mirror-sync engine for the config + extension distribution mirrors

**Status:** Accepted
**Date:** 2026-06-24
**Closes:** #376 (the CI-automated mirroring deferred by ADR-0042)
**Related:** [ADR-0042](0042-standalone-extension-distribution.md) (extension mirrors — this generalizes their manual sync), [ADR-0013](0013-distribution-substrate-strategy.md) (distribution substrates — this stands up a config mirror so the GitHub-Template / installer paths have a public source), [ADR-0049](0049-genericize-runtime-config-via-templates.md) (config genericization — the precursor that makes the config surface shippable without per-sync scrubbing), [ADR-0039](0039-mirror-sync-cadence-and-provenance.md) / [ADR-0045](0045-automate-mirror-sync-runbook.md) (the INBOUND psmfd/pi sync — a different system, contrasted below)

## Context and Problem Statement

The private monorepo `psmfd/pi-config` is the source of truth. Two kinds of
public downstream exist, both populated by hand:

- **Extension mirrors** (`psmfd/pi-<name>`, ADR-0042) — five leaf extensions
  were extracted and published manually; ADR-0042 explicitly deferred
  "CI-automated mirroring" to follow-up #376.
- **A config distribution mirror** (`psmfd/pi-config`, new) — required because
  the private repo cannot be cloned by recipients, and the curated config
  surface (rules, agents, `AGENTS.md`, settings) is not `pi install`-able, so a
  public git source is the only delivery channel (ADR-0013).

Doing this by hand does not scale and is error-prone in exactly the way that
matters most: a manual slip could publish a dev-internal surface or an identity
string to a public repo. The work needs to be (a) **extensible** — adding a new
mirror is configuration, not a new script — and (b) **triggerable** — an update
to the source repo propagates downstream automatically, only to the mirrors
whose content actually changed.

This is the **outbound** (push-out) direction. It must not be confused with the
**inbound** psmfd/pi mirror sync (ADR-0039/ADR-0045), which pulls upstream pi
releases *into* a mirror with overlay conflict resolution. Different direction,
different trust model, different tooling.

## Considered Options

1. **Keep manual per-mirror runbooks.** Rejected: does not scale to a config
   mirror plus N extensions, and the highest-consequence step (not leaking a
   dev-internal surface) is the one most exposed to human slips.
2. **Per-mirror bespoke scripts.** Rejected: N copies of near-identical
   stage/sanitize/push logic drift apart; a safety fix has to be applied N times.
3. **One generic engine driven by a target manifest.** Chosen. Adding a mirror
   is a manifest entry; one set of safety properties covers every target.

## Decision Outcome

**Chosen: option 3** — `scripts/sync-mirror.sh` + `mirror/targets.yml`.

- **Manifest (`mirror/targets.yml`):** one entry per mirror declaring `repo`,
  `mode` (`replace` for the wholly-derived config mirror; `overlay` for
  extension mirrors, which preserve their own packaging files per ADR-0042),
  optional `strip_prefix`, an allowlist of `sources`, `exclude` carve-outs, and
  named `sanitize` programs. Adding a target is a manifest edit — the
  "extensible to extensions" property.
- **Engine (`scripts/sync-mirror.sh`):** for each target it stages, sanitizes,
  verifies, optionally scans, and (with `--push`) applies + commits + pushes.
  Default mode is `--dry-run`; nothing is pushed without `--push`.
- **Safety properties (the reason a generic engine is acceptable):**
  1. **Tracked-only staging.** Only `git ls-files`-tracked files under a
     target's `sources` are staged, so gitignored runtime data and secrets
     (`auth.json`, the `.gh-*` identity pins) can never be shipped. The
     operator-owned live config (`agent/settings.json`, `agent/models.json` of
     ADR-0049) is additionally named in the config target's `exclude`, so it is
     withheld even on a checkout where it is still tracked.
  2. **Sanitize then fail-closed verify.** Declared `sanitize` sed programs
     rewrite example strings (e.g. the EMU/enterprise login examples →
     placeholders); a denylist grep over the staged tree then **aborts the
     target** if any forbidden string survived. Sanitization touches only the
     staged copy, never the source.
  3. **Secret-scan backstop.** `scripts/scan-secrets.sh` runs over the staged
     tree — best-effort in dry-run, **mandatory and fail-closed before a push**.
- **Trigger (`.github/workflows/sync-mirrors.yml`):** a `verify` job runs the
  engine in `--dry-run` on every PR that touches a published surface, surfacing a
  sanitization regression at PR time — advisory until it is registered as a
  required status check on `dev` (#398;
  the fail-closed gate that actually blocks a leak is the `sync` job's pre-push
  verify). A `sync`
  job runs `--all --changed --push` on push to `main` (a dev→main release
  promotion) and
  on manual dispatch. `--changed` compares each target's `sources` against the
  SHA recorded in the mirror's `.mirror-provenance` and skips unchanged targets,
  so an update fans out only where it matters. Push auth uses a
  `MIRROR_SYNC_TOKEN` secret (content-write to the `psmfd/pi-*` mirrors).
- **Provenance:** each push writes `.mirror-provenance` (source repo + SHA) to
  the mirror, which both records lineage and drives `--changed`.

### Consequences

- Good: one engine, N targets; adding a mirror is a manifest entry. The config
  mirror and the five extension mirrors are covered today; the six not-yet-
  extracted extensions join the manifest when their repos exist.
- Good: the leak-prevention properties (tracked-only, fail-closed verify,
  secret-scan) are defined once and apply to every target, and are gated at PR
  time, not just at push time.
- Good: closes the #376 automation gap and unifies it with the config mirror.
- Bad / accepted: the push job holds a token that can write to the public
  mirrors; it is a single Actions secret, used only in the `sync` job, and the
  job fails closed if it is absent. Rotating/scoping it is an operator duty.
- Bad / accepted: mirror repos must already exist — a target whose mirror is
  absent fails its clone loudly. Creating `psmfd/pi-config` and the missing
  extension mirrors is separate, deliberately-gated work.
- Bad / accepted: `mode: overlay` preserves a mirror's packaging overlay but
  cannot detect a source file deleted upstream (no `--delete`); a removed
  extension source must be pruned in the mirror by hand. The config mirror
  (`replace`) does not have this limitation.

### Relationship to the inbound sync (ADR-0039/0045)

That system merges upstream `earendil-works/pi` release tags *into* `psmfd/pi`
with namespace-isolated refs and `--ours`/`--theirs` overlay conflict
resolution, gated by a human-reviewed trusted-sync bypass. This ADR pushes
curated subsets of one private repo *out* to many public mirrors, gated by
tracked-only staging + fail-closed sanitization. They share only the word
"sync"; neither's tooling is reused by the other.
