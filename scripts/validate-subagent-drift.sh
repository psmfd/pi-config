#!/usr/bin/env bash
# scripts/validate-subagent-drift.sh
#
# Diff-signature manifest check for the vendored subagent extension source.
# Fails when agent/extensions/subagent/{index,agents}.ts drifts from the
# upstream pi 0.80.2 snapshot in a way not recorded in
# agent/extensions/subagent/PATCH_MANIFEST.json.
#
# Design rationale — pi_config #582 (design review in pi_config #582
# design fan-out); closes the audit trap that let patches #4a–d
# accumulate in the vendored source between the 0.75.4 and 0.80.2
# re-pairs without patch-table registration (pi_config #136, #296, #396).
#
# Sibling mechanism to scripts/validate-pi-vendor.sh (ADR-0009 — but this
# script tightens the vendored-source contract that ADR-0001 governs).
#
# Modes:
#   (no args)      — check mode; validates manifest matches current diffs
#   --regenerate   — rewrite the manifest from the current diffs
#   --help         — usage
#
# Exit codes (per agent/rules/script-output-conventions.md):
#   0   success (manifest matches, or --regenerate wrote the file)
#   1   drift detected / manifest mismatch / bad inputs
#   2   invalid CLI usage
#
# The missing-upstream-snapshot case is a HARD ERROR (exit 1), not a skip:
# per agent/rules/extension-type-check-and-lint.md, required-check
# environment unavailability is a validation error. Fresh clones must run
# setup.sh (which populates ~/.cache/pi_config/pi-<VERSION>/) before
# validate.sh can complete.
#
# Manifest format (v1): see agent/extensions/subagent/PATCH_MANIFEST.json.

set -eu

usage() {
	cat <<'EOF'
Usage: scripts/validate-subagent-drift.sh [--regenerate | --help]

Validate that agent/extensions/subagent/{index,agents}.ts diverges from
the upstream pi snapshot only in ways recorded in
agent/extensions/subagent/PATCH_MANIFEST.json.

Options:
  --regenerate   Recompute manifest hashes from current diffs and rewrite
                 the manifest file. Use this after intentionally adding a
                 new local patch (and updating the README patch table in
                 the same PR) or after a re-pair to a new upstream pi.
  --help         Show this help.

Exit codes: 0 success, 1 drift / mismatch / bad inputs, 2 CLI misuse.
EOF
}

MODE="check"
case "${1:-}" in
	"") ;;
	--regenerate) MODE="regenerate" ;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		echo "ERROR unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
esac

if [ $# -gt 1 ]; then
	echo "ERROR too many arguments" >&2
	usage >&2
	exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION_FILE="agent/vendor/pi/VERSION"
LOCAL_DIR="agent/extensions/subagent"
MANIFEST="$LOCAL_DIR/PATCH_MANIFEST.json"

# Files tracked by the manifest. Ours-only files (model-pin.ts, test/,
# tsconfig.json) are deliberately excluded — the check tracks the
# vendored-vs-upstream contract, not the whole directory.
TRACKED_FILES="index.ts agents.ts"

errors=0
err() {
	echo "ERROR $*" >&2
	errors=$((errors + 1))
}
info() { echo "INFO  $*"; }
ok() { echo "OK    $*"; }

if [ ! -f "$VERSION_FILE" ]; then
	err "missing $VERSION_FILE — cannot resolve upstream snapshot"
	exit 1
fi
PINNED_PI="$(head -n1 "$VERSION_FILE" | tr -d '[:space:]')"
if [ -z "$PINNED_PI" ]; then
	err "$VERSION_FILE is empty"
	exit 1
fi

CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/pi_config"
UPSTREAM_DIR="$CACHE_ROOT/pi-$PINNED_PI/pi/examples/extensions/subagent"

if [ ! -d "$UPSTREAM_DIR" ]; then
	err "upstream snapshot not found: $UPSTREAM_DIR"
	err "  hint: run ./setup.sh (or ./scripts/lib/fetch-pi-binary.sh) to populate the pi $PINNED_PI cache"
	err "  per agent/rules/extension-type-check-and-lint.md, environment unavailability is a validation error, not a skip"
	exit 1
fi

# Compute sha256 of a stream (portable across sha256sum/shasum/openssl).
sha256_stream() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 | awk '{print $1}'
	elif command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 -r | awk '{print $1}'
	else
		echo "ERROR no sha256 tool available (sha256sum/shasum/openssl)" >&2
		return 1
	fi
}

# Compute diff-signature for one tracked file.
# Prints "<sha256> <hunks> <net_added_lines>".
compute_signature() {
	local rel="$1"
	local upstream="$UPSTREAM_DIR/$rel"
	local local_file="$LOCAL_DIR/$rel"

	if [ ! -f "$upstream" ]; then
		err "tracked file missing upstream: $upstream"
		return 1
	fi
	if [ ! -f "$local_file" ]; then
		err "tracked file missing locally: $local_file"
		return 1
	fi

	# `diff -u --strip-trailing-cr` normalises CRLF; --label neutralises the
	# absolute-path header so the hash is stable across machines.
	local diff_out
	diff_out="$(diff -u --strip-trailing-cr \
		--label "upstream/$rel" --label "local/$rel" \
		"$upstream" "$local_file" || true)"

	local diff_sha hunks net
	diff_sha="$(printf '%s' "$diff_out" | sha256_stream)"
	hunks="$(printf '%s' "$diff_out" | grep -c '^@@' || true)"
	# Net added lines: '+' lines (excluding the '+++' header) minus '-' lines
	# (excluding the '---' header).
	local added removed
	added="$(printf '%s\n' "$diff_out" | awk 'BEGIN{c=0} /^\+[^+]/{c++} /^\+$/{c++} END{print c}')"
	removed="$(printf '%s\n' "$diff_out" | awk 'BEGIN{c=0} /^-[^-]/{c++} /^-$/{c++} END{print c}')"
	net=$((added - removed))

	printf '%s %s %s\n' "$diff_sha" "$hunks" "$net"
}

