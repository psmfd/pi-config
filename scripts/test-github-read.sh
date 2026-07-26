#!/usr/bin/env bash
# test-github-read.sh — runs github-read and git-read extension test suites.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "ERROR test-github-read: cannot cd to $REPO_DIR" >&2; exit 2; }
VERBOSE="${VERBOSE:-0}"

for cmd in node npx; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR test-github-read: $cmd not found in PATH" >&2
    exit 2
  fi
done

# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/extension-deps.sh"
if ! ensure_extension_deps; then
  echo "ERROR test-github-read: extension-deps install failed" >&2
  exit 2
fi

test_files=()
while IFS= read -r line; do test_files+=("$line"); done < <(
  find agent/extensions/github-read/test agent/extensions/git-read/test -maxdepth 1 -name "*.test.ts" | sort
)
if [ "${#test_files[@]}" -eq 0 ]; then
  echo "ERROR test-github-read: no test files found" >&2
  exit 2
fi

TSX_VERSION="${TSX_VERSION:-4.19.2}"
set +e
if [ "$VERBOSE" = "1" ]; then
  echo "INFO test-github-read: running ${#test_files[@]} test file(s)"
  npx --yes "tsx@${TSX_VERSION}" --test "${test_files[@]}"
  status=$?
else
  output=$(npx --yes "tsx@${TSX_VERSION}" --test "${test_files[@]}" 2>&1)
  status=$?
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&2
fi
set -e

if [ "$status" -eq 0 ]; then
  echo "OK   github-read tests passed (${#test_files[@]} file(s))"
  exit 0
fi
echo "ERROR github-read tests failed (exit $status)" >&2
exit 1
