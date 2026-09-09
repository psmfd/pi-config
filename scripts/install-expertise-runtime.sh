#!/usr/bin/env bash
# install-expertise-runtime.sh — install the A2/P3 digest-attested Linux ARM64
# expertise runtime generation (ADR-0156, ADR-0157, ADR-0158).
#
# Usage:
#   scripts/install-expertise-runtime.sh                 install or revalidate
#   scripts/install-expertise-runtime.sh --check-manifest validate manifests only
#
# Exit codes (from the Python implementation): 0 installed, selected, or
# revalidated; 1 classified refusal; 2 configuration or environment failure
# (also: python3 or the implementation missing); 3 unexpected filesystem error.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
installer="$repo_root/scripts/install-expertise-runtime.py"

if ! command -v python3 >/dev/null 2>&1; then
  printf 'ERROR python3 is required for expertise runtime installation\n' >&2
  exit 2
fi
if [ ! -f "$installer" ]; then
  printf 'ERROR expertise runtime installer implementation is missing\n' >&2
  exit 2
fi

exec python3 "$installer" "$@"
