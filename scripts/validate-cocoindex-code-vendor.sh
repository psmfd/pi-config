#!/usr/bin/env bash
#
# validate-cocoindex-code-vendor.sh — structural validator for
# agent/vendor/cocoindex-code/.
#
# Unlike the ADR-0011 binary pins, this records a PyPI engine version plus the
# pinned embedding-model file checksums (pin-not-copy record, not a download
# manifest). Verifies VERSION (bare semver), CHECKSUMS (well-formed sha256
# lines incl. the model weights), and README (cites the version, the model
# revision, and ADR-0033). Network-free.
#
# Exit codes: 0 = OK, 1 = validation errors, 2 = environment failure.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "validate-cocoindex-code-vendor.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VENDOR_DIR="agent/vendor/cocoindex-code"
VERSION_FILE="$VENDOR_DIR/VERSION"
CHECKSUMS_FILE="$VENDOR_DIR/CHECKSUMS"
README_FILE="$VENDOR_DIR/README.md"

# The model revision must match agent/extensions/indexing/pin.ts (MODEL_REVISION).
MODEL_REVISION="d8c86521100d3556476a063fc2342036d45c106f"

errors=0
err() { printf 'ERROR cocoindex-code-vendor: %s\n' "$*" >&2; errors=$((errors + 1)); }

# --- 1. VERSION ------------------------------------------------------------
version_value=""
if [ ! -f "$VERSION_FILE" ]; then
  err "missing $VERSION_FILE"
else
  version_value="$(head -n1 "$VERSION_FILE" | tr -d '[:space:]')"
  if [ -z "$version_value" ]; then
    err "$VERSION_FILE is empty"
  elif ! printf '%s' "$version_value" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    err "$VERSION_FILE: pin '$version_value' is not a bare semver (e.g. 0.2.35)"
  fi
fi

# --- 2. CHECKSUMS ----------------------------------------------------------
if [ ! -f "$CHECKSUMS_FILE" ]; then
  err "missing $CHECKSUMS_FILE"
elif [ ! -s "$CHECKSUMS_FILE" ]; then
  err "$CHECKSUMS_FILE is empty"
else
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if ! printf '%s' "$line" | grep -qE '^[0-9a-f]{64}  [A-Za-z0-9._/-]+$'; then
      err "$CHECKSUMS_FILE: malformed line: $line"
    fi
  done < "$CHECKSUMS_FILE"
  # The weights file is the load-bearing trust-on-first-use anchor.
  if ! awk '{print $2}' "$CHECKSUMS_FILE" | grep -q 'model\.safetensors$'; then
    err "$CHECKSUMS_FILE: missing the model.safetensors weights entry"
  fi
fi

# --- 3. README -------------------------------------------------------------
if [ ! -f "$README_FILE" ]; then
  err "missing $README_FILE"
else
  if [ -n "$version_value" ] && ! grep -qF "$version_value" "$README_FILE"; then
    err "$README_FILE: does not cite the current pin '$version_value'"
  fi
  if ! grep -qF "$MODEL_REVISION" "$README_FILE"; then
    err "$README_FILE: does not cite the pinned model revision '$MODEL_REVISION'"
  fi
  if ! grep -q 'ADR-0033\|0033-codebase-indexing' "$README_FILE"; then
    err "$README_FILE: must cross-reference ADR-0033"
  fi
fi

if [ "$errors" -gt 0 ]; then
  exit 1
fi
exit 0
