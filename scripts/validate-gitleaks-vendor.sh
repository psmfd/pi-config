#!/usr/bin/env bash
#
# validate-gitleaks-vendor.sh — structural validator for agent/vendor/gitleaks/.
#
# Verifies VERSION (vN.N.N tag), CHECKSUMS (one entry per expected platform
# asset, well-formed lines, tag-templated), and README (cites the pinned
# version + ADR-0037). Network-free.
#
# Exit codes: 0 = OK, 1 = validation errors, 2 = environment failure.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "validate-gitleaks-vendor.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VENDOR_DIR="agent/vendor/gitleaks"
VERSION_FILE="$VENDOR_DIR/VERSION"
CHECKSUMS_FILE="$VENDOR_DIR/CHECKSUMS"
README_FILE="$VENDOR_DIR/README.md"

errors=0
err() { printf 'ERROR gitleaks-vendor: %s\n' "$*" >&2; errors=$((errors + 1)); }

# --- 1. VERSION ------------------------------------------------------------
version_value=""
if [ ! -f "$VERSION_FILE" ]; then
  err "missing $VERSION_FILE"
else
  version_value="$(head -n1 "$VERSION_FILE" | tr -d '[:space:]')"
  if [ -z "$version_value" ]; then
    err "$VERSION_FILE is empty"
  elif ! printf '%s' "$version_value" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
    err "$VERSION_FILE: pin '$version_value' is not a vN.N.N-style tag"
  fi
fi

ver_bare="${version_value#v}"
EXPECTED_ASSETS="gitleaks_${ver_bare}_linux_x64.tar.gz gitleaks_${ver_bare}_linux_arm64.tar.gz gitleaks_${ver_bare}_darwin_x64.tar.gz gitleaks_${ver_bare}_darwin_arm64.tar.gz"

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

  if [ -n "$version_value" ]; then
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
fi

# --- 3. README -------------------------------------------------------------
if [ ! -f "$README_FILE" ]; then
  err "missing $README_FILE"
else
  if [ -n "${version_value:-}" ]; then
    if ! grep -qF "$version_value" "$README_FILE"; then
      err "$README_FILE: does not cite the current pin '$version_value'"
    fi
  fi
  if ! grep -q 'ADR-0037\|0037-secret-scanner-tooling-strategy' "$README_FILE"; then
    err "$README_FILE: must cross-reference ADR-0037"
  fi
fi

if [ "$errors" -gt 0 ]; then
  exit 1
fi
exit 0
