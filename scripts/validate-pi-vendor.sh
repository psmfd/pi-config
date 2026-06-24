#!/usr/bin/env bash
#
# validate-pi-vendor.sh — structural validator for agent/vendor/pi/.
#
# Verifies:
#   1. VERSION file exists, is non-empty, and starts with 'v' followed by
#      a semver-ish token.
#   2. CHECKSUMS file exists and contains one entry for each expected
#      platform asset (the six upstream-published triples).
#   3. Each CHECKSUMS line is well-formed: `<64-hex> <2-space> <asset-name>`.
#
# Does NOT fetch anything. Network-free; safe in CI without GitHub access.
#
# Exit codes:
#   0 — vendor surface is structurally consistent
#   1 — one or more validation errors
#   2 — environment failure (script invoked from wrong dir, etc.)

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "validate-pi-vendor.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VENDOR_DIR="agent/vendor/pi"
VERSION_FILE="$VENDOR_DIR/VERSION"
CHECKSUMS_FILE="$VENDOR_DIR/CHECKSUMS"
README_FILE="$VENDOR_DIR/README.md"

# EXPECTED_ASSETS is derived after VERSION is read: PSMFD pins
# (vX.Y.Z-psmfd.N, ADR-0040) embed the tag in every asset name; plain
# upstream pins use the bare upstream basenames.
EXPECTED_ASSETS=""

errors=0

err() { printf 'ERROR pi-vendor: %s\n' "$*" >&2; errors=$((errors + 1)); }

# --- 1. VERSION file -------------------------------------------------------
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

# Derive the expected six-asset inventory from the pin form (ADR-0040).
asset_suffix=""
if printf '%s' "${version_value:-}" | grep -qE '\-psmfd\.[0-9]+$'; then
  asset_suffix="-${version_value}"
fi
EXPECTED_ASSETS="pi-darwin-arm64${asset_suffix}.tar.gz pi-darwin-x64${asset_suffix}.tar.gz pi-linux-arm64${asset_suffix}.tar.gz pi-linux-x64${asset_suffix}.tar.gz pi-windows-arm64${asset_suffix}.zip pi-windows-x64${asset_suffix}.zip"

# --- 2. CHECKSUMS file -----------------------------------------------------
if [ ! -f "$CHECKSUMS_FILE" ]; then
  err "missing $CHECKSUMS_FILE"
else
  if [ ! -s "$CHECKSUMS_FILE" ]; then
    err "$CHECKSUMS_FILE is empty"
  fi

  # Every line must be: 64-hex, two spaces, filename. No blank, no comments.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if ! printf '%s' "$line" | grep -qE '^[0-9a-f]{64}  [A-Za-z0-9._-]+$'; then
      err "$CHECKSUMS_FILE: malformed line: $line"
    fi
  done < "$CHECKSUMS_FILE"

  # Every expected asset must appear exactly once.
  for asset in $EXPECTED_ASSETS; do
    count="$(awk -v a="$asset" '$2 == a {c++} END{print c+0}' "$CHECKSUMS_FILE")"
    if [ "$count" = "0" ]; then
      err "$CHECKSUMS_FILE: missing entry for $asset"
    elif [ "$count" != "1" ]; then
      err "$CHECKSUMS_FILE: $asset appears $count times (expected exactly 1)"
    fi
  done

  # No unexpected asset entries (catches typos and obsolete triples).
  while IFS= read -r asset; do
    [ -n "$asset" ] || continue
    case " $EXPECTED_ASSETS " in
      *" $asset "*) : ;;
      *) err "$CHECKSUMS_FILE: unexpected asset entry: $asset" ;;
    esac
  done < <(awk '{print $2}' "$CHECKSUMS_FILE")
fi

# --- 3. README sanity ------------------------------------------------------
if [ ! -f "$README_FILE" ]; then
  err "missing $README_FILE"
else
  if ! grep -qE '[Pp]i[^A-Za-z0-9]+v?[0-9]+\.[0-9]+\.[0-9]+' "$README_FILE"; then
    err "$README_FILE: must cite the pinned pi version"
  fi
  # Cross-check: README must cite the SAME pin as VERSION. Strip the leading
  # 'v' on the pin so we match both 'v0.75.3' (tag form) and '0.75.3' (bare).
  if [ -n "${version_value:-}" ]; then
    pin_bare="${version_value#v}"
    if ! grep -qF "$pin_bare" "$README_FILE"; then
      err "$README_FILE: does not cite the current pin '$version_value' (looked for '$pin_bare')"
    fi
  fi
  if ! grep -q 'ADR-0009\|0009-pi-runtime-acquisition-strategy' "$README_FILE"; then
    err "$README_FILE: must cross-reference ADR-0009"
  fi
fi

if [ "$errors" -gt 0 ]; then
  exit 1
fi
exit 0
