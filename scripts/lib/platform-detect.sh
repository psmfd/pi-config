#!/usr/bin/env bash
#
# platform-detect.sh — sourceable library providing host-OS / distro /
# package-manager detection helpers.
#
# Part of the setup.sh dependency-installer framework per ADR-0010.
#
# Usage:
#   # As a sourced library (the production path):
#   . scripts/lib/platform-detect.sh
#   pd_os                         # → linux | darwin | unsupported
#   pd_distro                     # → ubuntu | debian | fedora | rhel | macos | unknown
#   pd_pkg_manager                # → apt | dnf | brew | none
#   pd_have apt                   # 0 if available, 1 if not
#
#   # As a standalone smoke test:
#   scripts/lib/platform-detect.sh --self-test
#
# Output:
#   Helpers print a single token on stdout. Status lines (INFO/OK/WARN/ERROR)
#   go to stderr per agent/rules/script-output-conventions.md.
#
# Exit codes (standalone mode):
#   0 — all detections completed; tokens printed
#   2 — unsupported host (refused early; setup.sh will surface to the operator)
#
# Dependencies: POSIX coreutils + uname. /etc/os-release is read when present
# (Linux); macOS detection is by `uname -s` alone.

# --- Output helpers --------------------------------------------------------
__pd_quiet=0
_pd_info()  { [ "$__pd_quiet" = "1" ] || printf 'INFO  %s\n' "$*" >&2; }
_pd_ok()    { [ "$__pd_quiet" = "1" ] || printf 'OK    %s\n' "$*" >&2; }
_pd_warn()  { printf 'WARN  %s\n' "$*" >&2; }
_pd_error() { printf 'ERROR %s\n' "$*" >&2; }

# --- pd_os: linux | darwin | unsupported -----------------------------------
pd_os() {
  local uname_s
  uname_s="$(uname -s 2>/dev/null || true)"
  case "$uname_s" in
    Linux)               printf 'linux\n' ;;
    Darwin)              printf 'darwin\n' ;;
    MINGW*|MSYS*|CYGWIN*)
      _pd_error "Windows host detected; setup.sh dep-install is not supported on Windows (see #99)."
      printf 'unsupported\n'
      return 2
      ;;
    *)
      _pd_error "unsupported OS from 'uname -s': $uname_s"
      printf 'unsupported\n'
      return 2
      ;;
  esac
}

# --- pd_arch: amd64 | arm64 | unsupported ----------------------------------
# Normalizes uname -m output to the Go/Docker triple suffix that most upstream
# release-asset filenames use. Used by ih_ensure_{gh,yq,shellcheck} et al.
# 'amd64' rather than 'x64' here because that is what gh/yq/shellcheck assets
# are named (the pi vendor uses 'x64' because earendil-works/pi assets are);
# fetch-pi-binary.sh maps internally.
pd_arch() {
  local uname_m
  uname_m="$(uname -m 2>/dev/null || true)"
  case "$uname_m" in
    x86_64|amd64)        printf 'amd64\n' ;;
    aarch64|arm64)       printf 'arm64\n' ;;
    *)
      _pd_error "unsupported architecture from 'uname -m': $uname_m"
      printf 'unsupported\n'
      return 2
      ;;
  esac
}

