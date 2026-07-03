#!/usr/bin/env bash
#
# install-helpers.sh — sourceable library providing the setup.sh
# dependency-installer framework per ADR-0010.
#
# Provides:
#   ih_dry_run [0|1]               Set or query the dry-run flag (0=run, 1=print-only).
#   ih_run <cmd>...                Print and execute a command. In dry-run mode, prints only.
#   ih_have_cmd <name>             0 if <name> resolves on PATH, 1 otherwise.
#   ih_ensure_nvm                  Install nvm from the agent/vendor/nvm/ pin if absent.
#   ih_ensure_node <maj>           Install Node.js <major> via nvm and switch to it.
#   ih_ensure_gh                   Install gh from agent/vendor/gh/ pin (ADR-0011).
#   ih_ensure_yq                   Install mikefarah/yq from agent/vendor/yq/ pin (ADR-0011).
#   ih_ensure_shellcheck           Install shellcheck from agent/vendor/shellcheck/ pin (ADR-0011).
#   ih_ensure_gitleaks             Install gitleaks from agent/vendor/gitleaks/ pin (ADR-0037).
#   ih_ensure_jq                   Install jq via distro (apt/dnf/brew); gated on PI_ALLOW_SUDO_*.
#   ih_ensure_yamllint             Install yamllint via distro or pipx fallback.
#   ih_ensure_markdownlint_cli2    Install via nvm-managed npm (no sudo).
#
# Usage:
#   . scripts/lib/install-helpers.sh
#   ih_dry_run 1                          # turn on dry-run
#   ih_ensure_nvm
#   ih_ensure_node 24
#
#   # Standalone smoke test:
#   scripts/lib/install-helpers.sh --self-test
#
# Output:
#   Status lines (INFO/OK/SKIP/WARN/ERROR) go to stderr per
#   agent/rules/script-output-conventions.md. Helpers do not write to stdout
#   except where documented.
#
# Exit codes (standalone):
#   0 — self-test passed
#   1 — actionable failure (download, verification, install)
#   2 — environment / precondition failure
#
# Dependencies (POSIX coreutils + standard tooling):
#   curl, sha256sum (or shasum -a 256 on macOS), bash, mktemp, tar, unzip
#   (unzip only required when extracting gh's macOS .zip assets).
#
# Sister library:
#   This file requires scripts/lib/platform-detect.sh for pd_os / pd_arch /
#   pd_pkg_manager. It is sourced lazily below if not already loaded into
#   the caller's shell.
#
# Shell-option discipline:
#   `set -uo pipefail` is applied ONLY in the direct-invocation path at the
#   bottom of this file. When sourced from setup.sh, we do not mutate the
#   caller's shell options — internal error handling is explicit
#   (`|| return N`) throughout. Same posture as scripts/lib/fetch-pi-binary.sh.
#
# Caveat — transitive shell mutation via nvm.sh:
#   ih_ensure_nvm and ih_ensure_node source `$NVM_DIR/nvm.sh` into the
#   caller's shell so subsequent calls can drive `nvm`, `node`, `npm`, and
#   `npx` as shell functions. nvm.sh is a third-party file we do not control:
#   it defines/overrides those four function names, and historically has
#   toggled `set +u` in some code paths. setup.sh's `set -euo pipefail`
#   survives in practice (verified locally), but callers sourcing this
#   library should not assume their shell options are pristine across an
#   ih_ensure_nvm or ih_ensure_node call. Subshell-sourcing would defeat the
#   point (the whole purpose is to make `nvm` callable downstream), so this
#   is documented rather than "fixed."

# --- Output helpers --------------------------------------------------------
__ih_quiet=0
_ih_info()  { [ "$__ih_quiet" = "1" ] || printf 'INFO  %s\n' "$*" >&2; }
_ih_ok()    { [ "$__ih_quiet" = "1" ] || printf 'OK    %s\n' "$*" >&2; }
_ih_skip()  { [ "$__ih_quiet" = "1" ] || printf 'SKIP  %s\n' "$*" >&2; }
_ih_warn()  { printf 'WARN  %s\n' "$*" >&2; }
_ih_error() { printf 'ERROR %s\n' "$*" >&2; }

# --- Internal: dry-run state -----------------------------------------------
# Stored in __IH_DRY_RUN (default 0). Setters/getters below.
__IH_DRY_RUN="${__IH_DRY_RUN:-0}"

# --- Lazy-source platform-detect.sh ----------------------------------------
# ih_ensure_{gh,yq,shellcheck,gitleaks,jq,yamllint} depend on pd_os / pd_arch /
# pd_pkg_manager. If the caller already sourced it (setup.sh does), this is
# a no-op. Otherwise we locate and source the sibling library by path.
if ! command -v pd_os >/dev/null 2>&1; then
  # shellcheck source=./platform-detect.sh
  # shellcheck disable=SC1091  # path resolved at runtime; sibling-file pattern
  . "$(dirname "${BASH_SOURCE[0]:-$0}")/platform-detect.sh"
