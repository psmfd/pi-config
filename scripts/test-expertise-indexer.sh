#!/usr/bin/env bash
#
# test-expertise-indexer.sh — runs the expertise-indexer extension test suite.
#
# Uses node --import tsx --test against test/*.test.ts. Pulls tsx via npx
# (same pattern as scripts/test-subagent.sh and scripts/test-shared.sh).
# Exits 0 on pass, 1 on test failures, 2 on environment problems.
#
# Run:
#   ./scripts/test-expertise-indexer.sh                normal output
#   VERBOSE=1 ./scripts/test-expertise-indexer.sh      raw test runner output
#
# Tracked: pi_config #598 (canonicalizer + cache), epic #595.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "test-expertise-indexer.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VERBOSE="${VERBOSE:-0}"
EXT_DIR="agent/extensions/expertise-indexer"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR test-expertise-indexer: node not found in PATH" >&2
  exit 2
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR test-expertise-indexer: npx not found in PATH (install Node.js)" >&2
  exit 2
fi

# Lockstep with the other extension test runners (ADR-0021).
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/extension-deps.sh"
if ! ensure_extension_deps; then
  echo "ERROR test-expertise-indexer: extension-deps install failed" >&2
  exit 2
fi

# bash 3.2 (macOS system bash) lacks `mapfile`. Portable equivalent.
test_files=()
while IFS= read -r line; do
  test_files+=("$line")
done < <(find "$EXT_DIR/test" -maxdepth 1 -name "*.test.ts" | sort)
if [ "${#test_files[@]}" -eq 0 ]; then
  echo "ERROR test-expertise-indexer: no test files under $EXT_DIR/test/" >&2
  exit 2
fi

if [ "$VERBOSE" = "1" ]; then
  echo "INFO test-expertise-indexer: running ${#test_files[@]} test file(s)"
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
  echo "OK   expertise-indexer tests passed (${#test_files[@]} file(s))"
  exit 0
fi
echo "ERROR expertise-indexer tests failed (exit $status)" >&2
exit 1
