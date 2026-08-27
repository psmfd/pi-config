#!/usr/bin/env bash
#
# test-bash-sandbox.sh — tests for scripts/pi-bash-sandbox.sh (#507 Phase 1).
#
# Exercises the opt-in $HOME-scoping wrapper the way pi invokes it
# (`<wrapper> -c <command>`) and asserts the redirect, XDG dirs, gitconfig
# seeding, transparent exit-code passthrough, and operator flags.
#
# Exit codes: 0 all pass, 1 a test failed, 2 environment problem.
# Per agent/rules/script-output-conventions.md.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$REPO_DIR/scripts/pi-bash-sandbox.sh"

errors=0
ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }

if [ ! -x "$WRAPPER" ]; then
  echo "ERROR test-bash-sandbox: $WRAPPER missing or not executable" >&2
  exit 2
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pi-bash-sandbox-test.XXXXXX")"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

run() { PI_BASH_SANDBOX_HOME="$SCRATCH/home" "$WRAPPER" "$@"; }

# 1. HOME is redirected to the scratch dir for a wrapped command.
got="$(run -c 'printf %s "$HOME"')"
if [ "$got" = "$SCRATCH/home" ]; then
  ok home-redirect "HOME resolves to the scratch dir"
else
  err home-redirect "HOME was '$got', expected '$SCRATCH/home'"
fi

# 2. XDG dirs point inside the scratch home.
got="$(run -c 'printf "%s|%s|%s" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"')"
want="$SCRATCH/home/.config|$SCRATCH/home/.cache|$SCRATCH/home/.local/share"
if [ "$got" = "$want" ]; then
  ok xdg-dirs "XDG_{CONFIG,CACHE,DATA}_HOME redirected under the scratch home"
else
  err xdg-dirs "XDG dirs were '$got', expected '$want'"
fi

# 3. A path built from $HOME points into the scratch tree, not real ~.
got="$(run -c 'printf %s "$HOME/.aws/credentials"')"
case "$got" in
  "$SCRATCH/home/.aws/credentials") ok path-scoping "\$HOME-relative credential path resolves into the scratch tree" ;;
  *) err path-scoping "credential path was '$got'" ;;
esac

# 4. gitconfig is seeded with the [init] section at minimum.
if [ -f "$SCRATCH/home/.gitconfig" ] && grep -q 'defaultBranch = main' "$SCRATCH/home/.gitconfig"; then
  ok gitconfig-seed "scratch .gitconfig seeded"
else
  err gitconfig-seed "scratch .gitconfig missing or not seeded"
fi

# 5. Exit code is transparent — the wrapped command's status is returned.
run -c 'exit 7'
rc=$?
if [ "$rc" -eq 7 ]; then
  ok exit-passthrough "wrapped command exit code returned unchanged"
else
  err exit-passthrough "expected exit 7, got $rc"
fi

# 6. stdout of the wrapped command is passed through verbatim.
got="$(run -c 'echo hello-from-sandbox')"
if [ "$got" = "hello-from-sandbox" ]; then
  ok stdout-passthrough "wrapped command stdout passed through"
else
  err stdout-passthrough "stdout was '$got'"
fi

# 7. --self-test passes.
if run --self-test >/dev/null 2>&1; then
  ok self-test "--self-test passes"
else
  err self-test "--self-test failed"
fi

# 8. --help prints usage and exits 0.
if "$WRAPPER" --help 2>/dev/null | grep -q 'HOME-scoping wrapper'; then
  ok help "--help prints usage"
else
  err help "--help did not print expected usage"
fi

# 9. A command whose text contains --self-test as an argument is NOT intercepted
#    (pi always sends -c first; the flag is only special as the first arg).
got="$(run -c 'printf %s "--self-test"')"
if [ "$got" = "--self-test" ]; then
  ok no-false-intercept "--self-test inside a -c command is not intercepted"
else
  err no-false-intercept "unexpected interception: got '$got'"
fi