fi

ih_dry_run() {
  if [ $# -eq 0 ]; then
    printf '%s\n' "$__IH_DRY_RUN"
    return 0
  fi
  case "$1" in
    0|1) __IH_DRY_RUN="$1" ;;
    *)   _ih_error "ih_dry_run: argument must be 0 or 1 (got: $1)"; return 2 ;;
  esac
}

# --- ih_run: print-then-execute (or print-only in dry-run) -----------------
# Always logs the command at INFO level. In dry-run mode does not execute.
# Honors the caller's environment; quoting is the caller's responsibility.
ih_run() {
  if [ $# -eq 0 ]; then
    _ih_error "ih_run: no command provided"
    return 2
  fi
  if [ "$__IH_DRY_RUN" = "1" ]; then
    _ih_info "[dry-run] $*"
    return 0
  fi
  _ih_info "exec: $*"
  "$@"
}

# --- ih_have_cmd: PATH presence check --------------------------------------
ih_have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# --- Internal: sha256 verify (cross-platform) ------------------------------
# Mirrors scripts/lib/fetch-pi-binary.sh § _fpb_verify_sha256.
_ih_verify_sha256() {
  local path="$1" expected="$2" actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$path" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$path" | awk '{print $1}')"
  else
    _ih_error "no sha256 implementation found (need sha256sum or shasum)"
    return 2
  fi
  if [ -z "$actual" ]; then
    _ih_error "sha256 computation produced empty result for $path"
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    _ih_error "checksum mismatch for $(basename "$path")"
    _ih_error "  expected: $expected"
    _ih_error "  actual:   $actual"
    return 1
  fi
  return 0
}

# --- Internal: resolve repo-root vendor dir --------------------------------
# Locates agent/vendor/<name>/ relative to this file. Echoes the absolute path.
_ih_vendor_dir() {
  local name="$1"
  local self_path
  self_path="${BASH_SOURCE[0]:-$0}"
  local repo_root
  repo_root="$(cd "$(dirname "$self_path")/../.." && pwd)" || return 1
  printf '%s/agent/vendor/%s\n' "$repo_root" "$name"
}

# --- ih_ensure_nvm: install nvm from the vendor pin if absent --------------
# Idempotent: SKIPs if ~/.nvm/nvm.sh exists. Otherwise downloads the pinned
# install.sh, verifies sha256, executes it via `bash`. Sources the new
# nvm.sh into the current shell so subsequent calls can drive nvm.
ih_ensure_nvm() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local nvm_sh="$nvm_dir/nvm.sh"

  if [ -s "$nvm_sh" ]; then
    _ih_skip "nvm already installed at $nvm_dir"
    # Source for the caller so ih_ensure_node can drive nvm immediately.
    # shellcheck disable=SC1090
    . "$nvm_sh" >/dev/null 2>&1 || true
    return 0
  fi

  local vendor_dir version_file checksums_file tag expected
  vendor_dir="$(_ih_vendor_dir nvm)" || { _ih_error "could not locate agent/vendor/nvm/"; return 2; }
  version_file="$vendor_dir/VERSION"
  checksums_file="$vendor_dir/CHECKSUMS"

  if [ ! -f "$version_file" ] || [ ! -f "$checksums_file" ]; then
    _ih_error "nvm pin missing: expected $version_file and $checksums_file"
    return 2
  fi

  tag="$(tr -d '[:space:]' < "$version_file")"
  expected="$(awk '$2 == "install.sh" {print $1}' "$checksums_file" | head -n1)"
  if [ -z "$tag" ] || [ -z "$expected" ]; then
    _ih_error "nvm pin malformed (tag='$tag', sha256='$expected')"
    return 2
  fi

  local url="https://raw.githubusercontent.com/nvm-sh/nvm/${tag}/install.sh"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/pi-config-nvm-install.XXXXXXXX")" || { _ih_error "mktemp failed"; return 1; }

  _ih_info "downloading $url"
  if [ "$__IH_DRY_RUN" = "1" ]; then
    _ih_info "[dry-run] curl -fsSL $url -o $tmp"
    _ih_info "[dry-run] verify sha256 against $expected"
    _ih_info "[dry-run] bash $tmp  # installs nvm $tag into $nvm_dir"
    rm -f "$tmp"
    return 0
  fi

  if ! curl -fsSL "$url" -o "$tmp"; then
    _ih_error "download failed: $url"
    rm -f "$tmp"
    return 1
  fi

  if ! _ih_verify_sha256 "$tmp" "$expected"; then
    mv -f "$tmp" "${tmp}.bad" 2>/dev/null || true
    _ih_error "nvm installer verification failed; bad bytes at ${tmp}.bad"
    return 1
  fi
  _ih_ok "verified install.sh (sha256:${expected:0:12}...)"

  _ih_info "running nvm installer (per-user, no sudo)"
  if ! bash "$tmp"; then
    _ih_error "nvm installer exited non-zero"
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"

  if [ ! -s "$nvm_sh" ]; then
    _ih_error "nvm installer completed but $nvm_sh is missing or empty"
    return 1
  fi
  # shellcheck disable=SC1090
  . "$nvm_sh" >/dev/null 2>&1 || true
  _ih_ok "nvm $tag installed at $nvm_dir"
  return 0
}

