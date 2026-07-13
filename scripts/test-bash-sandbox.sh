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

echo "=================================="
if [ "$errors" -gt 0 ]; then
  echo "FAIL — $errors error(s)"
  exit 1
fi
echo "PASS — 0 errors"
exit 0
