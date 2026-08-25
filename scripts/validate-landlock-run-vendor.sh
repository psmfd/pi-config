#!/usr/bin/env bash
#
# validate-landlock-run-vendor.sh — structural validator for
# agent/vendor/landlock-run/ (ADR-0146, #1046).
#
# Verifies VERSION (npm N.N.N version — no v prefix, unlike the
# GitHub-release vendors), CHECKSUMS (exactly one entry per expected Linux
# platform tarball, well-formed lines, version-templated), and README (cites
# the pinned version, ADR-0146, and the BSD-3-Clause license). Network-free.
# Mirrors validate-bash-parser-vendor.sh.
#
# Exit codes: 0 = OK, 1 = validation errors, 2 = environment failure.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "validate-landlock-run-vendor.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VENDOR_DIR="agent/vendor/landlock-run"
VERSION_FILE="$VENDOR_DIR/VERSION"
CHECKSUMS_FILE="$VENDOR_DIR/CHECKSUMS"
README_FILE="$VENDOR_DIR/README.md"

errors=0
err() { printf 'ERROR landlock-run-vendor: %s\n' "$*" >&2; errors=$((errors + 1)); }

# --- 1. VERSION ------------------------------------------------------------
version_value=""
if [ ! -f "$VERSION_FILE" ]; then
  err "missing $VERSION_FILE"
else
  version_value="$(head -n1 "$VERSION_FILE" | tr -d '[:space:]')"
  if [ -z "$version_value" ]; then
    err "$VERSION_FILE is empty"
  elif ! printf '%s' "$version_value" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    err "$VERSION_FILE: pin '$version_value' is not an npm N.N.N version (no v prefix for this vendor)"
  fi
fi

# Linux-only vendor (ADR-0146): exactly the two prebuilt platform tarballs.
EXPECTED_ASSETS="node-addon-landlock-run-linux-x64-${version_value}.tgz node-addon-landlock-run-linux-arm64-${version_value}.tgz"

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
  if ! grep -q 'ADR-0146\|0146-bash-tool-write-confinement' "$README_FILE"; then
    err "$README_FILE: must cross-reference ADR-0146 (the governing decision)"
  fi
  if ! grep -q 'BSD-3-Clause' "$README_FILE"; then
    err "$README_FILE: must record the BSD-3-Clause license (ADR-0146 D2/D9 correction)"
  fi
fi

if [ "$errors" -gt 0 ]; then
  exit 1
fi
exit 0