# --- ih_ensure_node <major>: install Node.js via nvm ----------------------
# Requires nvm already present (call ih_ensure_nvm first). Idempotent: if
# the current `node -v` major matches, SKIPs. Otherwise installs and uses.
# Does NOT set the user's default unless PI_CONFIG_SET_DEFAULT_NODE=1.
ih_ensure_node() {
  local want_major="${1:-}"
  if [ -z "$want_major" ]; then
    _ih_error "ih_ensure_node: required argument: <major>"
    return 2
  fi
  case "$want_major" in
    *[!0-9]*|"") _ih_error "ih_ensure_node: <major> must be numeric (got: $want_major)"; return 2 ;;
  esac

  # Source nvm if not already loaded into the caller's shell. nvm is a shell
  # function, not a binary, so `command -v nvm` is the only correct presence
  # check (which/type/etc. miss it under different shell options).
  if ! command -v nvm >/dev/null 2>&1; then
    local nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if [ -s "$nvm_sh" ]; then
      # shellcheck disable=SC1090
      . "$nvm_sh" >/dev/null 2>&1 || true
    fi
  fi
  if ! command -v nvm >/dev/null 2>&1; then
    if [ "$__IH_DRY_RUN" = "1" ]; then
      _ih_info "[dry-run] (nvm not loaded in this shell; would be sourced from \$NVM_DIR after a real ih_ensure_nvm run)"
      _ih_info "[dry-run] nvm install $want_major"
      _ih_info "[dry-run] nvm use $want_major"
      if [ "${PI_CONFIG_SET_DEFAULT_NODE:-0}" = "1" ]; then
        _ih_info "[dry-run] nvm alias default $want_major"
      fi
      return 0
    fi
    _ih_error "nvm not available in this shell; call ih_ensure_nvm first"
    return 2
  fi

  # Cheap fast-path: if a node is on PATH and its major matches, SKIP.
  if command -v node >/dev/null 2>&1; then
    local cur_major
    cur_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo unknown)"
    if [ "$cur_major" = "$want_major" ]; then
      _ih_skip "node ${cur_major}.x already active ($(node -v))"
      return 0
    fi
    _ih_info "current node is ${cur_major}.x; switching to ${want_major}.x via nvm"
  fi

  if [ "$__IH_DRY_RUN" = "1" ]; then
    _ih_info "[dry-run] nvm install $want_major"
    _ih_info "[dry-run] nvm use $want_major"
    if [ "${PI_CONFIG_SET_DEFAULT_NODE:-0}" = "1" ]; then
      _ih_info "[dry-run] nvm alias default $want_major"
    fi
    return 0
  fi

  # `nvm install <major>` is idempotent — it installs the latest LTS minor at
  # that major and is a no-op if already present.
  if ! nvm install "$want_major"; then
    _ih_error "nvm install $want_major failed"
    return 1
  fi
  if ! nvm use "$want_major" >/dev/null; then
    _ih_error "nvm use $want_major failed"
    return 1
  fi

  if [ "${PI_CONFIG_SET_DEFAULT_NODE:-0}" = "1" ]; then
    nvm alias default "$want_major" >/dev/null || \
      _ih_warn "nvm alias default $want_major failed (non-fatal)"
    _ih_ok "node ${want_major}.x set as nvm default (PI_CONFIG_SET_DEFAULT_NODE=1)"
  else
    _ih_info "not changing nvm default (set PI_CONFIG_SET_DEFAULT_NODE=1 to override)"
  fi

  _ih_ok "node $(node -v) active via nvm"
  return 0
}

