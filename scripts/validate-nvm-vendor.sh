#!/usr/bin/env bash
#
# validate-nvm-vendor.sh — structural validator for agent/vendor/nvm/.
#
# Mirrors scripts/validate-pi-vendor.sh; same pattern, different asset
# inventory (nvm pins a single install.sh, not a per-platform matrix).
#
# Verifies:
#   1. VERSION file exists, is non-empty, and starts with 'v' followed by
#      a semver-ish token.
#   2. CHECKSUMS file exists and contains exactly one entry: install.sh.
#   3. The CHECKSUMS line is well-formed: `<64-hex>  install.sh`.
#   4. README cites the pinned tag and cross-references ADR-0010.
#
# Does NOT fetch anything. Network-free; safe in CI without network access.
#
# Exit codes:
#   0 — vendor surface is structurally consistent
#   1 — one or more validation errors
#   2 — environment failure

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "validate-nvm-vendor.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VENDOR_DIR="agent/vendor/nvm"
VERSION_FILE="$VENDOR_DIR/VERSION"
CHECKSUMS_FILE="$VENDOR_DIR/CHECKSUMS"
README_FILE="$VENDOR_DIR/README.md"

errors=0
err() { printf 'ERROR nvm-vendor: %s\n' "$*" >&2; errors=$((errors + 1)); }

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

# --- 2 & 3. CHECKSUMS ------------------------------------------------------
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

  # Exactly one entry, and that entry must be install.sh.
  count="$(awk 'NF{c++} END{print c+0}' "$CHECKSUMS_FILE")"
  if [ "$count" != "1" ]; then
    err "$CHECKSUMS_FILE: expected exactly 1 entry, found $count"
  fi
  install_sh_count="$(awk '$2 == "install.sh" {c++} END{print c+0}' "$CHECKSUMS_FILE")"
  if [ "$install_sh_count" != "1" ]; then
    err "$CHECKSUMS_FILE: missing or duplicate entry for install.sh (count=$install_sh_count)"
  fi
fi

# --- 4. README -------------------------------------------------------------
if [ ! -f "$README_FILE" ]; then
  err "missing $README_FILE"
else
  if [ -n "$version_value" ]; then
    pin_bare="${version_value#v}"
    if ! grep -qF "$pin_bare" "$README_FILE"; then
      err "$README_FILE: does not cite the current pin '$version_value' (looked for '$pin_bare')"
    fi
  fi
  if ! grep -q 'ADR-0010\|0010-setup-install-trust-posture' "$README_FILE"; then
    err "$README_FILE: must cross-reference ADR-0010"
  fi
fi

if [ "$errors" -gt 0 ]; then
  exit 1
fi
exit 0
