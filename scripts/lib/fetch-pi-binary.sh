#!/usr/bin/env bash
#
# fetch-pi-binary.sh — sourceable library providing fetch_pi_binary().
#
# Acquires the pinned pi runtime binary as defined in agent/vendor/pi/.
# Per ADR-0009 (Pi runtime acquisition strategy) as amended by ADR-0040:
# PSMFD-form pins (vX.Y.Z-psmfd.N) fetch PSMFD-attested rebuilds from
# psmfd/pi; plain upstream pins remain a rollback path.
#
# Usage:
#   # As a sourced library (the production path):
#   . scripts/lib/fetch-pi-binary.sh
#   fetch_pi_binary                       # uses defaults
#   fetch_pi_binary --quiet               # suppresses INFO lines
#
#   # As a standalone smoke test:
#   scripts/lib/fetch-pi-binary.sh --self-test
#
# Options (all optional):
#   --version <tag>     Override the pin from agent/vendor/pi/VERSION
#   --vendor-dir <dir>  Override the agent/vendor/pi/ path
#   --cache-dir <dir>   Override ~/.cache/pi_config
#   --quiet             Suppress INFO output (errors and warnings still print)
#   --self-test         Run a full smoke test and exit
#
# Output:
#   On success, prints the absolute path to the pi binary on stdout.
#   Status lines (INFO/OK/WARN/ERROR) go to stderr per
#   agent/rules/script-output-conventions.md.
#
# Exit codes:
#   0 — pi binary present and verified at the printed path
#   1 — verification or extraction failure (likely actionable; investigate)
#   2 — environment / precondition failure (missing dependency, unsupported
#       host, missing vendor files)
#
# Dependencies (POSIX coreutils + standard tooling):
#   curl, sha256sum (or shasum -a 256 on macOS), tar, mktemp, uname
#
# Shell-option discipline:
#   `set -uo pipefail` is applied ONLY in the direct-invocation path at the
#   bottom of this file. When the file is sourced (the production path from
#   setup.sh), we do not mutate the caller's shell options — internal error
#   handling is explicit (`|| return N`) throughout.

# --- Output helpers --------------------------------------------------------
__fpb_quiet=0
_fpb_info()  { [ "$__fpb_quiet" = "1" ] || printf 'INFO  %s\n' "$*" >&2; }
_fpb_ok()    { [ "$__fpb_quiet" = "1" ] || printf 'OK    %s\n' "$*" >&2; }
_fpb_warn()  { printf 'WARN  %s\n' "$*" >&2; }
_fpb_error() { printf 'ERROR %s\n' "$*" >&2; }

# --- Internal: detect host triple ------------------------------------------
# Maps `uname -ms` output to the asset-name segment used in pi release filenames.
# Echoes "<os>-<arch>" on success; non-zero exit on unsupported triple.
_fpb_detect_triple() {
  local uname_s uname_m os arch
  uname_s="$(uname -s 2>/dev/null || true)"
  uname_m="$(uname -m 2>/dev/null || true)"

  case "$uname_s" in
    Linux)              os=linux ;;
    Darwin)             os=darwin ;;
    MINGW*|MSYS*|CYGWIN*)
      _fpb_error "Windows-host install is not supported by fetch_pi_binary()."
      _fpb_error "See agent/vendor/pi/README.md § Windows-host limitation and #99."
      return 2
      ;;
    *)
      _fpb_error "unsupported OS from 'uname -s': $uname_s"
      return 2
      ;;
  esac

  case "$uname_m" in
    x86_64|amd64)       arch=x64 ;;
    arm64|aarch64)      arch=arm64 ;;
    *)
      _fpb_error "unsupported architecture from 'uname -m': $uname_m"
      return 2
      ;;
  esac

  printf '%s-%s\n' "$os" "$arch"
}

# --- Internal: sha256 verify (cross-platform) ------------------------------
# Verifies an in-place file against a "<sha256>  <basename>" checksum line.
# Usage: _fpb_verify_sha256 <abs-file-path> <expected-hex>
_fpb_verify_sha256() {
  local path="$1" expected="$2" actual=""

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$path" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$path" | awk '{print $1}')"
  else
    _fpb_error "neither sha256sum nor shasum available; cannot verify"
    return 2
  fi

  if [ "$actual" = "$expected" ]; then
    return 0
  fi
  _fpb_error "checksum mismatch for $(basename "$path")"
  _fpb_error "  expected: $expected"
  _fpb_error "  actual:   $actual"
  return 1
}

