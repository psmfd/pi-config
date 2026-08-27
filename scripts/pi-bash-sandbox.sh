#!/usr/bin/env bash
#
# pi-bash-sandbox.sh — opt-in $HOME-scoping wrapper for pi's bash tool.
#
# #507 Phase 1 (ADR-0097). pi invokes the bash tool as `<shellPath> -c
# <command>` (packages/coding-agent/src/utils/shell.ts). Point pi's `shellPath`
# setting at this script and every bash-tool invocation runs with $HOME (and
# the XDG dirs) redirected to a per-session scratch directory, so tools that
# build credential paths from $HOME (`$HOME/.aws/credentials`,
# `$HOME/.ssh/id_*`, `$HOME/.config/gh`) resolve into an empty scratch tree
# instead of the operator's real home.
#
# THREAT MODEL — READ BEFORE RELYING ON THIS:
#   This is a HYGIENE layer, NOT a security boundary. $HOME is only an
#   environment variable: redirecting it changes what path-building *tools*
#   resolve, and does NOTHING to what exists on disk. A deliberate adversary
#   who hardcodes an absolute path — a Makefile recipe running
#   `rm -rf "/Users/you/.aws/credentials"` — is completely unaffected, because
#   the real file still sits at that real path, reachable by any process
#   running as this uid. The sound boundary is a real filesystem sandbox that
#   makes the path unreachable in the child's view. The write half of that
#   boundary is Phase 2a (ADR-0146: vendored landlock-run, Linux; this
#   script is the composition target — #1046 merges it into the composed
#   wrapper); read-scoping + macOS Seatbelt are Phase 2b (#707).
#   This wrapper reduces ACCIDENTAL credential exposure from
#   well-behaved tools defaulting to $HOME-relative paths; it is not a defense
#   against the GuardFall Makefile-exfil class this issue exists to escape.
#   It also does NOT scrub env-carried ambient credentials (SSH_AUTH_SOCK,
#   GH_TOKEN) — those still cross, by design, so the agent's legitimate git/gh
#   work keeps functioning. That is the cost of it being hygiene, not a sandbox.
#
# OPT-IN — it is not enabled by default (redirecting $HOME breaks the agent's
# gh/git/npm auth that lives under the real home). Enable per-host:
#   1. `~/.local/bin/pi-bash-sandbox` is installed by setup.sh (symlink to this
#      file), so `git pull` keeps it current.
#   2. In ~/.pi/agent/settings.json add:  "shellPath": "~/.local/bin/pi-bash-sandbox"
#
# Scratch home location (override with PI_BASH_SANDBOX_HOME):
#   ${XDG_CACHE_HOME:-$HOME/.cache}/pi_config/bash-sandbox-home
# (session-keyed with a /<session> suffix when PI_CONFINE_SESSION is set, so
# concurrent sessions never share a scratch tree). The git identity
# (user.name/user.email) is copied once from the real global gitconfig so
# commits keep authoring correctly.
#
# CONFINEMENT LAYER (Phase 2a, ADR-0146, #1046) — Linux only. When
# PI_BASH_CONFINE=enforce, the final exec is wrapped in the vendored
# landlock-run launcher: read+exec granted everywhere (--ro /), writes
# denied outside the granted set (deny-by-default, inherited across execve).
# PI_BASH_CONFINE=refuse is the strict-policy state: the wrapper exits 125
# before running bash because the extension could not verify enforcement.
# Env contract (exported by the bash-confinement policy extension; all read
# from THIS process's environment, never from the wrapped command string):
#   PI_BASH_CONFINE        enforce | refuse | anything-else (passthrough)
#   PI_SESSION_WORKTREE    the session worktree — the primary rw grant;
#                          REQUIRED under enforce (missing => refuse, exit 125)
#   PI_CONFINE_GRANTS_RW   colon-separated extra rw paths (extension-computed)
#   PI_CONFINE_SESSION     session key (scratch-home keying + per-session tmp)
#   PI_CONFINE_LAUNCHER    launcher override (default ~/.local/bin/landlock-run)
#   SKIP_BASH_CONFINEMENT  =1 skips the layer with a visible stderr notice —
#                          operator env only (ADR-0146 D6): inline assignments
#                          inside the wrapped command never reach this process
#   PI_BASH_CONFINE_PRINT  =1 prints the constructed launcher argv and exits 0
#                          (test seam; never execs)
# Extra per-host rw grants: one path per line in
# ~/.config/pi/bash-confinement-grants.conf (REAL home — read before the
# scratch redirect; deliberately outside every grant so a confined child can
# never widen its own grants). Refusals exit 125 with a 'landlock-run: '
# stderr marker (ADR-0146 D8); a bare 125 from the wrapped command carries no
# marker and passes through untouched.
#
# Exit codes: transparent — this exec's the real bash, so the wrapped command's
# exit status is returned unchanged (125 + marker = launcher/wrapper refusal).
# --help / --self-test exit 0/1 per below.
#
# Per agent/rules/script-output-conventions.md (standalone — installed outside
# the repo tree as ~/.local/bin/pi-bash-sandbox, so helpers are inlined).