# --- Internal: vendor fetch + sha256 verify + extract ----------------------
# Shared body for ih_ensure_{gh,yq,shellcheck,gitleaks}. Args:
#   $1 = tool name (used for cache dir + log messages)
#   $2 = release tag (e.g. v2.92.0)
#   $3 = upstream release-base URL (e.g. https://github.com/cli/cli/releases/download/)
#   $4 = asset filename (e.g. gh_2.92.0_linux_amd64.tar.gz)
#   $5 = expected sha256
#   $6 = cache root (defaults to ~/.cache/pi_config)
# Echoes the absolute path of the extracted directory on stdout.
# Honors $__IH_DRY_RUN: prints the would-be operations and returns 0 without
# touching the filesystem.
_ih_vendor_fetch_extract() {
  local tool="$1" tag="$2" base_url="$3" asset="$4" expected_sha="$5"
  local cache_root="${6:-$HOME/.cache/pi_config}"
  local cache_dir="$cache_root/${tool}-${tag}"
  local archive_url="${base_url%/}/${tag}/${asset}"
  local archive_path="$cache_dir/$asset"

  if [ "$__IH_DRY_RUN" = "1" ]; then
    _ih_info "[dry-run] mkdir -p $cache_dir"
    _ih_info "[dry-run] curl -fsSL -o $archive_path $archive_url"
    _ih_info "[dry-run] sha256 verify $asset against agent/vendor/${tool}/CHECKSUMS"
    case "$asset" in
      *.tar.gz|*.tgz) _ih_info "[dry-run] tar --no-same-owner --no-same-permissions -xzf $archive_path -C $cache_dir" ;;
      *.zip)          _ih_info "[dry-run] unzip -q -o $archive_path -d $cache_dir" ;;
    esac
    printf '%s\n' "$cache_dir"
    return 0
  fi

  mkdir -p "$cache_dir" || { _ih_error "mkdir -p $cache_dir failed"; return 1; }

  if [ ! -f "$archive_path" ]; then
    _ih_info "downloading $asset"
    if ! curl -fsSL -o "${archive_path}.part" "$archive_url"; then
      rm -f "${archive_path}.part"
      _ih_error "curl failed: $archive_url"
      return 1
    fi
    mv "${archive_path}.part" "$archive_path"
  fi

  if ! _ih_verify_sha256 "$archive_path" "$expected_sha"; then
    mv "$archive_path" "${archive_path}.bad" 2>/dev/null || true
    _ih_error "sha256 verify failed for $asset (moved to ${archive_path}.bad)"
    return 1
  fi

  case "$asset" in
    *.tar.gz|*.tgz)
      tar --no-same-owner --no-same-permissions -xzf "$archive_path" -C "$cache_dir" || {
        _ih_error "tar extract failed: $asset"; return 1; }
      ;;
    *.zip)
      if ! command -v unzip >/dev/null 2>&1; then
        _ih_error "unzip not found; required for $asset on this host"
        return 2
      fi
      unzip -q -o "$archive_path" -d "$cache_dir" || {
        _ih_error "unzip failed: $asset"; return 1; }
      ;;
    *)
      _ih_error "unsupported archive format: $asset"
      return 1
      ;;
  esac

  printf '%s\n' "$cache_dir"
  return 0
}

# --- Internal: read CHECKSUMS line for an asset ----------------------------
# Echoes the 64-char hex sha256 for $asset from agent/vendor/$tool/CHECKSUMS,
# or empty + nonzero if not found.
_ih_vendor_sha_for_asset() {
  local tool="$1" asset="$2"
  local vendor_dir checksums sha
  vendor_dir="$(_ih_vendor_dir "$tool")" || return 1
  checksums="$vendor_dir/CHECKSUMS"
  [ -f "$checksums" ] || { _ih_error "$checksums missing"; return 1; }
  sha="$(awk -v a="$asset" '$2 == a {print $1}' "$checksums")"
  [ -n "$sha" ] || { _ih_error "$checksums: no entry for $asset"; return 1; }
  printf '%s\n' "$sha"
}

# --- Internal: symlink ~/.local/bin/<tool> with detect-and-backup ----------
# Mirrors the pattern setup.sh §2 uses for the vendored-pi symlink. If the
# target exists and is not already a symlink to $src, back it up.
_ih_link_local_bin() {
  local src="$1" tool="$2"
  local dst="$HOME/.local/bin/$tool"
  if [ "$__IH_DRY_RUN" = "1" ]; then
    _ih_info "[dry-run] mkdir -p $HOME/.local/bin"
    _ih_info "[dry-run] ln -s $src $dst (back up any existing entry first)"
    return 0
  fi
  mkdir -p "$HOME/.local/bin" || { _ih_error "mkdir -p ~/.local/bin failed"; return 1; }
  if [ -L "$dst" ]; then
    local current
    current="$(readlink "$dst" 2>/dev/null || true)"
    if [ "$current" = "$src" ]; then
      return 0
    fi
  fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    local backup
    backup="${dst}.preinstall.$(date +%s)"
    mv "$dst" "$backup" || { _ih_error "backup mv failed: $dst -> $backup"; return 1; }
    _ih_warn "existing $dst backed up to $backup"
  fi
  ln -s "$src" "$dst" || { _ih_error "ln -s $src $dst failed"; return 1; }
  return 0
}