# --- Confinement layer (Phase 2a, ADR-0146 / #1046) — portable cases. These
# exercise mode gating, refusal contract, and grant construction without a
# Landlock-capable kernel (enforcement itself is scripts/test-landlock-canary.sh).

# 10. Layer off / unset => plain passthrough, no marker on stderr.
got_err="$(run -c 'true' 2>&1 >/dev/null)"
if [ -z "$got_err" ]; then
  ok confine-off "no confinement noise when PI_BASH_CONFINE is unset"
else
  err confine-off "unexpected stderr with layer off: '$got_err'"
fi

# 11. Session-keyed scratch: PI_CONFINE_SESSION suffixes the DEFAULT scratch
#     home (explicit PI_BASH_SANDBOX_HOME override stays verbatim).
got="$(XDG_CACHE_HOME="$SCRATCH/xdg" PI_CONFINE_SESSION=sess-a "$WRAPPER" -c 'printf %s "$HOME"')"
if [ "$got" = "$SCRATCH/xdg/pi_config/bash-sandbox-home/sess-a" ]; then
  ok session-keyed-scratch "default scratch home is keyed by PI_CONFINE_SESSION"
else
  err session-keyed-scratch "scratch home was '$got'"
fi

# 12. Per-session TMPDIR points inside the scratch home (shared /tmp is not
#     used by wrapped commands).
got="$(run -c 'printf %s "$TMPDIR"')"
if [ "$got" = "$SCRATCH/home/tmp" ] && [ -d "$SCRATCH/home/tmp" ]; then
  ok session-tmpdir "TMPDIR redirected into the scratch home"
else
  err session-tmpdir "TMPDIR was '$got'"
fi

