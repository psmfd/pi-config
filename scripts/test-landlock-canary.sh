#!/usr/bin/env bash
#
# test-landlock-canary.sh — Linux enforcement canaries for the Phase 2a
# bash-tool write-confinement layer (ADR-0146, #1046).
#
# Exercises the REAL entry path (the composed pi-bash-sandbox wrapper exec'ing
# the vendored landlock-run launcher) on a Landlock-capable kernel: denial
# outside grants, worktree writes allowed, /dev/null usable, git commit from a
# linked worktree with enumerated .git common-dir grants, .git/hooks write
# denied, and the exit-125 marker disambiguation. Verifies the world (files on
# disk, real exit codes), not self-reports — per the testing doctrine.
#
# Platform gating (the repo's first per-OS self-skip): on non-Linux hosts the
# whole suite SKIPs (exit 0) — Landlock is a Linux LSM; macOS confinement is
# the Seatbelt leg (#707). On Linux, a missing/unfetchable launcher is exit 2
# (environment unavailable); a kernel that probes unusable (e.g. a seccomp-
# restricted CI sandbox) WARNs loudly and skips only the enforcement cases.
#
# Exit codes: 0 all pass (or platform-skip), 1 a canary failed, 2 environment
# problem. Per agent/rules/script-output-conventions.md.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$REPO_DIR/scripts/pi-bash-sandbox.sh"

errors=0
ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
skip() { printf 'SKIP  [%s] %s\n' "$1" "$2"; }
warn() { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; }
info() { printf 'INFO  %s\n' "$*"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }

if [ "$(uname -s)" != "Linux" ]; then
  skip landlock-canary "not Linux; Landlock enforcement untestable on this host (macOS = Seatbelt leg, #707)"
  exit 0
fi

if [ ! -x "$WRAPPER" ]; then
  echo "ERROR landlock-canary: $WRAPPER missing or not executable" >&2
  exit 2
fi

# Resolve the launcher; fetch from the vendor pin when absent (sha256-pinned,
# cached — the same path setup.sh takes).
LAUNCHER="${PI_CONFINE_LAUNCHER:-$HOME/.local/bin/landlock-run}"
if [ ! -x "$LAUNCHER" ]; then
  # shellcheck source=scripts/lib/platform-detect.sh disable=SC1091
  . "$REPO_DIR/scripts/lib/platform-detect.sh"
  # shellcheck source=scripts/lib/install-helpers.sh disable=SC1091
  . "$REPO_DIR/scripts/lib/install-helpers.sh"
  if ! ih_ensure_landlock_run; then
    echo "ERROR landlock-canary: landlock-run unavailable and vendor fetch failed" >&2
    exit 2
  fi
  LAUNCHER="$HOME/.local/bin/landlock-run"
fi
[ -x "$LAUNCHER" ] || { echo "ERROR landlock-canary: launcher still missing at $LAUNCHER" >&2; exit 2; }

# Probe tri-state (the authority — never the kernel version, ADR-0146 D5).
probe_out="$("$LAUNCHER" --probe 2>&1)"
probe_rc=$?
info "probe: rc=$probe_rc ${probe_out:-<no output>}"
if [ "$probe_rc" -ne 0 ]; then
  warn landlock-canary "kernel probes unusable (rc=$probe_rc) — enforcement canaries skipped; this run proves NOTHING about confinement"
  echo "=================================="
  echo "PASS — 0 errors (enforcement skipped: probe unusable)"
  exit 0
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/landlock-canary.XXXXXX")"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

WT="$SCRATCH/worktree"; mkdir -p "$WT"
OUTSIDE="$SCRATCH/outside"; mkdir -p "$OUTSIDE"

confined() {
  PI_BASH_SANDBOX_HOME="$SCRATCH/home" PI_BASH_CONFINE=enforce \
    PI_CONFINE_LAUNCHER="$LAUNCHER" PI_SESSION_WORKTREE="$WT" \
    PI_CONFINE_GRANTS_RW="${EXTRA_RW:-}" "$WRAPPER" "$@"
}