# --- ih_ensure_gh: install gh from the vendor pin if absent ----------------
ih_ensure_gh() {
  local vendor_dir tag ver_bare os arch asset sha cache_dir bin_path
  vendor_dir="$(_ih_vendor_dir gh)" || return 1
  tag="$(tr -d '[:space:]' < "$vendor_dir/VERSION")" || { _ih_error "cannot read $vendor_dir/VERSION"; return 1; }
  ver_bare="${tag#v}"
  os="$(pd_os)" || return $?
  arch="$(pd_arch)" || return $?

  # Idempotent: if gh already on PATH at the pinned tag, skip.
  if command -v gh >/dev/null 2>&1; then
    local current
    current="$(gh --version 2>/dev/null | head -n1 | awk '{print $3}')"
    if [ "$current" = "$ver_bare" ]; then
      _ih_skip "gh $current already installed at pinned tag"
      return 0
    fi
    _ih_info "gh $current present; vendor pin is $tag (will install pinned version alongside)"
  fi

  case "${os}-${arch}" in
    linux-amd64)   asset="gh_${ver_bare}_linux_amd64.tar.gz" ;;
    linux-arm64)   asset="gh_${ver_bare}_linux_arm64.tar.gz" ;;
    darwin-amd64)  asset="gh_${ver_bare}_macOS_amd64.zip" ;;
    darwin-arm64)  asset="gh_${ver_bare}_macOS_arm64.zip" ;;
    *)             _ih_error "unsupported host triple for gh: ${os}-${arch}"; return 2 ;;
  esac

  sha="$(_ih_vendor_sha_for_asset gh "$asset")" || return 1
  cache_dir="$(_ih_vendor_fetch_extract gh "$tag" 'https://github.com/cli/cli/releases/download' "$asset" "$sha")" || return 1

  if [ "$__IH_DRY_RUN" = "1" ]; then
    _ih_info "[dry-run] symlink ~/.local/bin/gh -> $cache_dir/gh_${ver_bare}_<triple>/bin/gh"
    return 0
  fi

  # Extracted layout: gh_<ver>_<os>_<arch>/bin/gh
  bin_path="$(find "$cache_dir" -maxdepth 3 -type f -name gh -path '*/bin/gh' 2>/dev/null | head -n1)"
  if [ -z "$bin_path" ] || [ ! -x "$bin_path" ]; then
    _ih_error "gh binary not found under $cache_dir after extract"
    return 1
  fi
  _ih_link_local_bin "$bin_path" gh || return 1
  _ih_ok "gh installed: $("$bin_path" --version 2>&1 | head -n1)"
  return 0
}

# --- ih_ensure_yq: install mikefarah/yq from the vendor pin if absent ------
# Validates that an existing on-PATH yq is mikefarah-flavored before SKIP-ing
# (kislyuk yq carries the same binary name but different syntax).
ih_ensure_yq() {
  local vendor_dir tag os arch asset sha cache_dir bin_name bin_path
  vendor_dir="$(_ih_vendor_dir yq)" || return 1
  tag="$(tr -d '[:space:]' < "$vendor_dir/VERSION")" || { _ih_error "cannot read $vendor_dir/VERSION"; return 1; }
  os="$(pd_os)" || return $?
  arch="$(pd_arch)" || return $?

  # Idempotent: mikefarah yq at pinned tag -> SKIP.
  if command -v yq >/dev/null 2>&1; then
    local ver_line
    ver_line="$(yq --version 2>&1 | head -n1)"
    # mikefarah format: "yq (https://github.com/mikefarah/yq/) version v4.x.y"
    if printf '%s' "$ver_line" | grep -q 'mikefarah'; then
      # Anchor to end-of-line so a future shorter tag (e.g. 'v4.5') can't
      # falsely match a longer running version (e.g. 'v4.53.x').
      if printf '%s' "$ver_line" | grep -qE "version ${tag}\$"; then
        _ih_skip "yq (mikefarah) $tag already installed"
        return 0
      fi
      _ih_info "yq (mikefarah) present but not at $tag; installing pinned version"
    else
      _ih_warn "on-PATH yq is not mikefarah-flavored (likely kislyuk); installing pinned mikefarah version alongside (see ADR-0011)"
    fi
  fi

  case "${os}-${arch}" in
    linux-amd64)   asset='yq_linux_amd64.tar.gz';  bin_name='yq_linux_amd64' ;;
    linux-arm64)   asset='yq_linux_arm64.tar.gz';  bin_name='yq_linux_arm64' ;;
    darwin-amd64)  asset='yq_darwin_amd64.tar.gz'; bin_name='yq_darwin_amd64' ;;
    darwin-arm64)  asset='yq_darwin_arm64.tar.gz'; bin_name='yq_darwin_arm64' ;;
    *)             _ih_error "unsupported host triple for yq: ${os}-${arch}"; return 2 ;;
  esac

  sha="$(_ih_vendor_sha_for_asset yq "$asset")" || return 1
  cache_dir="$(_ih_vendor_fetch_extract yq "$tag" 'https://github.com/mikefarah/yq/releases/download' "$asset" "$sha")" || return 1

  if [ "$__IH_DRY_RUN" = "1" ]; then
    _ih_info "[dry-run] symlink ~/.local/bin/yq -> $cache_dir/$bin_name"
    return 0
  fi

  bin_path="$cache_dir/$bin_name"
  [ -x "$bin_path" ] || { _ih_error "yq binary $bin_name not found under $cache_dir after extract"; return 1; }
  _ih_link_local_bin "$bin_path" yq || return 1
  _ih_ok "yq (mikefarah) installed: $("$bin_path" --version 2>&1 | head -n1)"
  return 0
}

