---
status: Accepted
date: 2026-07-03
---

# ADR-0070: install-expertise.sh Debian/Ubuntu parity

**Status:** Accepted
**Date:** 2026-07-03
**Amends:** [ADR-0067](0067-expertise-local-installer.md) — extends its "Scope: macOS-first" decision to also cover Debian/Ubuntu. The macOS behavior and the managed-auth-block linkage design are unchanged.
**Closes:** #485 (Debian-first Linux parity).
**Depends on:** agent-expertise-api#246 (the upstream `--install-deps` apt bootstrap this delegates to).

## Context and Problem Statement

ADR-0067 shipped `install-expertise.sh` macOS-first: on non-macOS hosts it skipped
the API stand-up and pointed at #485. The upstream `agent-expertise-api` installer
grew a Debian/Ubuntu `--install-deps` apt bootstrap (its #246), so the pi_config
one-shot can now stand up the full local expertise backend on Debian/Ubuntu too.

## Decision Outcome

`install-expertise.sh` runs its API stand-up on **macOS (Homebrew) and Debian/Ubuntu
(apt)**. The delegation, managed-auth-block pre-seed, health-gate, and `.env.local`
wiring are OS-agnostic; three things are made OS-aware:

1. **Config dir** — Linux uses `${XDG_CONFIG_HOME:-~/.config}/expertise-api` (matching
   the upstream installer's Linux `CONFIG_DIR`), macOS keeps
   `~/Library/Application Support/expertise-api`.
2. **ONNX model-path pin** — pinned **only on macOS**. Upstream's `migrate.sh` derives
   the model path from a Linux-oriented `PREFIX` default (`~/.local/share`) that is
   *wrong on macOS* (so ADR-0067 pins it) but *correct on Linux*. Validated on
   Debian 13: the model loads and semantic search runs with no pin, so pinning to
   `CONFIG_DIR/models` on Linux would point the service at the wrong path — omit it.
3. **Toolchain provider** — no Homebrew requirement on Linux; the Debian bootstrap
   uses apt (upstream #246), and the indexing engine's `python3`/`pipx` come from apt.

Non-apt Linux (RHEL) still skips the API stand-up, pointing at agent-expertise-api#247;
the extension + indexing engine still install.

### Consequences

- **Positive:** the documented one-shot works on Debian/Ubuntu, validated end-to-end
  on Debian 13 arm64 (service healthy, auth enforced, create+embedding round trip).
- **Gated:** the Debian path delegates to the *released* upstream installer, so it is
  functional only once agent-expertise-api ships a release containing #246. Until
  then the script's Debian branch runs but the delegated `--install-deps` hits the
  pre-#246 "not implemented" stub.
- **Not-a-thing:** Windows parity remains deferred (ADR-0067), and RHEL remains
  upstream #247.
