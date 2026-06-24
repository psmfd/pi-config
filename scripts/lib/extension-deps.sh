#!/usr/bin/env bash
#
# extension-deps.sh — sourceable helper that installs pinned dependencies
# needed to type-check + lint agent/extensions/**/*.ts into an out-of-tree
# cache, and ensures a `node_modules` symlink at the repo root points into
# the cache so tsc + eslint can resolve modules via the standard upward
# directory walk.
#
# Implements ADR-0021 (Type-checking and linting for agent/extensions/).
#
# Design notes:
#   - Cache lives under $HOME/.cache/pi_config/extension-deps/ keyed by a
#     manifest hash of the pinned versions. Operators get a one-time
#     download per pin-version-set; CI gets the same.
#   - Repo root contains a `node_modules` SYMLINK to the cache. Gitignored.
#     This is the load-bearing piece — tsc + eslint walk parent dirs for
#     `node_modules`; npx-temp-dir installs are invisible to them when run
#     from repo root.
#   - No package.json is committed at repo root. The package.json that
#     enables `npm install` lives only inside the cache dir.
#   - Pinned versions are the single source of truth. Bump them deliberately.
#
# Usage:
#   source scripts/lib/extension-deps.sh
#   ensure_extension_deps              # installs/refreshes cache, sets symlink
#   echo "$EXTENSION_DEPS_DIR"         # absolute path to cache dir
#   echo "$EXTENSION_DEPS_NODE_MODULES" # absolute path to its node_modules
#
# Exit codes (when ensure_extension_deps fails):
#   2 — missing npm/node, or cache-dir unwritable

# Pinned versions. Bump deliberately; the hash of these strings drives
# cache invalidation.
EXTENSION_DEPS_TYPESCRIPT_VERSION="${EXTENSION_DEPS_TYPESCRIPT_VERSION:-5.6.3}"
EXTENSION_DEPS_TYPES_NODE_VERSION="${EXTENSION_DEPS_TYPES_NODE_VERSION:-22.10.5}"
EXTENSION_DEPS_ESLINT_VERSION="${EXTENSION_DEPS_ESLINT_VERSION:-9.17.0}"
EXTENSION_DEPS_TSESLINT_VERSION="${EXTENSION_DEPS_TSESLINT_VERSION:-8.19.1}"
EXTENSION_DEPS_PI_AGENT_VERSION="${EXTENSION_DEPS_PI_AGENT_VERSION:-0.75.5}"
EXTENSION_DEPS_TYPEBOX_VERSION="${EXTENSION_DEPS_TYPEBOX_VERSION:-1.1.38}"

# Manifest string used for cache-key hashing. Order matters for hash stability.
__extension_deps_manifest() {
	printf 'typescript@%s\n@types/node@%s\neslint@%s\ntypescript-eslint@%s\n@earendil-works/pi-coding-agent@%s\n@earendil-works/pi-agent-core@%s\n@earendil-works/pi-ai@%s\n@earendil-works/pi-tui@%s\ntypebox@%s\n' \
		"$EXTENSION_DEPS_TYPESCRIPT_VERSION" \
		"$EXTENSION_DEPS_TYPES_NODE_VERSION" \
		"$EXTENSION_DEPS_ESLINT_VERSION" \
		"$EXTENSION_DEPS_TSESLINT_VERSION" \
		"$EXTENSION_DEPS_PI_AGENT_VERSION" \
		"$EXTENSION_DEPS_PI_AGENT_VERSION" \
		"$EXTENSION_DEPS_PI_AGENT_VERSION" \
		"$EXTENSION_DEPS_PI_AGENT_VERSION" \
		"$EXTENSION_DEPS_TYPEBOX_VERSION"
}

__extension_deps_hash() {
	__extension_deps_manifest | shasum -a 256 | awk '{print $1}' | cut -c1-12
}

ensure_extension_deps() {
	local repo_root
	repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

	if ! command -v npm >/dev/null 2>&1; then
		echo "ERROR extension-deps: npm not found in PATH" >&2
		return 2
	fi
	if ! command -v node >/dev/null 2>&1; then
		echo "ERROR extension-deps: node not found in PATH" >&2
		return 2
	fi

	local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/pi_config/extension-deps"
	local hash
	hash="$(__extension_deps_hash)"
	EXTENSION_DEPS_DIR="$cache_root/$hash"
	EXTENSION_DEPS_NODE_MODULES="$EXTENSION_DEPS_DIR/node_modules"

	mkdir -p "$cache_root" || {
		echo "ERROR extension-deps: cannot create $cache_root" >&2
		return 2
	}

	# Install if cache stamp absent. Stamp file marks a complete install;
	# its absence triggers a fresh install regardless of partial state.
	if [ ! -f "$EXTENSION_DEPS_DIR/.installed" ]; then
		mkdir -p "$EXTENSION_DEPS_DIR"
		# Write package.json with pinned versions. exact semver pins via "=".
		cat >"$EXTENSION_DEPS_DIR/package.json" <<EOF
{
	"name": "pi_config-extension-deps",
	"private": true,
	"version": "0.0.0",
	"description": "Pinned dependencies for agent/extensions/ type-check + lint (ADR-0021). Not published; not committed.",
	"dependencies": {
		"typescript": "$EXTENSION_DEPS_TYPESCRIPT_VERSION",
		"@types/node": "$EXTENSION_DEPS_TYPES_NODE_VERSION",
		"eslint": "$EXTENSION_DEPS_ESLINT_VERSION",
		"typescript-eslint": "$EXTENSION_DEPS_TSESLINT_VERSION",
		"@earendil-works/pi-coding-agent": "$EXTENSION_DEPS_PI_AGENT_VERSION",
		"@earendil-works/pi-agent-core": "$EXTENSION_DEPS_PI_AGENT_VERSION",
		"@earendil-works/pi-ai": "$EXTENSION_DEPS_PI_AGENT_VERSION",
		"@earendil-works/pi-tui": "$EXTENSION_DEPS_PI_AGENT_VERSION",
		"typebox": "$EXTENSION_DEPS_TYPEBOX_VERSION"
	}
}
EOF
		echo "INFO extension-deps: installing pinned deps into $EXTENSION_DEPS_DIR" >&2
		( cd "$EXTENSION_DEPS_DIR" && npm install --no-audit --no-fund --silent ) || {
			echo "ERROR extension-deps: npm install failed in $EXTENSION_DEPS_DIR" >&2
			return 2
		}
		touch "$EXTENSION_DEPS_DIR/.installed"
	fi

	# Ensure repo-root `node_modules` symlink points at the active cache.
	# If it exists pointing somewhere else (e.g., a previous version), refresh.
	local link="$repo_root/node_modules"
	if [ -L "$link" ]; then
		local current_target
		current_target="$(readlink "$link")"
		if [ "$current_target" != "$EXTENSION_DEPS_NODE_MODULES" ]; then
			rm "$link"
			ln -s "$EXTENSION_DEPS_NODE_MODULES" "$link"
		fi
	elif [ -e "$link" ]; then
		echo "ERROR extension-deps: $link exists and is not a symlink; refusing to overwrite" >&2
		return 2
	else
		ln -s "$EXTENSION_DEPS_NODE_MODULES" "$link"
	fi

	export EXTENSION_DEPS_DIR EXTENSION_DEPS_NODE_MODULES
	return 0
}