set -euo pipefail

# Inline output helpers (standalone-install carve-out; used only by --help /
# --self-test, never on the transparent exec path).
ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
info() { printf 'INFO  %s\n' "$*"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }

usage() {
  cat <<'EOF'
pi-bash-sandbox.sh — opt-in $HOME-scoping wrapper for pi's bash tool (#507 Phase 1).

Normal use (invoked BY pi): pi calls `<shellPath> -c <command>`. Set
  "shellPath": "~/.local/bin/pi-bash-sandbox"
in ~/.pi/agent/settings.json to route bash-tool calls through this wrapper.

Operator flags:
  --help        Show this help.
  --self-test   Verify $HOME is redirected for a wrapped command; exit 0 pass, 1 fail.

The $HOME-scoping above is HYGIENE, not a sandbox — hardcoded absolute
paths bypass it. The composed Phase 2a confinement layer (ADR-0146) adds
the sound write boundary on Linux: with PI_BASH_CONFINE=enforce (exported
by the bash-confinement policy extension), the exec is wrapped in the
vendored landlock-run launcher — writes denied outside the granted set,
refusals exit 125 with a 'landlock-run: ' stderr marker. Reads and macOS
(Seatbelt) are Phase 2b, #707. See the header comment for the env contract.
EOF
}

# Resolve the scratch home and export the redirected environment. Reads the
# real global git identity BEFORE overriding HOME so it can seed the scratch
# gitconfig. Factored out so --self-test exercises the exact same path.
apply_sandbox_env() {
  local sandbox_home
  # Session-keyed default (ADR-0146 D3): concurrent sessions must not share
  # a scratch tree. An explicit PI_BASH_SANDBOX_HOME override is honored
  # verbatim — keying it is the operator's choice.
  sandbox_home="${PI_BASH_SANDBOX_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/pi_config/bash-sandbox-home${PI_CONFINE_SESSION:+/$PI_CONFINE_SESSION}}"

  # Read real git identity while HOME is still the real one.
  local real_name real_email
  real_name="$(git config --global user.name 2>/dev/null || true)"
  real_email="$(git config --global user.email 2>/dev/null || true)"

  mkdir -p \
    "$sandbox_home" \
    "$sandbox_home/.config" \
    "$sandbox_home/.cache" \
    "$sandbox_home/.local/share"

  # Seed a minimal gitconfig once so commits still author correctly. Only the
  # identity crosses — never credential.helper or url.insteadOf from the real
  # config (those would reintroduce token exfil).
  if [ ! -f "$sandbox_home/.gitconfig" ]; then
    {
      if [ -n "$real_name" ] || [ -n "$real_email" ]; then
        printf '[user]\n'
        [ -n "$real_name" ]  && printf '\tname = %s\n'  "$real_name"
        [ -n "$real_email" ] && printf '\temail = %s\n' "$real_email"
      fi
      printf '[init]\n\tdefaultBranch = main\n'
    } > "$sandbox_home/.gitconfig"
  fi

  export HOME="$sandbox_home"
  export XDG_CONFIG_HOME="$sandbox_home/.config"
  export XDG_CACHE_HOME="$sandbox_home/.cache"
  export XDG_DATA_HOME="$sandbox_home/.local/share"
}

resolve_bash() {
  if [ -x /bin/bash ]; then
    printf '/bin/bash'
  else
    command -v bash 2>/dev/null || { err bash "no bash found on PATH"; exit 1; }
  fi
}

# Operator flags are only ever the FIRST arg. pi always calls with `-c` first,
# so a wrapped command that merely contains --help/--self-test (as $2) never
# matches here.
case "${1:-}" in
  --help | -h)
    usage
    exit 0
    ;;
  --self-test)
    tmp_home="$(mktemp -d "${TMPDIR:-/tmp}/pi-bash-sandbox-selftest.XXXXXX")"
    got="$(PI_BASH_SANDBOX_HOME="$tmp_home" "$0" -c 'printf %s "$HOME"')"
    if [ "$got" = "$tmp_home" ]; then
      ok self-test "HOME redirected to the scratch dir for wrapped commands"
      [ -f "$tmp_home/.gitconfig" ] && ok self-test "scratch .gitconfig seeded"
      rm -rf "$tmp_home"
      info "PASS"
      exit 0
    fi
    err self-test "HOME was '$got', expected '$tmp_home'"
    rm -rf "$tmp_home"
    exit 1
    ;;
esac

# --- Confinement layer (Phase 2a, ADR-0146) --------------------------------

refuse() {
  # ADR-0146 D8: refusal = exit 125 AND the 'landlock-run: ' stderr marker.
  printf 'landlock-run: refused — %s\n' "$*" >&2
  exit 125
}