# --- pd_distro: ubuntu | debian | fedora | rhel | macos | unknown ----------
# Reads /etc/os-release on Linux (the freedesktop standard, present on every
# mainstream distro since systemd adoption). Returns 'macos' on Darwin.
pd_distro() {
  local os
  os="$(pd_os)" || return $?
  case "$os" in
    darwin)              printf 'macos\n'; return 0 ;;
    linux)               ;;
    *)                   printf 'unknown\n'; return 0 ;;
  esac

  if [ ! -r /etc/os-release ]; then
    _pd_warn "/etc/os-release not readable; cannot identify Linux distro"
    printf 'unknown\n'
    return 0
  fi

  # ID comes from /etc/os-release; lowercase, single token. ID_LIKE is the
  # space-separated fallback chain (e.g. RHEL clones have ID_LIKE='rhel fedora').
  # We source in a subshell to avoid polluting the caller's environment.
  local id id_like
  # shellcheck disable=SC1091
  id="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}")"
  # shellcheck disable=SC1091
  id_like="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID_LIKE:-}")"

  case "$id" in
    ubuntu)              printf 'ubuntu\n' ;;
    debian)              printf 'debian\n' ;;
    fedora)              printf 'fedora\n' ;;
    rhel|centos|rocky|almalinux|ol)
                         printf 'rhel\n' ;;
    *)
      # Fall back to ID_LIKE for derivatives we don't enumerate explicitly.
      case " $id_like " in
        *" debian "*|*" ubuntu "*)
                         printf 'debian\n' ;;
        *" rhel "*|*" fedora "*)
                         printf 'rhel\n' ;;
        *)
          _pd_warn "unrecognized Linux distro (ID=$id, ID_LIKE=$id_like); treating as 'unknown'"
          printf 'unknown\n'
          ;;
      esac
      ;;
  esac
}

# --- pd_pkg_manager: apt | dnf | brew | none -------------------------------
# Returns the first package manager present on PATH that pi_config knows how
# to drive. Preference order matters: apt before dnf on hybrid systems, brew
# always wins on macOS.
pd_pkg_manager() {
  local os
  os="$(pd_os)" || return $?

  if [ "$os" = "darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      printf 'brew\n'
    else
      _pd_warn "macOS host without Homebrew on PATH; dependency installs will fail."
      _pd_warn "Install Homebrew first: https://brew.sh"
      printf 'none\n'
    fi
    return 0
  fi

  # Linux: prefer apt where present (the common debian/ubuntu path).
  if command -v apt-get >/dev/null 2>&1; then
    printf 'apt\n'
    return 0
  fi
  if command -v dnf >/dev/null 2>&1; then
    printf 'dnf\n'
    return 0
  fi
  # yum without dnf — RHEL 7 era. Treat as dnf for the helpers' purposes
  # since the install verb is identical; #110 can split if it ever matters.
  if command -v yum >/dev/null 2>&1; then
    printf 'dnf\n'
    return 0
  fi

  _pd_warn "no supported package manager on PATH (apt/dnf/brew)"
  printf 'none\n'
}

# --- pd_have <cmd>: presence check -----------------------------------------
# Returns 0 if <cmd> resolves on PATH, 1 otherwise. Silent.
pd_have() {
  command -v "$1" >/dev/null 2>&1
}

# --- Standalone --self-test mode -------------------------------------------
_pd_self_test() {
  local os distro pm arch
  _pd_info "self-test: invoking detection helpers"
  os="$(pd_os)" || return $?
  distro="$(pd_distro)" || return $?
  pm="$(pd_pkg_manager)" || return $?
  arch="$(pd_arch)" || return $?
  _pd_ok "pd_os         = $os"
  _pd_ok "pd_distro     = $distro"
  _pd_ok "pd_pkg_manager= $pm"
  _pd_ok "pd_arch       = $arch"
  if pd_have uname; then
    _pd_ok "pd_have uname = present"
  else
    _pd_error "pd_have uname returned false (impossible on a sane system)"
    return 1
  fi
  if pd_have __this_command_does_not_exist__; then
    _pd_error "pd_have returned true for a nonexistent command"
    return 1
  else
    _pd_ok "pd_have <nonexistent> = absent (as expected)"
  fi
  _pd_ok "self-test: PASS"
  return 0
}

# If invoked directly (not sourced), dispatch.
if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  set -uo pipefail
  case "${1:-}" in
    --self-test)         shift; _pd_self_test "$@"; exit $? ;;
    --os)                pd_os; exit $? ;;
    --distro)            pd_distro; exit $? ;;
    --pkg-manager)       pd_pkg_manager; exit $? ;;
    --have)
      [ $# -ge 2 ] || { _pd_error "--have requires a command name"; exit 2; }
      pd_have "$2" && exit 0 || exit 1
      ;;
    "")
      _pd_self_test
      exit $?
      ;;
    *)
      _pd_error "unknown option: $1"
      exit 2
      ;;
  esac
fi
