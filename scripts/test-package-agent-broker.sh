#!/usr/bin/env bash
#
# test-package-agent-broker.sh — runs the package-agent-broker extension
# test suite (#916, ADR-0128).
#
# Uses node --import tsx --test against test/*.test.ts (same pattern as
# scripts/test-token-meter.sh). The broker's pi imports are type-only in the
# tested modules, so this needs no extension-deps hydration. Exits 0 on pass,
# 1 on test failures, 2 on environment problems (missing node/npx).
#
# Run:
#   ./scripts/test-package-agent-broker.sh                normal output
#   VERBOSE=1 ./scripts/test-package-agent-broker.sh      raw test runner output
#
# Tracked: package-agent-broker extension (non-authorizing review drafts).

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "test-package-agent-broker.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VERBOSE="${VERBOSE:-0}"
EXT_DIR="agent/extensions/package-agent-broker"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR test-package-agent-broker: node not found in PATH" >&2
  exit 2
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR test-package-agent-broker: npx not found in PATH (install Node.js)" >&2
  exit 2
fi

# bash 3.2 (macOS system bash) lacks `mapfile`. Portable equivalent.
test_files=()
while IFS= read -r line; do
  test_files+=("$line")
done < <(find "$EXT_DIR/test" -maxdepth 1 -name "*.test.ts" | sort)
if [ "${#test_files[@]}" -eq 0 ]; then
  echo "ERROR test-package-agent-broker: no test files under $EXT_DIR/test/" >&2
  exit 2
fi

if [ "$VERBOSE" = "1" ]; then
  echo "INFO test-package-agent-broker: running ${#test_files[@]} test file(s)"
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
  echo "OK   package-agent-broker tests passed (${#test_files[@]} file(s))"
  exit 0
fi
echo "ERROR package-agent-broker tests failed (exit $status)" >&2
exit 1