# Extract a JSON field value for a tracked file from the manifest.
# Reads the shape: "index.ts": { "diffSha256": "…", "hunks": N, "netLines": N, ... }
manifest_get() {
	local rel="$1" field="$2"
	awk -v key="\"$rel\"" -v field="\"$field\"" '
		# Find the tracked-file block for this key
		$0 ~ key {infile=1}
		infile && $0 ~ field {
			# Extract the value after the colon; strip quotes/commas/spaces
			sub(/^[^:]*:[[:space:]]*/, "")
			sub(/,[[:space:]]*$/, "")
			gsub(/"/, "")
			print
			exit
		}
	' "$MANIFEST"
}

manifest_get_pinned() {
	awk '
		/"pinnedPiVersion"[[:space:]]*:/ {
			sub(/^[^:]*:[[:space:]]*/, "")
			sub(/,[[:space:]]*$/, "")
			gsub(/"/, "")
			print
			exit
		}
	' "$MANIFEST"
}

# Regenerate mode: write the manifest from current diffs.
if [ "$MODE" = "regenerate" ]; then
	now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
	tmp="$MANIFEST.tmp.$$"
	{
		printf '{\n'
		printf '  "manifestVersion": 1,\n'
		printf '  "pinnedPiVersion": "%s",\n' "$PINNED_PI"
		printf '  "upstreamRelativePath": "examples/extensions/subagent",\n'
		printf '  "trackedFiles": {\n'

		first=1
		# shellcheck disable=SC2086 # deliberate word-splitting of the file list
		set -- $TRACKED_FILES
		while [ $# -gt 0 ]; do
			rel="$1"
			shift
			sig="$(compute_signature "$rel")" || {
				rm -f "$tmp"
				exit 1
			}
			sha="$(echo "$sig" | awk '{print $1}')"
			hunks="$(echo "$sig" | awk '{print $2}')"
			net="$(echo "$sig" | awk '{print $3}')"
			if [ $first -eq 0 ]; then printf ',\n'; fi
			printf '    "%s": {\n' "$rel"
			printf '      "diffSha256": "%s",\n' "$sha"
			printf '      "hunks": %s,\n' "$hunks"
			printf '      "netLines": %s\n' "$net"
			printf '    }'
			first=0
		done
		printf '\n  },\n'
		printf '  "generatedAt": "%s",\n' "$now"
		printf '  "note": "See agent/extensions/subagent/README.md for the patch table. Regenerate with: scripts/validate-subagent-drift.sh --regenerate"\n'
		printf '}\n'
	} >"$tmp"
	mv -f "$tmp" "$MANIFEST"
	ok "manifest regenerated: $MANIFEST (pinnedPiVersion=$PINNED_PI)"
	info "Next: (a) update the patch table in $LOCAL_DIR/README.md to reflect any new/retired patches;"
	info "      (b) commit $MANIFEST and the README together."
	exit 0
fi

# Check mode.
if [ ! -f "$MANIFEST" ]; then
	err "manifest missing: $MANIFEST"
	err "  regenerate with: scripts/validate-subagent-drift.sh --regenerate"
	exit 1
fi

stored_pinned="$(manifest_get_pinned)"
if [ "$stored_pinned" != "$PINNED_PI" ]; then
	err "manifest pinnedPiVersion ('$stored_pinned') != agent/vendor/pi/VERSION ('$PINNED_PI')"
	err "  a runtime bump must regenerate the manifest AND update the patch table in the same PR"
	err "  regenerate: scripts/validate-subagent-drift.sh --regenerate"
fi

# shellcheck disable=SC2086
set -- $TRACKED_FILES
while [ $# -gt 0 ]; do
	rel="$1"
	shift
	stored_sha="$(manifest_get "$rel" "diffSha256")"
	if [ -z "$stored_sha" ]; then
		err "manifest missing entry for tracked file: $rel"
		continue
	fi
	sig="$(compute_signature "$rel")" || continue
	computed_sha="$(echo "$sig" | awk '{print $1}')"
	computed_hunks="$(echo "$sig" | awk '{print $2}')"
	computed_net="$(echo "$sig" | awk '{print $3}')"
	if [ "$computed_sha" = "$stored_sha" ]; then
		ok "$rel: manifest matches (hunks=$computed_hunks, netLines=$computed_net)"
	else
		err "$rel: diff-signature drift"
		err "  stored diffSha256:   $stored_sha"
		err "  computed diffSha256: $computed_sha"
		err "  computed hunks=$computed_hunks netLines=$computed_net"
		err "  remediation:"
		err "    1. Inspect the drift: diff -u '$UPSTREAM_DIR/$rel' '$LOCAL_DIR/$rel'"
		err "    2. Register any new local patches in $LOCAL_DIR/README.md 'Local patches' table"
		err "    3. Regenerate manifest: scripts/validate-subagent-drift.sh --regenerate"
		err "    4. Commit README, source, and manifest together"
	fi
done

if [ $errors -gt 0 ]; then
	echo "FAIL — $errors error(s)"
	exit 1
fi
echo "PASS — 0 errors"
exit 0
