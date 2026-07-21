#!/usr/bin/env bash
#
# test-artifact-handoff.sh — runs the artifact-handoff extension test suite.
#
# Uses node --import tsx --test against test/*.test.ts. Pulls tsx via npx (same
# pattern as scripts/test-indexing.sh). Exits 0 on pass, 1 on test failures, 2 on
# environment problems (missing node/npx or extension-deps hydration failure).
#
# test/index.test.ts imports index.ts, which imports `typebox` at runtime (the
# Type.Object tool schema), so the suite hydrates extension-deps (ADR-0021). The
# path-confinement tests use real temp dirs + real symlinks; no `ccc`/network.
#
# Run:
#   ./scripts/test-artifact-handoff.sh                normal output
#   VERBOSE=1 ./scripts/test-artifact-handoff.sh      raw test runner output
#
# Tracked: #824 (epic #780 item 16 — path-confinement hardening + first tests).

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "test-artifact-handoff.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VERBOSE="${VERBOSE:-0}"
EXT_DIR="agent/extensions/artifact-handoff"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR test-artifact-handoff: node not found in PATH" >&2
  exit 2
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR test-artifact-handoff: npx not found in PATH (install Node.js)" >&2
  exit 2
fi

# index.test.ts imports index.ts -> needs typebox hydrated (ADR-0021), lockstep
# with the other extension test runners.
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/extension-deps.sh"
if ! ensure_extension_deps; then
  echo "ERROR test-artifact-handoff: extension-deps install failed" >&2
  exit 2
fi

# bash 3.2 (macOS system bash) lacks `mapfile`. Portable equivalent.
test_files=()
while IFS= read -r line; do
  test_files+=("$line")
done < <(find "$EXT_DIR/test" -maxdepth 1 -name "*.test.ts" | sort)
if [ "${#test_files[@]}" -eq 0 ]; then
  echo "ERROR test-artifact-handoff: no test files under $EXT_DIR/test/" >&2
  exit 2
fi

if [ "$VERBOSE" = "1" ]; then
  echo "INFO test-artifact-handoff: running ${#test_files[@]} test file(s)"
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
  echo "OK   artifact-handoff tests passed (${#test_files[@]} file(s))"
  exit 0
fi
echo "ERROR artifact-handoff tests failed (exit $status)" >&2
exit 1
