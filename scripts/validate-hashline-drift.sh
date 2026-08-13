#!/usr/bin/env bash
# scripts/validate-hashline-drift.sh
#
# Content-hash manifest check for the vendored hashline-edit extension source
# (ADR-0134). Fails when agent/extensions/hashline-edit/{index.ts,src/**,
# prompts/**} drifts from the pinned upstream RimuruW/pi-hashline-edit v0.8.3
# snapshot in a way not recorded in PATCH_MANIFEST.json, or when a local
# addition appears that the manifest does not list.
#
# Unlike scripts/validate-subagent-drift.sh (which reads the upstream pi
# snapshot from ~/.cache), this check is hermetic: the pristine upstream
# source tarball is committed at
# agent/extensions/hashline-edit/upstream/pi-hashline-edit-v0.8.3-src.tar.gz
# and verified against its recorded sha256 before use.
#
# Modes:
#   (no args)      — check mode; validates manifest matches current state
#   --regenerate   — rewrite the manifest from the current state
#   --help         — usage
#
# Exit codes (per agent/rules/script-output-conventions.md):
#   0   success (manifest matches, or --regenerate wrote the file)
#   1   drift detected / manifest mismatch / bad inputs
#   2   invalid CLI usage

set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$REPO_DIR/agent/extensions/hashline-edit"
MANIFEST="$EXT_DIR/PATCH_MANIFEST.json"
TARBALL="$EXT_DIR/upstream/pi-hashline-edit-v0.8.3-src.tar.gz"
TARBALL_SHA_FILE="$TARBALL.sha256"

usage() {
	cat <<'EOF'
Usage: scripts/validate-hashline-drift.sh [--regenerate | --help]

Validate that agent/extensions/hashline-edit's vendored source diverges from
the pinned upstream snapshot only in ways recorded in PATCH_MANIFEST.json.
EOF
}

MODE="check"
if [ "$#" -gt 0 ]; then
	case "$1" in
	--regenerate) MODE="regenerate" ;;
	--help)
		usage
		exit 0
		;;
	*)
		echo "ERROR validate-hashline-drift: unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
fi

if ! command -v jq >/dev/null 2>&1; then
	echo "ERROR validate-hashline-drift: jq is required" >&2
	exit 1
fi

sha256_of() {
	shasum -a 256 "$1" | awk '{print $1}'
}

for required in "$TARBALL" "$TARBALL_SHA_FILE"; do
	if [ ! -f "$required" ]; then
		echo "ERROR validate-hashline-drift: missing $required" >&2
		exit 1
	fi
done

expected_tarball_sha="$(tr -d '[:space:]' <"$TARBALL_SHA_FILE")"
actual_tarball_sha="$(sha256_of "$TARBALL")"
if [ "$expected_tarball_sha" != "$actual_tarball_sha" ]; then
	echo "ERROR validate-hashline-drift: upstream tarball sha256 mismatch" >&2
	echo "  expected: $expected_tarball_sha" >&2
	echo "  actual:   $actual_tarball_sha" >&2
	exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hashline-drift.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
tar xzf "$TARBALL" -C "$WORK_DIR"

# File sets. Tracked scope: the source surfaces vendored from upstream.
# Local additions (vendor/, test/, containment.ts, tsconfig, README, ...)
# are listed in the manifest's localAdditions so new unrecorded files fail.
upstream_files() {
	(cd "$WORK_DIR" && find index.ts src prompts -type f 2>/dev/null | sort)
}

local_scope_files() {
	(cd "$EXT_DIR" && find index.ts src prompts -type f 2>/dev/null | sort)
}

if [ "$MODE" = "regenerate" ]; then
	tracked_json="{}"
	while IFS= read -r rel; do
		up_sha="$(sha256_of "$WORK_DIR/$rel")"
		if [ -f "$EXT_DIR/$rel" ]; then
			local_sha="$(sha256_of "$EXT_DIR/$rel")"
			state="present"
		else
			local_sha=""
			state="deleted"
		fi
		tracked_json="$(printf '%s' "$tracked_json" | jq \
			--arg rel "$rel" --arg up "$up_sha" --arg loc "$local_sha" --arg state "$state" \
			'. + {($rel): {upstreamSha256: $up, localSha256: $loc, state: $state}}')"
	done <<EOF_FILES