# --- ih_ensure_shellcheck: install shellcheck from the vendor pin ----------
ih_ensure_shellcheck() {
  local vendor_dir tag os arch asset sha cache_dir bin_path
  vendor_dir="$(_ih_vendor_dir shellcheck)" || return 1
  tag="$(tr -d '[:space:]' < "$vendor_dir/VERSION")" || { _ih_error "cannot read $vendor_dir/VERSION"; return 1; }
  os="$(pd_os)" || return $?
  arch="$(pd_arch)" || return $?

  # Idempotent: shellcheck at the pinned tag -> SKIP (exact-equality only;
  # we do not auto-accept a newer running shellcheck, because rule numbers
  # occasionally shift between releases and we want validate.sh runs to be
  # reproducible against the pinned version).
  if command -v shellcheck >/dev/null 2>&1; then
    local current
    current="$(shellcheck --version 2>/dev/null | awk '/^version:/ {print "v"$2}')"
    if [ -n "$current" ] && [ "$current" = "$tag" ]; then
      _ih_skip "shellcheck $current already installed at pinned tag"
      return 0
    fi
  fi

  case "${os}-${arch}" in
    linux-amd64)   asset="shellcheck-${tag}.linux.x86_64.tar.gz" ;;
    linux-arm64)   asset="shellcheck-${tag}.linux.aarch64.tar.gz" ;;
    darwin-amd64)  asset="shellcheck-${tag}.darwin.x86_64.tar.gz" ;;
    darwin-arm64)  asset="shellcheck-${tag}.darwin.aarch64.tar.gz" ;;
    *)             _ih_error "unsupported host triple for shellcheck: ${os}-${arch}"; return 2 ;;
  esac

  sha="$(_ih_vendor_sha_for_asset shellcheck "$asset")" || return 1
  cache_dir="$(_ih_vendor_fetch_extract shellcheck "$tag" 'https://github.com/koalaman/shellcheck/releases/download' "$asset" "$sha")" || return 1

  if [ "$__IH_DRY_RUN" = "1" ]; then
    _ih_info "[dry-run] symlink ~/.local/bin/shellcheck -> $cache_dir/shellcheck-${tag}/shellcheck"
    return 0
  fi

  bin_path="$cache_dir/shellcheck-${tag}/shellcheck"
  [ -x "$bin_path" ] || { _ih_error "shellcheck binary not found at $bin_path after extract"; return 1; }
  _ih_link_local_bin "$bin_path" shellcheck || return 1
  _ih_ok "shellcheck installed: $("$bin_path" --version | awk '/^version:/ {print $2}')"
  return 0
}

# --- ih_ensure_gitleaks: install gitleaks from the vendor pin --------------
ih_ensure_gitleaks() {
  local vendor_dir tag ver_bare os arch asset sha cache_dir bin_path
  vendor_dir="$(_ih_vendor_dir gitleaks)" || return 1
  tag="$(tr -d '[:space:]' < "$vendor_dir/VERSION")" || { _ih_error "cannot read $vendor_dir/VERSION"; return 1; }
  ver_bare="${tag#v}"
  os="$(pd_os)" || return $?
  arch="$(pd_arch)" || return $?

  if command -v gitleaks >/dev/null 2>&1; then
    local current
    current="$(gitleaks version 2>/dev/null | head -n1 | awk '{print $NF}')"
    current="${current#v}"
    if [ -n "$current" ] && [ "$current" = "$ver_bare" ]; then
      _ih_skip "gitleaks v$current already installed at pinned tag"
      return 0
    fi
    _ih_info "gitleaks ${current:-unknown} present; vendor pin is $tag (will install pinned version alongside)"
  fi

  case "${os}-${arch}" in
    linux-amd64)   asset="gitleaks_${ver_bare}_linux_x64.tar.gz" ;;
    linux-arm64)   asset="gitleaks_${ver_bare}_linux_arm64.tar.gz" ;;
    darwin-amd64)  asset="gitleaks_${ver_bare}_darwin_x64.tar.gz" ;;
    darwin-arm64)  asset="gitleaks_${ver_bare}_darwin_arm64.tar.gz" ;;
    *)             _ih_error "unsupported host triple for gitleaks: ${os}-${arch}"; return 2 ;;
  esac

  sha="$(_ih_vendor_sha_for_asset gitleaks "$asset")" || return 1
  cache_dir="$(_ih_vendor_fetch_extract gitleaks "$tag" 'https://github.com/gitleaks/gitleaks/releases/download' "$asset" "$sha")" || return 1

  if [ "$__IH_DRY_RUN" = "1" ]; then
    _ih_info "[dry-run] symlink ~/.local/bin/gitleaks -> $cache_dir/gitleaks"
    return 0
  fi

  bin_path="$(find "$cache_dir" -maxdepth 2 -type f -name gitleaks 2>/dev/null | head -n1)"
  if [ -z "$bin_path" ] || [ ! -x "$bin_path" ]; then
    _ih_error "gitleaks binary not found under $cache_dir after extract"
    return 1
  fi
  _ih_link_local_bin "$bin_path" gitleaks || return 1
  _ih_ok "gitleaks installed: $("$bin_path" version 2>&1 | head -n1)"
  return 0
}

