#!/usr/bin/env bash
#
# check-ext-ref-drift.sh — report (and optionally fix) drift between the
# hand-edited version pins in install.sh (per-extension name@vX.Y.Z) and
# install-expertise.sh (a single EXT_REF) and the latest published GitHub
# Release tag of each overlay mirror.
#
# The overlay repo list is DERIVED from mirror/targets.yml (the sync manifest,
# ADR-0050) — the same single-source-of-truth pattern as check-mirror-alerts.sh —
# so this gate can never drift from the set of live mirrors.
#
# Extended surfaces (#566, coupled to the pi runtime pin at
# `agent/vendor/pi/VERSION` rather than to a mirror release — the
# "always match runtime" policy):
#
#   scripts/lib/extension-deps.sh  EXTENSION_DEPS_PI_AGENT_VERSION
#   agent/settings.example.json    lastChangelogVersion
#
# These use bare X.Y.Z (no `v` prefix); the mirror pins use vX.Y.Z. See
# `runtime_semver` and `fix_semver_pin` below for the parallel helpers.
#
# Usage:
#   scripts/check-ext-ref-drift.sh [--fix] [--target NAME] [--verbose] [-h|--help]
#
# Flags:
#   --fix       Rewrite a stale pin in place when a SAFE (strictly-newer) bump
#               exists. Both install-expertise.sh (1:1 with pi-expertise-client)
#               and install.sh's PER-EXTENSION pins (name@vX.Y.Z, ADR-0075) are
#               auto-fixable independently — each mirror carries its own pin, so
#               the old shared-EXT_REF divergence refusal (#492) no longer applies.
#   --target N  Limit the check to one overlay target name from the manifest,
#               OR one of the extended-surface names: `extension-deps` /
#               `settings-example`.
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

