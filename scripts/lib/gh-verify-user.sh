#!/usr/bin/env bash
#
# gh-verify-user.sh — sourceable helper that verifies the gh CLI's *active*
# token resolves to an expected GitHub login, closing the silent-drift gap
# described in pi_config #217.
#
# Background:
#   `gh auth status` reads a config-file 'active' flag and can disagree with
#   the actual token after a `gh auth switch` + token refresh. The only
#   authoritative answer to "who am I to GitHub right now?" is to ask
#   GitHub: `gh api /user --jq .login`.
#
#   This helper centralizes that check so non-pi consumers (setup scripts,
#   git hooks, CI shims, ad-hoc release scripts) do not have to reinvent it
#   each time. Pi subagents follow the procedural form documented in
#   agent/skills/gh-cli-expert/SKILL.md and the structural form will land
#   later as a tool-boundary extension (#250).
#
# Usage:
#   # As a sourced library:
#   . scripts/lib/gh-verify-user.sh
#   gh_verify_user "TheSemicolon"      # → 0 on match, 1 on drift, 2 on error
#
#   # As a standalone CLI:
#   scripts/lib/gh-verify-user.sh TheSemicolon
#   scripts/lib/gh-verify-user.sh --self-test
#
# Output:
#   Status lines (OK/WARN/ERROR) go to stderr per
#   agent/rules/script-output-conventions.md. The resolved login token is
#   printed to stdout on success so callers can capture it.
#
# Exit codes:
#   0 — active gh user matches the expected login
#   1 — drift: active gh user is a different login (or expected is empty)
#   2 — environment error: gh missing, not authenticated, or API call failed
#
# Dependencies: gh (any modern version exposing `gh api /user`).

# --- Output helpers --------------------------------------------------------
__gvu_quiet=0
_gvu_ok()    { [ "$__gvu_quiet" = "1" ] || printf 'OK    %s\n' "$*" >&2; }
_gvu_warn()  { printf 'WARN  %s\n' "$*" >&2; }
_gvu_error() { printf 'ERROR %s\n' "$*" >&2; }

# --- Portable subprocess timeout -------------------------------------------
# Run "$@" with a hard wall-clock cap so a hung `gh api /user` (captive
# portal, slowloris, network stall) cannot block `git push` indefinitely
# (#259 item 1). Any timeout/kill yields a non-zero exit, which the caller
# maps to its fail-closed env-error path (return 2).
#
# Strategy, in order of preference:
#   1. GNU `timeout`            (Linux)
#   2. `gtimeout`               (macOS + coreutils) — keeps the kill within
#                               the spawned process group
#   3. pure-bash watchdog       (bash 3.2; macOS WITHOUT coreutils) — no
#                               `coproc` (4.0+), no `setsid` (absent on macOS)
#
# stdout of "$@" propagates out through command substitution in all three
# branches (the watchdog backgrounds "$@" into the same captured pipe and
# `wait`s for it). Accepted limitation on branch 3: if the wrapped command
# exits in the final instant before the watchdog's `sleep` elapses, the
# watchdog's SIGTERM could in principle race a reused PID; the preferred
# `timeout`/`gtimeout` branches avoid this, and the block decision is
# unaffected either way.
_gvu_run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    "$@" &
    local cmd_pid=$!
    ( sleep "$secs"; kill -TERM "$cmd_pid" 2>/dev/null ) &
    local watch_pid=$!
    wait "$cmd_pid" 2>/dev/null
    local rc=$?
    kill -TERM "$watch_pid" 2>/dev/null
    wait "$watch_pid" 2>/dev/null
    return "$rc"
  fi
}

# --- gh_verify_user <expected_login> ---------------------------------------
# Returns 0/1/2 per the exit-code contract above. Prints the resolved login
# to stdout on success so callers can `actual=$(gh_verify_user "$expected")`.
gh_verify_user() {
  local expected="${1:-}"
  if [ -z "$expected" ]; then
    _gvu_error "gh_verify_user: missing required <expected_login> argument"
    return 2
  fi

  if ! command -v gh >/dev/null 2>&1; then
    _gvu_error "gh_verify_user: gh CLI not on PATH"
    return 2
  fi

  local actual
  if ! actual="$(_gvu_run_with_timeout 10 gh api /user --jq .login 2>/dev/null)"; then
    _gvu_error "gh_verify_user: 'gh api /user' failed or timed out (not authenticated, network error, rate-limited, or captive portal)"
    return 2
  fi

  if [ -z "$actual" ]; then
    _gvu_error "gh_verify_user: 'gh api /user' returned empty login"
    return 2
  fi

  if [ "$actual" != "$expected" ]; then
    _gvu_warn "gh_verify_user: active gh user is '$actual', expected '$expected' — identity drift detected"
    printf '%s\n' "$actual"
    return 1
  fi

  _gvu_ok "gh_verify_user: active gh user is '$actual' (matches expected)"
  printf '%s\n' "$actual"
  return 0
}

# --- Standalone entrypoint -------------------------------------------------
# Only runs when this file is executed directly, not when sourced.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    --self-test)
      # Smoke test: verify the function is defined and gh is available.
      # Does NOT perform a live API call (no network dependency in CI).
      if ! command -v gh >/dev/null 2>&1; then
        _gvu_error "self-test: gh CLI not on PATH"
        exit 2
      fi
      if ! declare -F gh_verify_user >/dev/null; then
        _gvu_error "self-test: gh_verify_user function not defined"
        exit 2
      fi
      _gvu_ok "self-test: gh present, gh_verify_user defined"
      exit 0
      ;;
    "")
      _gvu_error "usage: $0 <expected_login> | --self-test"
      exit 2
      ;;
    *)
      gh_verify_user "$1"
      exit $?
      ;;
  esac
fi
