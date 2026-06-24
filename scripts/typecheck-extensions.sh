#!/usr/bin/env bash
#
# typecheck-extensions.sh — type-checks every agent/extensions/* against
# its per-extension tsconfig.json. Implements ADR-0021 Axis A.
#
# Run:
#   ./scripts/typecheck-extensions.sh           normal output
#   VERBOSE=1 ./scripts/typecheck-extensions.sh raw tsc output per extension
#
# Exit codes:
#   0 — all extensions type-check clean
#   1 — one or more extensions emitted type errors
#   2 — environment failure (missing npm/node, or extension-deps install failed)

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "typecheck-extensions: cannot cd to $REPO_DIR" >&2; exit 2; }

VERBOSE="${VERBOSE:-0}"

# Pull in the cache helper. ADR-0021 Axis C: pinned deps installed once
# into $HOME/.cache/pi_config/extension-deps/<hash>/ with a node_modules
# symlink at repo root.
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/extension-deps.sh"

if ! ensure_extension_deps; then
	echo "ERROR typecheck-extensions: extension-deps install failed" >&2
	exit 2
fi

TSC="$REPO_DIR/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
	echo "ERROR typecheck-extensions: tsc not found at $TSC after extension-deps install" >&2
	exit 2
fi

# bash 3.2 (macOS system bash) lacks `mapfile`. Portable equivalent.
tsconfigs=()
while IFS= read -r line; do
	tsconfigs+=("$line")
done < <(find agent/extensions -mindepth 2 -maxdepth 2 -name tsconfig.json | sort)
if [ "${#tsconfigs[@]}" -eq 0 ]; then
	echo "ERROR typecheck-extensions: no per-extension tsconfig.json found under agent/extensions/" >&2
	exit 2
fi

if [ "$VERBOSE" = "1" ]; then
	echo "INFO typecheck-extensions: checking ${#tsconfigs[@]} extension(s)"
fi

fail=0
for tsconfig in "${tsconfigs[@]}"; do
	ext="$(basename "$(dirname "$tsconfig")")"
	if [ "$VERBOSE" = "1" ]; then
		echo "==> tsc --noEmit -p $tsconfig"
		"$TSC" --noEmit -p "$tsconfig"
		rc=$?
	else
		out="$("$TSC" --noEmit -p "$tsconfig" 2>&1)"
		rc=$?
		if [ "$rc" -ne 0 ]; then
			echo "ERROR typecheck-extensions: $ext failed:" >&2
			printf '%s\n' "$out" >&2
		fi
	fi
	if [ "$rc" -ne 0 ]; then
		fail=$((fail + 1))
	fi
done

if [ "$fail" -eq 0 ]; then
	echo "OK   typecheck-extensions: ${#tsconfigs[@]} extension(s) type-checked clean"
	exit 0
fi
echo "ERROR typecheck-extensions: $fail of ${#tsconfigs[@]} extension(s) failed" >&2
exit 1