# --- Internal: distro package install via apt/dnf/brew ---------------------
# Args: tool name, apt-pkg, dnf-pkg, brew-pkg (use '-' to disable a channel).
# Honors PI_ALLOW_SUDO_APT / PI_ALLOW_SUDO_DNF (off by default).
_ih_distro_install() {
  local tool="$1" apt_pkg="$2" dnf_pkg="$3" brew_pkg="$4"
  local pm
  pm="$(pd_pkg_manager)" || return $?
  case "$pm" in
    apt)
      [ "$apt_pkg" = "-" ] && { _ih_error "$tool: no apt package configured"; return 2; }
      if [ "${PI_ALLOW_SUDO_APT:-0}" != "1" ] && [ "$__IH_DRY_RUN" != "1" ]; then
        _ih_error "$tool: 'sudo apt install $apt_pkg' requires PI_ALLOW_SUDO_APT=1 (see ADR-0011 § sudo gating)"
        return 2
      fi
      ih_run sudo apt-get update -qq || { _ih_error "$tool: 'sudo apt-get update' failed; refusing to proceed against stale package indexes"; return 1; }
      ih_run sudo apt-get install -y "$apt_pkg"
      ;;
    dnf)
      [ "$dnf_pkg" = "-" ] && { _ih_error "$tool: no dnf package configured"; return 2; }
      if [ "${PI_ALLOW_SUDO_DNF:-0}" != "1" ] && [ "$__IH_DRY_RUN" != "1" ]; then
        _ih_error "$tool: 'sudo dnf install $dnf_pkg' requires PI_ALLOW_SUDO_DNF=1 (see ADR-0011 § sudo gating)"
        return 2
      fi
      ih_run sudo dnf install -y "$dnf_pkg"
      ;;
    brew)
      [ "$brew_pkg" = "-" ] && { _ih_error "$tool: no brew package configured"; return 2; }
      ih_run brew install "$brew_pkg"
      ;;
    *)
      _ih_error "$tool: no supported package manager (pd_pkg_manager=$pm)"
      return 2
      ;;
  esac
}

# --- ih_ensure_jq: install jq via the distro package manager ---------------
ih_ensure_jq() {
  if command -v jq >/dev/null 2>&1; then
    _ih_skip "jq already installed ($(jq --version))"
    return 0
  fi
  _ih_distro_install jq jq jq jq
}

# --- ih_ensure_yamllint: install yamllint via distro or pipx fallback ------
ih_ensure_yamllint() {
  if command -v yamllint >/dev/null 2>&1; then
    _ih_skip "yamllint already installed ($(yamllint --version 2>&1))"
    return 0
  fi
  # Try distro first. We deliberately do NOT redirect stderr here — the gate
  # refusal message ("requires PI_ALLOW_SUDO_APT=1") is the most actionable
  # hint a sudo-gate-closed user can get. Capture rc and fall through to pipx
  # only if distro returned nonzero.
  if _ih_distro_install yamllint yamllint yamllint yamllint; then
    return 0
  fi
  if command -v pipx >/dev/null 2>&1; then
    _ih_info "falling back to pipx install (per-user, no sudo)"
    _ih_info "  trust channel: PyPI registry (unpinned). yamllint is a YAML linter (low blast radius); flag for review if hardening required."
    ih_run pipx install yamllint
    return $?
  fi
  _ih_error "yamllint: distro install requires PI_ALLOW_SUDO_APT=1 or PI_ALLOW_SUDO_DNF=1; pipx fallback unavailable. brew users: install brew. Otherwise: install pipx first."
  return 2
}