# 1. Write DENIED outside the granted set — the Phase 2a value claim.
confined -c "echo x > '$OUTSIDE/denied.txt'" 2>/dev/null
rc=$?
if [ "$rc" -ne 0 ] && [ ! -e "$OUTSIDE/denied.txt" ]; then
  ok deny-outside "write outside grants denied (rc=$rc, no file on disk)"
else
  err deny-outside "expected denial; rc=$rc, file-exists=$([ -e "$OUTSIDE/denied.txt" ] && echo yes || echo no)"
fi

# 2. Write ALLOWED inside the worktree grant.
if confined -c "echo canary > '$WT/allowed.txt'" && [ "$(cat "$WT/allowed.txt")" = "canary" ]; then
  ok allow-worktree "write inside the worktree grant works"
else
  err allow-worktree "worktree write failed"
fi

# 3. /dev/null usable under confinement (ordinary scripting idiom).
if confined -c 'echo x >/dev/null 2>&1'; then
  ok dev-null "/dev/null writable under confinement"
else
  err dev-null "redirect to /dev/null failed"
fi

# 4. rm -rf outside grants denied; the target survives.
mkdir -p "$OUTSIDE/precious"; echo keep > "$OUTSIDE/precious/keep.txt"
confined -c "rm -rf '$OUTSIDE/precious'" 2>/dev/null
if [ -f "$OUTSIDE/precious/keep.txt" ]; then
  ok deny-rm "rm -rf outside grants leaves the target intact"
else
  err deny-rm "rm -rf outside grants DELETED the target"
fi

# 5. git commit from a linked worktree with enumerated .git common-dir grants;
#    .git/hooks stays unwritable (the ADR-0146 D4 payoff).
REPO="$SCRATCH/mainrepo"
git init -q "$REPO" && (cd "$REPO" && git -c user.name=c -c user.email=c@x commit -q --allow-empty -m init)
git -C "$REPO" worktree add -q "$SCRATCH/gitwt" -b canary-branch
GITWT="$SCRATCH/gitwt"
WT="$GITWT"
EXTRA_RW="$REPO/.git/objects:$REPO/.git/refs:$REPO/.git/logs:$REPO/.git/worktrees"
if confined -c "cd '$GITWT' && echo change > f.txt && git add f.txt && git -c user.name=c -c user.email=c@x commit -qm canary" \
   && [ "$(git -C "$GITWT" log --oneline | wc -l | tr -d ' ')" = "2" ]; then
  ok git-commit "git commit from a linked worktree works under enumerated .git grants"
else
  err git-commit "git commit under confinement failed"
fi
confined -c "echo pwned > '$REPO/.git/hooks/pre-commit'" 2>/dev/null
if [ ! -f "$REPO/.git/hooks/pre-commit" ]; then
  ok deny-hooks ".git/hooks write denied under enumerated grants"
else
  err deny-hooks ".git/hooks was WRITABLE — hook-planting residual is open"
fi
WT="$SCRATCH/worktree"; EXTRA_RW=""

# 6. Exit-code contract (ADR-0146 D8): a wrapped command's bare exit 125
#    passes through with NO 'landlock-run:' marker on stderr.
got_err="$(confined -c 'exit 125' 2>&1 >/dev/null)"
rc=$?
if [ "$rc" -eq 125 ] && ! printf '%s' "$got_err" | grep -q 'landlock-run:'; then
  ok bare-125 "wrapped exit 125 passes through unmarked"
else
  err bare-125 "rc=$rc stderr='$got_err'"
fi

# 7. SSH_AUTH_SOCK reachability — informational record (ADR-0146 D9: the
#    signing-oracle residual is Phase 2b's problem; this line documents the
#    live state, it never fails the suite).
if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  if confined -c "test -r '$SSH_AUTH_SOCK'" 2>/dev/null; then
    info "SSH_AUTH_SOCK is REACHABLE under confinement (expected residual, Phase 2b/#707)"
  else
    info "SSH_AUTH_SOCK not reachable under confinement on this host"
  fi
else
  info "SSH_AUTH_SOCK unset on this host; oracle-residual state not observable"
fi

echo "=================================="
if [ "$errors" -gt 0 ]; then
  echo "FAIL — $errors error(s)"
  exit 1
fi
echo "PASS — 0 errors"
exit 0
