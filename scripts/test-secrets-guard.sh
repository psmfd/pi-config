#!/usr/bin/env bash
#
# test-secrets-guard.sh — runs the secrets-guard extension test suite.
#
# Mirrors scripts/test-gh-identity-guard.sh shape. Uses tsx via npx; no
# committed node_modules.
#
# Run:
#   ./scripts/test-secrets-guard.sh                  normal output
#   VERBOSE=1 ./scripts/test-secrets-guard.sh        raw test runner output
#
# Tracked: #258 (announce-bypass backport).

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "test-secrets-guard.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VERBOSE="${VERBOSE:-0}"
EXT_DIR="agent/extensions/secrets-guard"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR test-secrets-guard: node not found in PATH" >&2
  exit 2
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR test-secrets-guard: npx not found in PATH (install Node.js)" >&2
  exit 2
fi

test_files=()
while IFS= read -r line; do
  test_files+=("$line")
done < <(find "$EXT_DIR/test" -maxdepth 1 -name "*.test.ts" | sort)
if [ "${#test_files[@]}" -eq 0 ]; then
  echo "ERROR test-secrets-guard: no test files under $EXT_DIR/test/" >&2
  exit 2
fi

if [ "$VERBOSE" = "1" ]; then
  echo "INFO test-secrets-guard: running ${#test_files[@]} test file(s)"
  for f in "${test_files[@]}"; do echo "  - $f"; done
fi

TSX_VERSION="${TSX_VERSION:-4.19.2}"

set +e
if [ "$VERBOSE" = "1" ]; then
  npx --yes "tsx@${TSX_VERSION}" --test "${test_files[@]}"
  status=$?
else
  output=$(npx --yes "tsx@${TSX_VERSION}" --test "${test_files[@]}" 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$output" >&2
  fi
fi
set -e

if [ "$status" -eq 0 ]; then
  echo "OK   secrets-guard tests passed (${#test_files[@]} file(s))"
  exit 0
fi
echo "ERROR secrets-guard tests failed (exit $status)" >&2
exit 1