# Manifest-derived target names are interpolated into grep/sed programs and yq
# filter strings below, so constrain them to the same safe slug shape
# sync-mirror.sh's valid_name() enforces (defense against expression injection
# from the manifest; lockstep with scripts/sync-mirror.sh).
valid_name() { case "$1" in ''|*[!a-z0-9-]*) return 1 ;; *) return 0 ;; esac; }

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
  # bash [[ =~ ]] anchors the WHOLE string (grep -qE '^..$' anchors per line, so
  # a $new containing an embedded newline like "v1.2.3\n<payload>" would slip
  # through grep and inject the trailing content into the rewrite).
  if ! [[ "$new" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
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

# install_pin_of <name>: the version pinned for <name> in install.sh's
# EXT_MIRRORS array (name@vX.Y.Z), or empty. Anchored to an INDENTED array-entry
# line (`^[[:space:]]+name@`) — the leading `@` alone would still match a
# `name@vX.Y.Z` shape in a comment or help-text, so the line-shape anchor scopes
# it to real entries (mirrors validate.sh's array-bounded parser).
install_pin_of() {
  grep -oE "^[[:space:]]+${1}@v[0-9]+\.[0-9]+\.[0-9]+" "$INSTALL_FILE" | head -n1 | sed -E 's/^.*@//'
}

# runtime_semver: the pi runtime pin, stripped to bare X.Y.Z for comparison
# with the extended-surface pins below (which are bare semver, not vX.Y.Z).
# `agent/vendor/pi/VERSION` shape is `vX.Y.Z-psmfd.N`; strip the leading `v`
# and any `-suffix` (psmfd or upstream-rollback), then anchor-validate. Empty
# output = unresolvable (missing file or malformed); callers WARN and skip.
runtime_semver() {
  local v
  [ -f "$REPO_DIR/agent/vendor/pi/VERSION" ] || { printf ''; return 1; }
  v="$(head -n1 "$REPO_DIR/agent/vendor/pi/VERSION" | tr -d '[:space:]')"
  v="${v#v}"; v="${v%%-*}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf ''; return 1; }
  printf '%s' "$v"
}

# fix_extdeps_pin <new>: rewrite EXTENSION_DEPS_PI_AGENT_VERSION's default in
# scripts/lib/extension-deps.sh (bare X.Y.Z inside `${VAR:-X.Y.Z}`). Same
# command-injection hardening as fix_pin: anchored semver check on $new,
# anchored sed against the specific `${VAR:-...}` shape, tempfile + `cat >`.
fix_extdeps_pin() {
  local new="$1" tmp
  if ! [[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    err fix "extension-deps.sh: refusing to write a non-X.Y.Z value: $new"; return 1
  fi
  tmp="$(mktemp "${EXTDEPS_FILE}.XXXXXX")"
  if sed -E "s#^(EXTENSION_DEPS_PI_AGENT_VERSION=\"\\\$\{EXTENSION_DEPS_PI_AGENT_VERSION:-)[0-9]+\.[0-9]+\.[0-9]+(\}\")#\1${new}\2#" \
    "$EXTDEPS_FILE" > "$tmp"; then
    cat "$tmp" > "$EXTDEPS_FILE"; rm -f "$tmp"; return 0
  fi
  rm -f "$tmp"; err fix "extension-deps.sh: sed rewrite failed"; return 1
}

# fix_settings_changelog_pin <new>: rewrite lastChangelogVersion in
# agent/settings.example.json. JSON is a subset of a line-oriented sed target
# here (the whole "key": "X.Y.Z", pair lives on a single line by convention);
# we anchor on the key name so no other X.Y.Z string in the file is affected.
fix_settings_changelog_pin() {
  local new="$1" tmp
  if ! [[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    err fix "settings.example.json: refusing to write a non-X.Y.Z value: $new"; return 1
  fi
  tmp="$(mktemp "${SETTINGS_FILE}.XXXXXX")"
  if sed -E "s#(\"lastChangelogVersion\"[[:space:]]*:[[:space:]]*\")[0-9]+\.[0-9]+\.[0-9]+(\")#\1${new}\2#" \
    "$SETTINGS_FILE" > "$tmp"; then
    cat "$tmp" > "$SETTINGS_FILE"; rm -f "$tmp"; return 0
  fi
  rm -f "$tmp"; err fix "settings.example.json: sed rewrite failed"; return 1
}

# fix_install_pin <name> <new>: rewrite the <name>@vX.Y.Z pin in install.sh,
# preserving the file's mode. Same anchored-semver guard as fix_pin ($new is an
# untrusted release tag interpolated into a bash-source line + a sed program).
fix_install_pin() {
  local name="$1" new="$2" tmp
  if ! [[ "$new" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    err fix "install.sh: refusing to write a non-vX.Y.Z value: $new"; return 1
  fi
  tmp="$(mktemp "${INSTALL_FILE}.XXXXXX")"
  # Anchor to an INDENTED array entry so a name@version shape elsewhere (comment,
  # help-text) is never rewritten; \1 preserves the entry's indentation.
  if sed -E "s|^([[:space:]]+)${name}@v[0-9]+\.[0-9]+\.[0-9]+|\1${name}@${new}|" "$INSTALL_FILE" > "$tmp"; then
    cat "$tmp" > "$INSTALL_FILE"; rm -f "$tmp"; return 0
  fi
  rm -f "$tmp"; err fix "install.sh: sed rewrite failed for $name"; return 1
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
      drift_unresolved=1
      warn drift "install-expertise.sh: $EXP_REPO pinned $exp_pin is AHEAD of latest $exp_latest (unreleased pin? pi install may fail)"
    fi
  fi
fi

# --- install.sh: PER-EXTENSION pins (name@vX.Y.Z in EXT_MIRRORS) --------------
# Each overlay mirror carries its own pin (ADR-0075), so drift and --fix are
# per-extension and independent — the shared-EXT_REF divergence problem (#492)
# is gone. --fix bumps only pins strictly older than the mirror's latest
# release; a pin AHEAD of latest (unreleased) is reported, never downgraded.
INSTALL_FILE="$REPO_DIR/install.sh"
if ! grep -q '^EXT_MIRRORS=(' "$INSTALL_FILE"; then
  err discover "install.sh: no EXT_MIRRORS=( array found"
else
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ -n "$TARGET" ] && [ "$name" != "$TARGET" ] && continue
    if ! valid_name "$name"; then
      err drift "manifest target name is not a safe slug (expect lowercase [a-z0-9-]): $name"
      continue
    fi
    repo="$(yq -r ".targets[] | select(.name==\"$name\") | .repo" "$MANIFEST")"
    pin="$(install_pin_of "$name")"
    if [ -z "$pin" ]; then
      err drift "install.sh: $name has no name@vX.Y.Z pin in EXT_MIRRORS (onboarding drift — see #512)"
      continue
    fi
    latest="$(latest_release "$repo")"
    if [ -z "$latest" ]; then
      err drift "install.sh: could not resolve latest release for $repo"
      continue
    fi
    if [ "$pin" = "$latest" ]; then
      detail "install.sh: $repo pinned $pin matches latest"
    elif ver_gt "$latest" "$pin"; then
      drift_found=1
      warn drift "install.sh: $repo pinned $pin, latest is $latest"
      if [ "$FIX" = 1 ] && fix_install_pin "$name" "$latest"; then
        ok fix "install.sh: $name -> $latest"
      else
        drift_unresolved=1
      fi
    else
      # Pin is newer than the mirror's latest release: the tag may not exist as a
      # release (typo / hand-edit) and `pi install ...@$pin` would then fail. Not
      # auto-fixable (never downgrade), but surface it via the exit code.
      drift_unresolved=1
      warn drift "install.sh: $repo pinned $pin is AHEAD of latest $latest (unreleased pin? pi install may fail)"
    fi
  done < <(yq -r '.targets[] | select(.mode=="overlay") | .name' "$MANIFEST")
fi

# --- Runtime-coupled surfaces (#566) ------------------------------------------
# Pins here track `agent/vendor/pi/VERSION` (the "always match runtime" policy),
# NOT a producer mirror release. The runtime pin is the source of truth; a
# runtime bump should be followed by a bump of each surface here in the same or
# a companion PR, and this workflow's belt/suspenders now catches the miss.
#
# Bare X.Y.Z (no `v` prefix) is the on-disk shape for both surfaces; ver_gt
# strips `v` automatically so mixed-shape compares work.
RUNTIME_PIN="$(runtime_semver)" || RUNTIME_PIN=""
if [ -z "$RUNTIME_PIN" ]; then
  warn discover "agent/vendor/pi/VERSION missing or malformed — skipping runtime-coupled surface checks"
fi

# Parse regex per surface. Anchored on the specific `${VAR:-...}` shape / the
# specific JSON key name; drift on any other X.Y.Z-shaped string in these files
# will never trigger, nor be rewritten.
EXTDEPS_FILE="$REPO_DIR/scripts/lib/extension-deps.sh"
EXTDEPS_PARSE_RE='^EXTENSION_DEPS_PI_AGENT_VERSION="\$\{EXTENSION_DEPS_PI_AGENT_VERSION:-([0-9]+\.[0-9]+\.[0-9]+)\}"'
SETTINGS_FILE="$REPO_DIR/agent/settings.example.json"
SETTINGS_PARSE_RE='"lastChangelogVersion":[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)"'

# check_runtime_coupled <label> <target-filter-name> <file> <parse-regex> <fix-fn>:
# common flow. Reports OK/WARN/ERROR, honours --target, applies --fix via the
# per-surface rewriter, and NEVER downgrades an ahead-of-runtime pin (surfaced
# as WARN + drift_unresolved, mirroring the mirror-ahead-of-latest path).
check_runtime_coupled() {
  local label="$1" filter="$2" file="$3" parse_re="$4" fixer="$5" pin
  [ -n "$TARGET" ] && [ "$TARGET" != "$filter" ] && return 0
  [ -z "$RUNTIME_PIN" ] && return 0
  if [ ! -f "$file" ]; then
    err drift "$label: file not found: $file"; return 0
  fi
  pin="$(sed -nE "s#.*${parse_re}.*#\1#p" "$file" | head -n1)"
  if [ -z "$pin" ]; then
    err drift "$label: could not parse pin from $(basename "$file")"; return 0
  fi
  if [ "$pin" = "$RUNTIME_PIN" ]; then
    detail "$label: $(basename "$file") pin $pin matches runtime $RUNTIME_PIN"
  elif ver_gt "$RUNTIME_PIN" "$pin"; then
    drift_found=1
    warn drift "$label: $(basename "$file") pinned $pin, runtime is $RUNTIME_PIN"
    if [ "$FIX" = 1 ] && "$fixer" "$RUNTIME_PIN"; then
      ok fix "$label: $(basename "$file") -> $RUNTIME_PIN"
    else
      drift_unresolved=1
    fi
  else
    drift_unresolved=1
    warn drift "$label: $(basename "$file") pinned $pin is AHEAD of runtime $RUNTIME_PIN (bump runtime, or reset pin)"
  fi
}

check_runtime_coupled "extension-deps"   "extension-deps"    "$EXTDEPS_FILE"  "$EXTDEPS_PARSE_RE"  fix_extdeps_pin
check_runtime_coupled "settings-example" "settings-example" "$SETTINGS_FILE" "$SETTINGS_PARSE_RE" fix_settings_changelog_pin

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