$(upstream_files)
EOF_FILES

	additions_json="[]"
	while IFS= read -r rel; do
		if [ ! -f "$WORK_DIR/$rel" ]; then
			additions_json="$(printf '%s' "$additions_json" | jq --arg rel "$rel" '. + [$rel]')"
		fi
	done <<EOF_LOCAL
$(local_scope_files)
EOF_LOCAL

	jq -n \
		--argjson tracked "$tracked_json" \
		--argjson additions "$additions_json" \
		--arg tarballSha "$actual_tarball_sha" \
		'{
			manifestVersion: 1,
			upstream: {
				repo: "RimuruW/pi-hashline-edit",
				tag: "v0.8.3",
				commit: "ba7db9943d0f58499b24c1f6bd64722580f772a5",
				tarballSha256: $tarballSha
			},
			trackedFiles: $tracked,
			localAdditions: $additions,
			note: "See agent/extensions/hashline-edit/README.md for the patch table. Regenerate with: scripts/validate-hashline-drift.sh --regenerate"
		}' >"$MANIFEST"
	echo "OK   validate-hashline-drift: manifest regenerated at $MANIFEST"
	exit 0
fi

if [ ! -f "$MANIFEST" ]; then
	echo "ERROR validate-hashline-drift: missing $MANIFEST (run --regenerate)" >&2
	exit 1
fi

errors=0

manifest_tarball_sha="$(jq -r '.upstream.tarballSha256' "$MANIFEST")"
if [ "$manifest_tarball_sha" != "$actual_tarball_sha" ]; then
	echo "ERROR validate-hashline-drift: manifest upstream.tarballSha256 does not match the tarball" >&2
	errors=$((errors + 1))
fi

# 1. Every upstream file must be tracked with matching hashes.
while IFS= read -r rel; do
	entry="$(jq -r --arg rel "$rel" '.trackedFiles[$rel] // empty' "$MANIFEST")"
	if [ -z "$entry" ]; then
		echo "ERROR validate-hashline-drift: upstream file not in manifest: $rel" >&2
		errors=$((errors + 1))
		continue
	fi
	up_expected="$(jq -r --arg rel "$rel" '.trackedFiles[$rel].upstreamSha256' "$MANIFEST")"
	up_actual="$(sha256_of "$WORK_DIR/$rel")"
	if [ "$up_expected" != "$up_actual" ]; then
		echo "ERROR validate-hashline-drift: upstream hash mismatch for $rel (tarball vs manifest)" >&2
		errors=$((errors + 1))
	fi
	state="$(jq -r --arg rel "$rel" '.trackedFiles[$rel].state' "$MANIFEST")"
	if [ -f "$EXT_DIR/$rel" ]; then
		if [ "$state" != "present" ]; then
			echo "ERROR validate-hashline-drift: $rel exists locally but manifest state is '$state'" >&2
			errors=$((errors + 1))
			continue
		fi
		local_expected="$(jq -r --arg rel "$rel" '.trackedFiles[$rel].localSha256' "$MANIFEST")"
		local_actual="$(sha256_of "$EXT_DIR/$rel")"
		if [ "$local_expected" != "$local_actual" ]; then
			echo "ERROR validate-hashline-drift: unrecorded local drift in $rel (run --regenerate after reviewing the change)" >&2
			errors=$((errors + 1))
		fi
	else
		if [ "$state" != "deleted" ]; then
			echo "ERROR validate-hashline-drift: $rel missing locally but manifest state is '$state'" >&2
			errors=$((errors + 1))
		fi
	fi
done <<EOF_FILES2
$(upstream_files)
EOF_FILES2

# 2. Every local file in scope must be tracked or a recorded addition.
while IFS= read -r rel; do
	in_tracked="$(jq -r --arg rel "$rel" '.trackedFiles | has($rel)' "$MANIFEST")"
	in_additions="$(jq -r --arg rel "$rel" '.localAdditions | index($rel) != null' "$MANIFEST")"
	if [ "$in_tracked" != "true" ] && [ "$in_additions" != "true" ]; then
		echo "ERROR validate-hashline-drift: unrecorded local file: $rel (add via --regenerate)" >&2
		errors=$((errors + 1))
	fi
done <<EOF_LOCAL2
$(local_scope_files)
EOF_LOCAL2

if [ "$errors" -gt 0 ]; then
	echo "ERROR validate-hashline-drift: $errors problem(s) found" >&2
	exit 1
fi

echo "OK   validate-hashline-drift: vendored source matches PATCH_MANIFEST.json"
exit 0