# --- Internal: lookup expected checksum from CHECKSUMS ---------------------
# Echoes the hex digest for <asset-basename>; non-zero if not found.
_fpb_lookup_checksum() {
  local checksums="$1" asset="$2" line
  line="$(awk -v a="$asset" '$2 == a {print $1; exit}' "$checksums")"
  if [ -z "$line" ]; then
    _fpb_error "no checksum entry for '$asset' in $checksums"
    return 1
  fi
  printf '%s\n' "$line"
}

# --- Public: fetch_pi_binary -----------------------------------------------
fetch_pi_binary() {
  local repo_root vendor_dir cache_dir version_override=""
  __fpb_quiet=0

  # Resolve repo root from this file's location, so the function works whether
  # sourced from setup.sh or invoked standalone.
  local self_path
  self_path="${BASH_SOURCE[0]:-$0}"
  repo_root="$(cd "$(dirname "$self_path")/../.." && pwd)"
  vendor_dir="$repo_root/agent/vendor/pi"
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/pi_config"

  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || { _fpb_error "--version requires a value"; return 2; }
        version_override="$2"; shift 2 ;;
      --vendor-dir)
        [ $# -ge 2 ] || { _fpb_error "--vendor-dir requires a value"; return 2; }
        vendor_dir="$2"; shift 2 ;;
      --cache-dir)
        [ $# -ge 2 ] || { _fpb_error "--cache-dir requires a value"; return 2; }
        cache_dir="$2"; shift 2 ;;
      --quiet)       __fpb_quiet=1; shift ;;
      *)
        _fpb_error "unknown option: $1"
        return 2
        ;;
    esac
  done

  local version_file="$vendor_dir/VERSION"
  local checksums_file="$vendor_dir/CHECKSUMS"

  if [ ! -f "$version_file" ]; then
    _fpb_error "missing $version_file"
    return 2
  fi
  if [ ! -f "$checksums_file" ]; then
    _fpb_error "missing $checksums_file"
    return 2
  fi

  local tag
  if [ -n "$version_override" ]; then
    tag="$version_override"
  else
    tag="$(head -n1 "$version_file" | tr -d '[:space:]')"
  fi
  if [ -z "$tag" ]; then
    _fpb_error "version pin is empty"
    return 2
  fi

  local triple
  triple="$(_fpb_detect_triple)" || return $?

  # The release surface and asset naming derive from the tag form (ADR-0040):
  # PSMFD tags (vX.Y.Z-psmfd.N) resolve to PSMFD-attested rebuilds on
  # psmfd/pi, whose asset names embed the full tag; plain upstream tags
  # remain a supported emergency-rollback path against earendil-works/pi.
  local release_repo asset
  case "$tag" in
    *-psmfd.*)
      release_repo="psmfd/pi"
      asset="pi-${triple}-${tag}.tar.gz"
      ;;
    *)
      release_repo="earendil-works/pi"
      asset="pi-${triple}.tar.gz"
      ;;
  esac
  local extract_dir="$cache_dir/pi-${tag}"
  local downloads_dir="$cache_dir/downloads"
  local binary_path=""

  local expected
  expected="$(_fpb_lookup_checksum "$checksums_file" "$asset")" || return $?

  # Idempotency: cache hit if the extracted binary exists. We trust the prior
  # extract (which was checksum-gated at first-extract time); requiring the
  # archive to ALSO still be present would force a full re-download whenever
  # a future operator reclaims space from <cache>/downloads/. A separate
  # local-tamper hardening pass is tracked in #109.
  local cached_bin=""
  if [ -f "$extract_dir/pi/pi" ] && [ -x "$extract_dir/pi/pi" ]; then
    cached_bin="$extract_dir/pi/pi"
  elif [ -f "$extract_dir/pi" ] && [ -x "$extract_dir/pi" ]; then
    cached_bin="$extract_dir/pi"
  fi
  if [ -n "$cached_bin" ]; then
    _fpb_ok "cache hit: $cached_bin"
    printf '%s\n' "$cached_bin"
    return 0
  fi

  mkdir -p "$downloads_dir" "$extract_dir" \
    || { _fpb_error "cannot create cache dirs under $cache_dir"; return 1; }

  local archive_path="$downloads_dir/$asset"

  # Use a pre-staged archive if present (air-gapped path) before reaching out.
  if [ -f "$archive_path" ]; then
    _fpb_info "found pre-staged $asset; skipping download"
  else
    if ! command -v curl >/dev/null 2>&1; then
      _fpb_error "curl is required to download $asset (and not pre-staged)"
      return 2
    fi
    local url="https://github.com/${release_repo}/releases/download/${tag}/${asset}"
    _fpb_info "downloading $url"
    local tmp_path="${archive_path}.tmp"
    if ! curl --fail --location --silent --show-error --output "$tmp_path" "$url"; then
      _fpb_error "download failed for $url"
      rm -f "$tmp_path"
      return 1
    fi
    mv -f "$tmp_path" "$archive_path"
  fi

  if ! _fpb_verify_sha256 "$archive_path" "$expected"; then
    # Move the bad archive aside rather than silently retry; bump procedure
    # or operator inspection is needed.
    mv -f "$archive_path" "${archive_path}.bad" 2>/dev/null || true
    return 1
  fi
  _fpb_ok "verified $asset (sha256:${expected:0:12}...)"

  # Extract. We use a temp dir adjacent to the target to make extraction atomic.
  if ! command -v tar >/dev/null 2>&1; then
    _fpb_error "tar is required to extract $asset"
    return 2
  fi
  local extract_tmp
  extract_tmp="$(mktemp -d "${extract_dir}.XXXXXX")" \
    || { _fpb_error "mktemp failed"; return 1; }
  if ! tar -xzf "$archive_path" -C "$extract_tmp"; then
    _fpb_error "tar extract failed"
    rm -rf "$extract_tmp"
    return 1
  fi

  # Locate the extracted binary. Upstream archives nest the executable inside
  # a top-level `pi/` directory (so the layout is `pi/pi`). Allow one or two
  # levels of nesting.
  local found_rel=""
  if [ -f "$extract_tmp/pi" ] && [ -x "$extract_tmp/pi" ]; then
    found_rel="pi"
  else
    found_rel="$(cd "$extract_tmp" \
      && find . -maxdepth 3 -type f -name pi -perm -u+x 2>/dev/null \
      | head -n1 | sed 's|^\./||')"
  fi
  if [ -z "$found_rel" ] || [ ! -f "$extract_tmp/$found_rel" ] || [ ! -x "$extract_tmp/$found_rel" ]; then
    _fpb_error "could not locate executable 'pi' file in extracted archive"
    rm -rf "$extract_tmp"
    return 1
  fi

  # Swap into place. Not atomic against concurrent invocations — a parallel
  # caller could observe the missing $extract_dir window. Acceptable for the
  # single-process setup.sh consumer; if concurrency becomes a real case,
  # switch to mv -T over a sibling-renamed temp.
  rm -rf "$extract_dir"
  if ! mv "$extract_tmp" "$extract_dir"; then
    _fpb_error "atomic swap into $extract_dir failed"
    rm -rf "$extract_tmp"
    return 1
  fi

  binary_path="$extract_dir/$found_rel"
  if [ ! -f "$binary_path" ] || [ ! -x "$binary_path" ]; then
    _fpb_error "post-extract binary not found at $binary_path"
    return 1
  fi

  _fpb_ok "extracted to $extract_dir"
  printf '%s\n' "$binary_path"
  return 0
}

