#!/usr/bin/env bash
#
# check-ext-ref-drift.sh — report (and optionally fix) drift between the
# hand-edited EXT_REF pins in install.sh / install-expertise.sh and the latest
# published GitHub Release tag of each overlay mirror.
#
# The overlay repo list is DERIVED from mirror/targets.yml (the sync manifest,
# ADR-0050) — the same single-source-of-truth pattern as check-mirror-alerts.sh —
# so this gate can never drift from the set of live mirrors.
#
# Usage:
#   scripts/check-ext-ref-drift.sh [--fix] [--target NAME] [--verbose] [-h|--help]
#
# Flags:
#   --fix       Rewrite a pin in place when a SAFE bump is possible (see policy
#               below). install-expertise.sh (1:1 with pi-expertise-client) is
#               auto-fixable; install.sh's SHARED EXT_REF is NOT auto-fixed while
#               mirrors have diverged (see #492) — it would pin a tag some mirrors
#               lack. --fix on a divergent install.sh reports ERROR and no-ops.
#   --target N  Limit the check to one overlay target name from the manifest.
#   --verbose   Print per-repo detail.
#   -h|--help   Print this help and exit.
#
# Exit codes:
#   0 — no drift (or --fix resolved every safely-fixable drift)
#   1 — drift found (report mode), or a --fix rewrite failed / was refused
#   2 — environment/precondition failure (missing gh/yq, manifest not found)
#
# Requires: gh (authenticated), yq (mikefarah). Per the script-output-conventions
# rule (ADR-0068 shares the ver_gt helper it sources).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR" || { printf 'ERROR [ext-ref-drift] cannot cd to %s\n' "$REPO_DIR" >&2; exit 2; }
MANIFEST="$REPO_DIR/mirror/targets.yml"

# Numeric semver compare (ver_gt), shared with release.sh/sync-mirror.sh.
# shellcheck source=scripts/lib/semver-classify.sh
. "$SCRIPT_DIR/lib/semver-classify.sh"

errors=0
warnings=0
ok()     { printf 'OK    [%s] %s\n' "$1" "$2"; }
warn()   { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; warnings=$((warnings + 1)); }
err()    { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }
detail() { [ "${VERBOSE:-0}" = "1" ] && printf '      %s\n' "$*" || true; }

FIX=0; TARGET=""; VERBOSE="${VERBOSE:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --fix)     FIX=1; shift ;;
    --target)  TARGET="${2:?--target requires a name}"; shift 2 ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help) sed -nE '/^# /{s/^# ?//;p;}; /^$/q' "$0"; exit 0 ;;
    *) err args "unknown flag: $1"; exit 2 ;;
  esac
done

command -v gh >/dev/null 2>&1 || { err deps "gh not found"; exit 2; }
command -v yq >/dev/null 2>&1 || { err deps "yq not found"; exit 2; }
[ -f "$MANIFEST" ] || { err deps "manifest not found: $MANIFEST"; exit 2; }

# pin_of <file>: the single EXT_REF="vX.Y.Z" pin declared in <file>.
pin_of() { sed -nE 's/^EXT_REF="(v[0-9]+\.[0-9]+\.[0-9]+)"/\1/p' "$1" | head -n1; }

# latest_release <owner/repo>: latest published release tag, or empty.
latest_release() { gh api "repos/$1/releases/latest" --jq '.tag_name' 2>/dev/null || true; }

# fix_pin <file> <new>: rewrite the EXT_REF pin in place, preserving the file's
# mode/exec bit (rewrite the existing inode rather than mv'ing a 0600 tempfile).
# BSD/GNU sed differ on -i, so never use -i: sed to a tempfile, then `cat >`.
fix_pin() {
  local file="$1" new="$2" tmp
  # ANCHORED semver check (grep -qE ^...$), NOT a glob. `$new` is an untrusted
  # release tag_name fetched from a producer repo, and it is interpolated below
  # into a bash-source `EXT_REF="..."` line and a sed program. A glob
  # (v[0-9]*.[0-9]*.[0-9]*) accepts shell/sed metacharacters (`"`, `$`, `(`,
  # `/`), so a crafted tag like v1.2"$(cmd)".3 would be written verbatim and
  # execute on the next `bash install*.sh` run — a command-injection primitive.
  # The anchor rejects anything but a strict vX.Y.Z.
  if ! printf '%s' "$new" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
    err fix "$file: refusing to write a non-vX.Y.Z value: $new"; return 1
  fi
  tmp="$(mktemp "${file}.XXXXXX")"
  if sed -E "s/^EXT_REF=\"v[0-9]+\.[0-9]+\.[0-9]+\"/EXT_REF=\"${new}\"/" "$file" > "$tmp"; then
    cat "$tmp" > "$file"
    rm -f "$tmp"
    ok fix "$(basename "$file"): EXT_REF -> $new"
  else
    rm -f "$tmp"; err fix "$(basename "$file"): sed rewrite failed"; return 1
  fi
}

# drift_found: any drift observed (drives the report). drift_unresolved: drift
# that remains after this run — the exit signal, so a --fix that resolves every
# safely-fixable pin exits 0 (the documented contract).
drift_found=0
drift_unresolved=0

