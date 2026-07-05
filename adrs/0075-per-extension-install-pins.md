---
status: Accepted
date: 2026-07-05
---

# ADR-0075: Per-extension version pins in install.sh

**Status:** Accepted
**Date:** 2026-07-05
**Tracking issue:** #492
**Related:** [ADR-0051](0051-sendable-one-shot-installer.md) (`install.sh` / `EXT_MIRRORS`), [ADR-0058](0058-extension-version-bump-protocol.md) (independent per-extension SemVer), [ADR-0069](0069-ext-ref-pin-drift-automation.md) (the drift checker + weekly poll this extends), [ADR-0074](0074-mirror-target-onboarding-lockstep-gate.md) (the lockstep gate whose install.sh parser this changes)

## Context and Problem Statement

`install.sh` wired every first-party extension at **one shared `EXT_REF`** (`v0.1.0`) — a single tag applied to all twelve `psmfd/pi-<name>` mirrors. But the mirrors version **independently** (ADR-0058): a `fix`/`feat` in one extension's subtree advances only that mirror. Within weeks they diverged — some at `v0.2.0`, most at `v0.1.1`, two still at `v0.1.0`.

A single shared pin cannot represent that: no tag exists on all twelve mirrors simultaneously. Consequences:

- Users running `install.sh` got the stale `v0.1.0` of every extension, even ones several releases ahead.
- The drift checker (`check-ext-ref-drift.sh`, ADR-0069) detected the staleness but **refused `--fix`** (`#492`) — a shared pin can't be safely rewritten to a tag some mirrors lack — so the weekly `pin-drift-check.yml` could never auto-resolve install.sh drift.

The shared-pin model is structurally incompatible with independently-versioned mirrors.

## Considered Options

| Option | Verdict |
|---|---|
| **A — Per-extension pins (`name@vX.Y.Z` in `EXT_MIRRORS`)** | **Chosen.** Each mirror pins to its own release. Reproducible installs (a given `install.sh` commit pins exact versions), and each pin is independently auto-fixable — so `check-ext-ref-drift.sh --fix` + the weekly poll keep them current via bump PRs. Bash-3.2-safe (an indexed array of `name@version` strings + `${entry%@*}`/`${entry##*@}`; no associative arrays). |
| B — Float each extension to its latest release at install time | Rejected. Simplest, always current, but **loses reproducibility** (two installs days apart can differ) and the audit trail of what shipped — unacceptable for a security-sensitive install path. |
| C — Lockstep all mirrors to one version so a single `EXT_REF` works | Rejected. Defeats independent SemVer (ADR-0058); an unrelated extension's patch would force-bump every extension's version. |

## Decision Outcome

1. **`install.sh` `EXT_MIRRORS` becomes a `name@vX.Y.Z` array**, one pin per mirror at its current latest release. The install loop splits each entry (`ext=${entry%@*}`, `ref=${entry##*@}`).
2. **`EXT_REF` becomes an optional global override** — `--ext-ref vX.Y.Z` pins *all* mirrors to one ref (forks/testing); empty (default) uses the per-extension pins.
3. **`check-ext-ref-drift.sh --fix` bumps each pin independently** (new `install_pin_of` / `fix_install_pin` helpers, same anchored-`vX.Y.Z` injection guard as the existing `fix_pin`). The `#492` shared-pin divergence refusal is removed; a pin *ahead* of latest (unreleased) is reported, never downgraded.
4. **`pin-drift-check.yml` runs `--fix` over all pins** and opens a single `chore(install): bump extension pins` PR to `dev` — the "keep in sync" automation now covers `install.sh`, not just `install-expertise.sh`.
5. **`validate.sh`'s ADR-0074 lockstep gate** parses the new multi-line `name@vX.Y.Z` format (strips `@version` when comparing the extension set across the three files).

`install-expertise.sh` keeps its single `EXT_REF` (it is 1:1 with `pi-expertise-client`) and is bumped to `v0.2.0` in the same change.

## Consequences

**Positive:**

- Installs are current *and* reproducible — every extension pins its own latest release, recorded in `install.sh`.
- The drift automation (ADR-0069) now closes the loop for `install.sh`: stale pins are auto-bumped via a weekly PR instead of being reported-and-refused forever.
- Resolves `#492` structurally rather than living with the refusal.

**Negative / cost:**

- `install.sh` carries twelve pins to keep current, not one — but that is exactly what the (now-effective) automation maintains.
- A new extension must be added to `EXT_MIRRORS` with its pin; the ADR-0074 lockstep gate already enforces the *presence* of every extension in `EXT_MIRRORS`.

**Neutral:**

- `--ext-ref` semantics change from "the pin" to "override-all"; documented in the help text. Forks relying on it to pin everything to one ref are unaffected.

## Doc-Impact

| Surface | Classification | Reason |
|---|---|---|
| `adrs/0075-*.md` | in-scope | this ADR |
| `install.sh` | in-scope | `name@vX.Y.Z` array + loop + `--ext-ref` override |
| `install-expertise.sh` | in-scope | bump expertise-client pin to `v0.2.0` |
| `scripts/check-ext-ref-drift.sh` | in-scope | per-extension pin parse + `--fix`; drop `#492` refusal |
| `.github/workflows/pin-drift-check.yml` | in-scope | run `--fix` over all pins; generalized bump PR |
| `scripts/validate.sh` | in-scope | ADR-0074 lockstep parser updated for the new format |
| `docs/outbound-mirror-sync.md` | in-scope | document the per-extension pin model |
| `README.md` (ADR list) | in-scope | add the ADR-0075 entry (and backfill the missing ADR-0072 / ADR-0074) |
| `mirror/readme/pi-config.md` | in-scope | extension count Eleven → Twelve + add the `pi-token-meter` row |