# Read the per-host extra-grants file against the REAL home, before
# apply_sandbox_env redirects it. One absolute path per line; '#' comments
# and blanks ignored. Populates EXTRA_GRANTS_FILE_PATHS (newline-separated).
EXTRA_GRANTS_FILE_PATHS=""
read_extra_grants_file() {
  local conf="${HOME}/.config/pi/bash-confinement-grants.conf" line
  [ -f "$conf" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    EXTRA_GRANTS_FILE_PATHS="${EXTRA_GRANTS_FILE_PATHS}${line}
"
  done < "$conf"
}

# Builds LAUNCH_ARGS (the launcher argv up to and including '--') in a global
# array. Grants: --ro / plus every rw path that exists; missing rw paths warn
# to stderr and are skipped (a silently absent grant is a debugging trap),
# except device nodes, which skip silently (not every host has /dev/tty).
LAUNCH_ARGS=()
build_launch_args() {
  local launcher="$1" p
  LAUNCH_ARGS=("$launcher" --ro /)

  add_rw() {
    local path="$1" quiet="${2:-}"
    [ -n "$path" ] || return 0
    if [ -e "$path" ]; then
      LAUNCH_ARGS+=(--rw "$path")
    elif [ -z "$quiet" ]; then
      printf 'landlock-run: skipping missing rw grant: %s\n' "$path" >&2
    fi
  }

  add_rw "$PI_SESSION_WORKTREE"
  # Extension-computed grants (colon-separated; split without word-splitting
  # or glob expansion side effects).
  local grants_rest="${PI_CONFINE_GRANTS_RW:-}"
  while [ -n "$grants_rest" ]; do
    p="${grants_rest%%:*}"
    if [ "$p" = "$grants_rest" ]; then grants_rest=""; else grants_rest="${grants_rest#*:}"; fi
    add_rw "$p"
  done
  # Per-host extras from the grants file (newline-separated).
  while IFS= read -r p; do add_rw "$p"; done <<EOF
$EXTRA_GRANTS_FILE_PATHS
EOF
  # The scratch home (already session-keyed) and its tmp — the per-session
  # TMPDIR replaces shared /tmp, which is deliberately NOT granted
  # (ADR-0146 D4: cross-session tampering).
  add_rw "$HOME"
  # Device nodes commonly written by ordinary scripting.
  add_rw /dev/null quiet
  add_rw /dev/zero quiet
  add_rw /dev/urandom quiet
  add_rw /dev/tty quiet

  LAUNCH_ARGS+=(--)
}

main() {
  read_extra_grants_file
  apply_sandbox_env

  local real_bash
  real_bash="$(resolve_bash)"

  # Per-session tmp inside the (granted, session-keyed) scratch home.
  mkdir -p "$HOME/tmp" && chmod 700 "$HOME/tmp" 2>/dev/null || true
  export TMPDIR="$HOME/tmp"

  # Passthrough paths: non-Linux host (macOS confinement is the Seatbelt leg,
# #707 — the policy extension owns the inert notice) or a policy state other
# than enforce/refuse.
  local confine_mode="${PI_BASH_CONFINE:-off}"
  if [ "$(uname -s)" != "Linux" ]; then
    exec "$real_bash" "$@"
  fi
  case "$confine_mode" in
    enforce|refuse) ;;
    *) exec "$real_bash" "$@" ;;
  esac

  # The operator hatch applies to both enforce and strict-refusal states.
  if [ "${SKIP_BASH_CONFINEMENT:-0}" = "1" ]; then
    printf 'landlock-run: confinement skipped via SKIP_BASH_CONFINEMENT=1 (operator env)\n' >&2
    exec "$real_bash" "$@"
  fi
  if [ "$confine_mode" = "refuse" ]; then
    refuse "policy mode=enforce could not verify Landlock enforcement"
  fi

  # Enforce mode: fail closed on every unmet precondition (ADR-0146 D3/D5).
  local launcher="${PI_CONFINE_LAUNCHER:-$HOME_REAL_LOCAL_BIN/landlock-run}"
  if [ ! -x "$launcher" ]; then
    launcher="$(command -v landlock-run 2>/dev/null || true)"
  fi
  [ -n "$launcher" ] && [ -x "$launcher" ] || refuse "launcher not found (vendored landlock-run missing; run setup.sh)"
  [ -n "${PI_SESSION_WORKTREE:-}" ] || refuse "PI_SESSION_WORKTREE unset under enforce mode"
  [ -d "$PI_SESSION_WORKTREE" ] || refuse "PI_SESSION_WORKTREE does not exist: $PI_SESSION_WORKTREE"

  build_launch_args "$launcher"

  if [ "${PI_BASH_CONFINE_PRINT:-0}" = "1" ]; then
    # Test seam: print the argv (one element per line), never exec.
    printf '%s\n' "${LAUNCH_ARGS[@]}" "$real_bash" "$@"
    exit 0
  fi

  exec "${LAUNCH_ARGS[@]}" "$real_bash" "$@"
}

# Capture the real ~/.local/bin before apply_sandbox_env redirects HOME —
# the vendored launcher symlink lives under the REAL home.
HOME_REAL_LOCAL_BIN="$HOME/.local/bin"

main "$@"