# Enforce-mode cases only run where the layer can engage (Linux gate is part
# of the wrapper: on macOS enforce passes through, which case 16 pins).
if [ "$(uname -s)" = "Linux" ]; then
  # 13. Enforce without PI_SESSION_WORKTREE => refuse: exit 125 + marker.
  #     A fake executable launcher isolates the worktree check from lookup.
  printf '#!/bin/sh\nexit 0\n' > "$SCRATCH/fake-launcher" && chmod +x "$SCRATCH/fake-launcher"
  set +e
  got_err="$(PI_BASH_SANDBOX_HOME="$SCRATCH/home" PI_BASH_CONFINE=enforce \
    PI_SESSION_WORKTREE='' PI_CONFINE_LAUNCHER="$SCRATCH/fake-launcher" \
    "$WRAPPER" -c 'true' 2>&1 >/dev/null)"
  rc=$?
  set -e
  if [ "$rc" -eq 125 ] && printf '%s' "$got_err" | grep -q '^landlock-run: refused'; then
    ok enforce-refusal "missing worktree under enforce => exit 125 + marker"
  else
    err enforce-refusal "rc=$rc stderr='$got_err'"
  fi

  # 14. Explicit strict-refusal policy state => refuse before running bash.
  set +e
  got_err="$(PI_BASH_SANDBOX_HOME="$SCRATCH/home" PI_BASH_CONFINE=refuse \
    "$WRAPPER" -c 'true' 2>&1 >/dev/null)"
  rc=$?
  set -e
  if [ "$rc" -eq 125 ] && printf '%s' "$got_err" | grep -q 'could not verify Landlock enforcement'; then
    ok strict-refusal "policy refusal state => exit 125 + marker"
  else
    err strict-refusal "rc=$rc stderr='$got_err'"
  fi

  # 15. The operator hatch bypasses the strict-refusal state visibly.
  got_err="$(PI_BASH_SANDBOX_HOME="$SCRATCH/home" PI_BASH_CONFINE=refuse \
    SKIP_BASH_CONFINEMENT=1 "$WRAPPER" -c 'true' 2>&1 >/dev/null)"
  if printf '%s' "$got_err" | grep -q 'skipped via SKIP_BASH_CONFINEMENT'; then
    ok strict-skip-hatch "operator hatch bypasses strict refusal visibly"
  else
    err strict-skip-hatch "expected visible strict-state skip, got '$got_err'"
  fi

  # 16. An assignment inside the wrapped command cannot bypass outer refusal.
  set +e
  got_err="$(PI_BASH_SANDBOX_HOME="$SCRATCH/home" PI_BASH_CONFINE=refuse \
    "$WRAPPER" -c 'SKIP_BASH_CONFINEMENT=1 true' 2>&1 >/dev/null)"
  rc=$?
  set -e
  if [ "$rc" -eq 125 ] && printf '%s' "$got_err" | grep -q '^landlock-run: refused'; then
    ok strict-inline-non-bypass "inline skip cannot bypass outer refusal"
  else
    err strict-inline-non-bypass "rc=$rc stderr='$got_err'"
  fi

  # 14. SKIP_BASH_CONFINEMENT=1 bypasses with a visible notice.
  got_err="$(PI_BASH_SANDBOX_HOME="$SCRATCH/home" PI_BASH_CONFINE=enforce \
    SKIP_BASH_CONFINEMENT=1 "$WRAPPER" -c 'true' 2>&1 >/dev/null)"
  if printf '%s' "$got_err" | grep -q 'skipped via SKIP_BASH_CONFINEMENT'; then
    ok skip-hatch "SKIP_BASH_CONFINEMENT bypass is visible on stderr"
  else
    err skip-hatch "expected visible skip notice, got '$got_err'"
  fi

  # 15. Grant construction (print seam): worktree + extension grants + scratch
  #     home + device nodes, '--' separator, real bash + original args at the end.
  wt="$SCRATCH/worktree"; mkdir -p "$wt" "$SCRATCH/extra1"
  got="$(PI_BASH_SANDBOX_HOME="$SCRATCH/home" PI_BASH_CONFINE=enforce \
    PI_CONFINE_LAUNCHER="$SCRATCH/fake-launcher" PI_SESSION_WORKTREE="$wt" \
    PI_CONFINE_GRANTS_RW="$SCRATCH/extra1:$SCRATCH/missing-extra" \
    PI_BASH_CONFINE_PRINT=1 "$WRAPPER" -c 'echo hi' 2>/dev/null)"
  fails=""
  printf '%s\n' "$got" | grep -qx -- "$SCRATCH/fake-launcher" || fails="$fails launcher"
  printf '%s\n' "$got" | grep -qx -- '--ro' || fails="$fails ro-flag"
  printf '%s\n' "$got" | grep -qx -- "$wt" || fails="$fails worktree"
  printf '%s\n' "$got" | grep -qx -- "$SCRATCH/extra1" || fails="$fails extra1"
  printf '%s\n' "$got" | grep -qx -- "$SCRATCH/home" || fails="$fails scratch-home"
  printf '%s\n' "$got" | grep -qx -- '/dev/null' || fails="$fails dev-null"
  printf '%s\n' "$got" | grep -qx -- '--' || fails="$fails separator"
  printf '%s\n' "$got" | grep -qx -- 'echo hi' || fails="$fails command"
  if printf '%s\n' "$got" | grep -qx -- "$SCRATCH/missing-extra"; then fails="$fails missing-not-skipped"; fi
  if [ -z "$fails" ]; then
    ok grant-argv "constructed launcher argv carries grants, separator, and command"
  else
    err grant-argv "argv problems:$fails"
  fi
else
  # 16. Non-Linux: enforce mode passes through unconfined (macOS is the
  #     Seatbelt leg, #707) — the wrapped command still runs.
  got="$(PI_BASH_SANDBOX_HOME="$SCRATCH/home" PI_BASH_CONFINE=enforce "$WRAPPER" -c 'echo confined-passthrough')"
  if [ "$got" = "confined-passthrough" ]; then
    ok non-linux-inert "enforce mode is inert passthrough on non-Linux"
  else
    err non-linux-inert "expected passthrough output, got '$got'"
  fi
fi

echo "=================================="
if [ "$errors" -gt 0 ]; then
  echo "FAIL — $errors error(s)"
  exit 1
fi
echo "PASS — 0 errors"
exit 0
