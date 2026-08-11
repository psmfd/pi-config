#!/usr/bin/env bash
#
# lint-extensions.sh — runs ESLint v9 with @typescript-eslint type-aware
# rules against agent/extensions/**/*.ts. Implements ADR-0021 Axis B.
#
# Configuration: eslint.config.js at repo root (flat config).
#
# Run:
#   ./scripts/lint-extensions.sh           normal output
#   VERBOSE=1 ./scripts/lint-extensions.sh raw eslint output (always shown)
#   FIX=1 ./scripts/lint-extensions.sh     run with --fix (local iteration)
#
# Exit codes:
#   0 — zero errors (warnings allowed)
#   1 — one or more lint errors
#   2 — environment failure (missing npm/node, or extension-deps install failed)

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "lint-extensions: cannot cd to $REPO_DIR" >&2; exit 2; }

VERBOSE="${VERBOSE:-0}"
FIX="${FIX:-0}"

# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/extension-deps.sh"

if ! ensure_extension_deps; then
	echo "ERROR lint-extensions: extension-deps install failed" >&2
	exit 2
fi

ESLINT="$REPO_DIR/node_modules/.bin/eslint"
if [ ! -x "$ESLINT" ]; then
	echo "ERROR lint-extensions: eslint not found at $ESLINT after extension-deps install" >&2
	exit 2
fi

# ESLint's type-aware rules build one TypeScript program spanning all extensions.
# The pi 0.84.1 + TypeBox 1.3.7 type graph pushes peak heap past Node's ~2 GB
# default, which OOMs on CI runners ("Ineffective mark-compacts near heap limit",
# pi_config #953) while passing on higher-RAM dev machines. Raise the ceiling
# unless the caller already pinned one.
case "${NODE_OPTIONS:-}" in
	*--max-old-space-size=*) : ;;
	*) NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=6144" ;;
esac
export NODE_OPTIONS

args=("agent/extensions/**/*.ts")
if [ "$FIX" = "1" ]; then
	args+=("--fix")
fi

# Always capture output so we can parse the summary line for warning count.
out="$("$ESLINT" "${args[@]}" 2>&1)"
rc=$?
if [ "$VERBOSE" = "1" ]; then
	printf '%s\n' "$out"
elif [ "$rc" -ne 0 ]; then
	printf '%s\n' "$out" >&2
fi

# Parse counts from eslint's summary line ("✖ N problems (E errors, W warnings)").
# Pure-success runs (zero problems) emit no summary line.
warn_count="$(printf '%s\n' "$out" | sed -nE 's/.*[0-9]+ problems? \([0-9]+ errors?, ([0-9]+) warnings?\).*/\1/p' | tail -1)"

if [ "$rc" -eq 0 ]; then
	echo "OK   lint-extensions: 0 errors, ${warn_count:-0} warning(s)"
	exit 0
fi
echo "ERROR lint-extensions: lint errors present" >&2
exit 1