# Standalone --self-test mode invoked as `scripts/lib/fetch-pi-binary.sh --self-test`.
# Captures fetch_pi_binary's stdout (the binary path); status lines (INFO/WARN/
# ERROR on stderr) flow through to the operator's terminal so failures are
# diagnosable without spelunking a tempfile.
_fpb_self_test() {
  local binary
  binary="$(fetch_pi_binary "$@")" || {
    _fpb_error "self-test: fetch_pi_binary failed (see stderr above)"
    return 1
  }
  if [ -z "$binary" ]; then
    _fpb_error "self-test: fetch_pi_binary returned empty path"
    return 1
  fi
  if [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
    _fpb_error "self-test: produced path is not an executable file: $binary"
    return 1
  fi
  _fpb_info "self-test: invoking $binary --version"
  if ! "$binary" --version >/dev/null 2>&1; then
    _fpb_warn "self-test: '$binary --version' did not exit 0; output below"
    "$binary" --version || true
    return 1
  fi
  _fpb_ok "self-test: PASS ($("$binary" --version 2>&1 | head -n1))"
  printf '%s\n' "$binary"
  return 0
}

# If invoked directly (not sourced), dispatch. Apply strict mode here only.
# Detection: BASH_SOURCE[0] == $0 means direct invocation.
if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  set -uo pipefail
  case "${1:-}" in
    --self-test)
      shift
      _fpb_self_test "$@"
      exit $?
      ;;
    "")
      fetch_pi_binary
      exit $?
      ;;
    *)
      fetch_pi_binary "$@"
      exit $?
      ;;
  esac
fi
