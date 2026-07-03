#!/usr/bin/env bash
#
# validate-yq-vendor.sh — structural validator for agent/vendor/yq/.
#
# Verifies VERSION (vN.N.N tag), CHECKSUMS (one entry per expected platform
# asset, well-formed lines), and README (cites the pinned version + ADR-0011
# + the mikefarah-vs-kislyuk disambiguation note). Network-free.
#
# Exit codes: 0 = OK, 1 = validation errors, 2 = environment failure.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "validate-yq-vendor.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VENDOR_DIR="agent/vendor/yq"
VERSION_FILE="$VENDOR_DIR/VERSION"
CHECKSUMS_FILE="$VENDOR_DIR/CHECKSUMS"
README_FILE="$VENDOR_DIR/README.md"

# yq assets are NOT tag-templated — the binary name is constant across tags.
EXPECTED_ASSETS="yq_linux_amd64.tar.gz yq_linux_arm64.tar.gz yq_darwin_amd64.tar.gz yq_darwin_arm64.tar.gz"

errors=0
err() { printf 'ERROR yq-vendor: %s\n' "$*" >&2; errors=$((errors + 1)); }

# --- 1. VERSION ------------------------------------------------------------
version_value=""
if [ ! -f "$VERSION_FILE" ]; then
  err "missing $VERSION_FILE"
else
  version_value="$(head -n1 "$VERSION_FILE" | tr -d '[:space:]')"
  if [ -z "$version_value" ]; then
    err "$VERSION_FILE is empty"
  elif ! printf '%s' "$version_value" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+'; then
    err "$VERSION_FILE: pin '$version_value' is not a vN.N.N-style tag"
  fi
fi

# --- 2. CHECKSUMS ----------------------------------------------------------
if [ ! -f "$CHECKSUMS_FILE" ]; then
  err "missing $CHECKSUMS_FILE"
else
  if [ ! -s "$CHECKSUMS_FILE" ]; then
    err "$CHECKSUMS_FILE is empty"
  fi

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if ! printf '%s' "$line" | grep -qE '^[0-9a-f]{64}  [A-Za-z0-9._-]+$'; then
      err "$CHECKSUMS_FILE: malformed line: $line"
    fi
  done < "$CHECKSUMS_FILE"

  for asset in $EXPECTED_ASSETS; do
    count="$(awk -v a="$asset" '$2 == a {c++} END{print c+0}' "$CHECKSUMS_FILE")"
    if [ "$count" = "0" ]; then
      err "$CHECKSUMS_FILE: missing entry for $asset"
    elif [ "$count" != "1" ]; then
      err "$CHECKSUMS_FILE: $asset appears $count times (expected exactly 1)"
    fi
  done

  while IFS= read -r asset; do
    [ -n "$asset" ] || continue
    case " $EXPECTED_ASSETS " in
      *" $asset "*) : ;;
      *) err "$CHECKSUMS_FILE: unexpected asset entry: $asset" ;;
    esac
  done < <(awk '{print $2}' "$CHECKSUMS_FILE")
fi

# --- 3. README -------------------------------------------------------------
if [ ! -f "$README_FILE" ]; then
  err "missing $README_FILE"
else
  if [ -n "${version_value:-}" ]; then
    pin_bare="${version_value#v}"
    if ! grep -qF "$pin_bare" "$README_FILE"; then
      err "$README_FILE: does not cite the current pin '$version_value' (looked for '$pin_bare')"
    fi
  fi
  if ! grep -q 'ADR-0011\|0011-toolchain-install-strategy' "$README_FILE"; then
    err "$README_FILE: must cross-reference ADR-0011"
  fi
  # Specific to yq: README must call out the mikefarah-vs-kislyuk hazard
  # (so a future reader does not 'simplify' it away without re-reading ADR-0011).
  if ! grep -qi 'mikefarah' "$README_FILE" || ! grep -qi 'kislyuk' "$README_FILE"; then
    err "$README_FILE: must mention both 'mikefarah' and 'kislyuk' (disambiguation per ADR-0011)"
  fi
fi

if [ "$errors" -gt 0 ]; then
  exit 1
fi
exit 0