# --- ih_ensure_markdownlint_cli2: install via nvm-managed npm --------------
# No sudo path: the nvm-managed npm uses a user-owned prefix.
ih_ensure_markdownlint_cli2() {
  if command -v markdownlint-cli2 >/dev/null 2>&1; then
    _ih_skip "markdownlint-cli2 already installed ($(markdownlint-cli2 --version 2>&1 | head -n1))"
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    _ih_error "markdownlint-cli2: npm not on PATH (run ih_ensure_node first, or set PI_CONFIG_SKIP_TOOLCHAIN=1)"
    return 2
  fi
  ih_run npm install -g markdownlint-cli2
}

# --- Standalone --self-test mode -------------------------------------------
# Exercises every helper in dry-run mode (no host mutation). The real install
# paths are exercised by setup.sh; this is structural / wiring validation.
_ih_self_test() {
  _ih_info "self-test: setting dry-run mode"
  ih_dry_run 1 || return $?
  if [ "$(ih_dry_run)" != "1" ]; then
    _ih_error "ih_dry_run set/get round-trip failed"
    return 1
  fi
  _ih_ok "ih_dry_run round-trip OK"

  _ih_info "self-test: ih_have_cmd"
  if ! ih_have_cmd sh; then
    _ih_error "ih_have_cmd sh returned false (impossible)"
    return 1
  fi
  if ih_have_cmd __this_command_does_not_exist__; then
    _ih_error "ih_have_cmd returned true for a nonexistent command"
    return 1
  fi
  _ih_ok "ih_have_cmd OK"

  _ih_info "self-test: ih_run (dry-run, must not execute)"
  if ! ih_run echo 'this-would-print-but-must-not-execute'; then
    _ih_error "ih_run failed in dry-run mode"
    return 1
  fi
  _ih_ok "ih_run dry-run OK"

  _ih_info "self-test: ih_ensure_nvm (dry-run)"
  if ! ih_ensure_nvm; then
    _ih_error "ih_ensure_nvm failed in dry-run mode"
    return 1
  fi

  _ih_info "self-test: ih_ensure_node 24 (dry-run)"
  # ih_ensure_node requires nvm sourced; in dry-run we may not have it. Skip
  # if nvm function isn't available (dry-run didn't actually install).
  if command -v nvm >/dev/null 2>&1; then
    if ! ih_ensure_node 24; then
      _ih_error "ih_ensure_node 24 failed in dry-run mode"
      return 1
    fi
  else
    _ih_skip "ih_ensure_node 24 (nvm not loaded; dry-run did not install it)"
  fi

  _ih_info "self-test: _ih_vendor_dir lookups"
  for v in pi nvm gh yq shellcheck gitleaks; do
    local vdir
    vdir="$(_ih_vendor_dir "$v")" || { _ih_error "_ih_vendor_dir $v failed"; return 1; }
    [ -d "$vdir" ] || { _ih_error "_ih_vendor_dir $v: $vdir does not exist"; return 1; }
  done
  _ih_ok "_ih_vendor_dir resolves all six vendor pins"

  _ih_info "self-test: _ih_vendor_sha_for_asset (lookup only, no fetch)"
  local sha
  sha="$(_ih_vendor_sha_for_asset gh "gh_$(tr -d '[:space:]' < "$(_ih_vendor_dir gh)/VERSION" | sed 's/^v//')_linux_amd64.tar.gz")" || {
    _ih_error "_ih_vendor_sha_for_asset gh lookup failed"; return 1; }
  [ "${#sha}" = "64" ] || { _ih_error "_ih_vendor_sha_for_asset returned non-sha256 ($sha)"; return 1; }
  _ih_ok "_ih_vendor_sha_for_asset returns 64-char hex"

  _ih_info "self-test: ih_ensure_gh (dry-run)"
  if ! ih_ensure_gh; then
    _ih_error "ih_ensure_gh failed in dry-run mode"
    return 1
  fi

  _ih_info "self-test: ih_ensure_yq (dry-run)"
  if ! ih_ensure_yq; then
    _ih_error "ih_ensure_yq failed in dry-run mode"
    return 1
  fi

  _ih_info "self-test: ih_ensure_shellcheck (dry-run)"
  if ! ih_ensure_shellcheck; then
    _ih_error "ih_ensure_shellcheck failed in dry-run mode"
    return 1
  fi

  _ih_info "self-test: ih_ensure_gitleaks (dry-run)"
  if ! ih_ensure_gitleaks; then
    _ih_error "ih_ensure_gitleaks failed in dry-run mode"
    return 1
  fi

  _ih_ok "self-test: PASS"
  return 0
}

# If invoked directly (not sourced), dispatch.
if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  set -uo pipefail
  case "${1:-}" in
    --self-test)         shift; _ih_self_test "$@"; exit $? ;;
    "")                  _ih_self_test; exit $? ;;
    *)
      _ih_error "unknown option: $1"
      _ih_error "usage: $0 --self-test"
      exit 2
      ;;
  esac
fi
