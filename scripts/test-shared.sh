#!/usr/bin/env bash
#
# test-shared.sh — runs the shared/ foundation library test suite.
#
# Uses node --import tsx --test against test/*.test.ts. Pulls tsx via npx
# (same pattern as scripts/test-compaction-optimizer.sh). Exits 0 on pass,
# 1 on test failures, 2 on environment problems (missing node/npx).
#
# Run:
#   ./scripts/test-shared.sh                     normal output
#   VERBOSE=1 ./scripts/test-shared.sh           raw test runner output
#
# Tracked: #329 (Phase 1 — shared/ foundation).

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "test-shared.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VERBOSE="${VERBOSE:-0}"
EXT_DIR="agent/extensions/shared"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR test-shared: node not found in PATH" >&2
  exit 2
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR test-shared: npx not found in PATH (install Node.js)" >&2
  exit 2
fi

# bash 3.2 (macOS system bash) lacks `mapfile`. Portable equivalent.
test_files=()
while IFS= read -r line; do
  test_files+=("$line")
done < <(find "$EXT_DIR/test" -maxdepth 1 -name "*.test.ts" | sort)
if [ "${#test_files[@]}" -eq 0 ]; then
  echo "ERROR test-shared: no test files under $EXT_DIR/test/" >&2
  exit 2
fi

if [ "$VERBOSE" = "1" ]; then
  echo "INFO test-shared: running ${#test_files[@]} test file(s)"
  for f in "${test_files[@]}"; do echo "  - $f"; done
fi

# tsx@4 is the current major; pin to a known-working minor for reproducibility.
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
  echo "OK   shared tests passed (${#test_files[@]} file(s))"
  exit 0
fi
echo "ERROR shared tests failed (exit $status)" >&2
exit 1