# --- install-expertise.sh: 1:1 with pi-expertise-client (safely fixable) ------
EXP_FILE="$REPO_DIR/install-expertise.sh"
EXP_REPO="psmfd/pi-expertise-client"
if [ -z "$TARGET" ] || [ "$TARGET" = "pi-expertise-client" ]; then
  exp_pin="$(pin_of "$EXP_FILE")"
  if [ -z "$exp_pin" ]; then
    err discover "install-expertise.sh: no EXT_REF=\"vX.Y.Z\" line found"
  else
    exp_latest="$(latest_release "$EXP_REPO")"
    if [ -z "$exp_latest" ]; then
      err drift "install-expertise.sh: could not resolve latest release for $EXP_REPO"
    elif [ "$exp_pin" = "$exp_latest" ]; then
      ok drift "install-expertise.sh: $EXP_REPO pinned $exp_pin matches latest"
    elif ver_gt "$exp_latest" "$exp_pin"; then
      drift_found=1
      warn drift "install-expertise.sh: $EXP_REPO pinned $exp_pin, latest is $exp_latest"
      if [ "$FIX" = 1 ] && fix_pin "$EXP_FILE" "$exp_latest"; then
        : # resolved
      else
        drift_unresolved=1
      fi
    else
      warn drift "install-expertise.sh: $EXP_REPO pinned $exp_pin is AHEAD of latest $exp_latest (unreleased pin?)"
    fi
  fi
fi

# --- install.sh: ONE shared EXT_REF across all overlay mirrors ----------------
# Report per-repo. Because a single pin cannot represent 11 independently-
# versioned mirrors (#492), --fix is refused whenever the mirrors' latest tags
# are not all identical and newer than the pin.
INSTALL_FILE="$REPO_DIR/install.sh"
install_pin="$(pin_of "$INSTALL_FILE")"
if [ -z "$install_pin" ]; then
  err discover "install.sh: no EXT_REF=\"vX.Y.Z\" line found"
else
  lagging_count=0
  total_count=0
  uniform_latest=""
  uniform=1
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ -n "$TARGET" ] && [ "$name" != "$TARGET" ] && continue
    repo="$(yq -r ".targets[] | select(.name==\"$name\") | .repo" "$MANIFEST")"
    latest="$(latest_release "$repo")"
    total_count=$((total_count + 1))
    if [ -z "$latest" ]; then
      err drift "install.sh: could not resolve latest release for $repo"
      uniform=0
      continue
    fi
    if [ "$install_pin" = "$latest" ]; then
      detail "install.sh: $repo pinned $install_pin matches latest"
    else
      drift_found=1
      lagging_count=$((lagging_count + 1))
      warn drift "install.sh: $repo pinned $install_pin, latest is $latest"
    fi
    if [ -z "$uniform_latest" ]; then uniform_latest="$latest"
    elif [ "$uniform_latest" != "$latest" ]; then uniform=0; fi
  done < <(yq -r '.targets[] | select(.mode=="overlay") | .name' "$MANIFEST")

  if [ "$lagging_count" -gt 0 ]; then
    warn drift "install.sh: shared EXT_REF ($install_pin) is stale for ${lagging_count}/${total_count} mirror(s)"
    # install.sh's single EXT_REF spans ALL overlay mirrors, so it is auto-fixable
    # ONLY on a full (non-targeted), uniform scan that is strictly newer. Under
    # --target, `uniform` is computed over one mirror and is trivially true — a
    # --fix there would rewrite the shared pin to that one mirror's tag (the #492
    # divergence footgun the header promises to refuse), so a targeted run is
    # report-only for the shared pin.
    install_resolved=0
    if [ -z "$TARGET" ] && [ "$uniform" = 1 ] && [ "$FIX" = 1 ] && ver_gt "$uniform_latest" "$install_pin"; then
      if fix_pin "$INSTALL_FILE" "$uniform_latest"; then install_resolved=1; fi
    fi
    if [ "$install_resolved" = 0 ]; then
      drift_unresolved=1
      if [ -n "$TARGET" ]; then
        detail "install.sh: shared EXT_REF not evaluated for --fix under --target (report only)"
      elif [ "$uniform" != 1 ]; then
        err drift "install.sh: overlay mirrors have DIVERGENT versions — a single shared EXT_REF cannot represent them (#492); refusing --fix"
      elif [ "$FIX" = 1 ]; then
        err fix "install.sh: shared EXT_REF not safely auto-fixable (#492)"
      fi
    fi
  elif [ "$total_count" -gt 0 ]; then
    ok drift "install.sh: shared EXT_REF ($install_pin) matches all ${total_count} checked mirror(s)"
  fi
fi

echo "=================================="
if [ "$errors" -gt 0 ]; then
  printf 'FAIL — %s error(s), %s warning(s)\n' "$errors" "$warnings"
  exit 1
fi
if [ "$drift_unresolved" = 1 ]; then
  printf 'DRIFT — 0 error(s), %s warning(s)\n' "$warnings"
  exit 1
fi
if [ "$drift_found" = 1 ]; then
  # Drift was observed but every safely-fixable pin was resolved (--fix).
  printf 'PASS (drift resolved) — 0 error(s), %s warning(s)\n' "$warnings"
  exit 0
fi
printf 'PASS — 0 error(s), %s warning(s)\n' "$warnings"
exit 0
