#!/usr/bin/env bash
#
# gh-identity-guard.sh — git pre-push hook
#
# Companion to the pi-extension counterpart at
# agent/extensions/gh-identity-guard/. The extension intercepts mutating
# `gh`/`git push` invocations from inside pi sessions; this hook closes the
# raw-shell-outside-pi gap acknowledged in ADR-0022 § Threat Model by
# intercepting `git push` from any shell (pi, plain terminal, IDE).
#
# Scope:
#   - GitHub remotes only. Pushes to dev.azure.com, *.visualstudio.com,
#     gitlab.com, self-hosted Gitea, etc., pass through silently — the
#     active GitHub identity is irrelevant to those operations.
#   - Identity sources mirror the extension exactly:
#       1. <repo>/.pi/expected-identity  (git-tracked per-repo file; primary)
#       2. ~/.pi/agent/settings.json     (user-layer fallback at
#                                         .extensionSettings.ghIdentityGuard.expectedIdentity)
#     Project-layer <repo>/.pi/settings.json is NEVER consulted (ADR-0019
#     untrusted-input precedent — the same rationale as the extension).
#   - Probe via the shared `scripts/lib/gh-verify-user.sh` helper
#     (`gh api /user --jq .login`); no cache (#217 defect class).
#
# Install (per repo):
#   ln -s "$(git rev-parse --show-toplevel)/hooks/gh-identity-guard.sh" \
#         "$(git rev-parse --show-toplevel)/.git/hooks/pre-push"
# Or via pi_config setup:
#   INSTALL_GIT_HOOKS=1 ./setup.sh
#
# Override mechanisms (lowest blast radius first):
#   GH_IDENTITY_OVERRIDE=<login> git push    Change expected identity for
#                                            this push only (validated
#                                            against GitHub-username regex).
#   SKIP_GH_IDENTITY_GUARD=1 git push        Bypass this guard only.
#   git push --no-verify                     Native: bypasses ALL pre-push
#                                            hooks (sledgehammer).
#
# Interactive bootstrap (ADR-0025):
#   When NEITHER identity source is configured and a controlling terminal is
#   attached, the hook offers to create <repo>/.pi/expected-identity in place
#   (input read from /dev/tty, never stdin). A suggested login is shown only
#   when the active gh login equals the remote owner AND the remote is not a
#   personal fork; it is reference-only (the operator re-types the login,
#   never a one-keystroke accept). The file is written but the push STILL
#   fails closed (exit 1) so the operator commits the trust anchor and
#   re-runs. With no TTY (CI, IDE git clients, pipes) the original
#   fail-closed error is unchanged — no prompt, no hang.
#
# Exit codes:
#   0 — pass (non-GitHub remote, identity matches, or bypass active)
#   1 — fail (identity drift, missing expected identity, malformed config,
#       or bootstrap wrote the file — commit it and re-run)
#   2 — environment failure (gh missing, probe failed)
#
# Targets bash 3.2+ for macOS compatibility.

set -uo pipefail

# --- Output helpers (script-output-conventions.md) -------------------------
# WARN/ERROR go to stderr (the diagnostic stream); OK and the PASS/FAIL
# summary go to stdout. Routing warn() to stdout (the prior behavior) caused
# warnings emitted inside command-substitution-captured functions — e.g.
# `vals="$(read_user_layer)"` — to be swallowed into the captured value
# instead of reaching the operator (#267).
ok()    { printf 'OK    [%s] %s\n' "$1" "$2"; }
warn()  { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; }
err()   { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }

# Strip ANSI/CSI escapes + other control bytes from untrusted strings before
# echoing them to the operator's terminal. Defense in depth against
# operator-typed or env-injected sequences that could clear the screen,
# reposition the cursor, or forge a believable success line in the pre-push
# output. Source: security-review 2026-05-26 LOW (ANSI in override echo).
sanitize() { printf '%s' "$1" | tr -d '\000-\037\177'; }

# Resolve a possibly-symlinked path to its real on-disk directory. Required
# because `setup.sh` installs this hook as a symlink at
# `<consumer-repo>/.git/hooks/pre-push` → `<pi_config>/hooks/gh-identity-guard.sh`,
# and `BASH_SOURCE[0]` reports the invocation path (the symlink), not the
# resolved target. Without this resolution, the helper-sourcing path below
# computes `<consumer-repo>/.git/scripts/lib/gh-verify-user.sh` and every
# push fails closed at exit 2. Source: code-review + security-review
# 2026-05-26 CRITICAL. Bash 3.2 compatible (no `readlink -f`).
resolve_symlink() {
  local target="$1" link parent
  # Bounded loop to defeat symlink cycles.
  local i=0
  while [ -L "$target" ] && [ "$i" -lt 16 ]; do
    link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;
      *)  # Resolve the parent dir defensively; if the parent has been
          # removed mid-resolution (stale link / TOCTOU), bail out with
          # the unresolved path — downstream `[ -f "$HELPER" ]` will
          # convert this to a clean fail-closed exit 2.
          if ! parent="$(cd "$(dirname "$target")" 2>/dev/null && pwd)"; then
            printf '%s' "$target"
            return
          fi
          target="${parent}/${link}"
          ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$target"
}

# --- pre-push contract -----------------------------------------------------
# argv: $1 = remote name (e.g. "origin"), $2 = remote URL.
# stdin: zero or more lines of `<local-ref> <local-sha> <remote-ref> <remote-sha>`.
# Exit non-zero to abort the push.
REMOTE_NAME="${1:-}"
REMOTE_URL="${2:-}"

# Drain stdin so git doesn't see SIGPIPE if we exit early; we don't act on
# the ref list (we're identity-scoped, not content-scoped).
if [ ! -t 0 ]; then
  cat >/dev/null
fi

# --- Scope filter: GitHub remotes only -------------------------------------
# Detection covers:
#   - https://github.com/owner/repo[.git]
#   - git@github.com:owner/repo[.git]
#   - ssh://git@github.com[:port]/owner/repo[.git]
#   - https://<token>@github.com/owner/repo[.git]
# Explicitly NOT matched (the ADO/Azure DevOps surfaces, and others):
#   - https://dev.azure.com/<org>/<project>/_git/<repo>
#   - https://<org>@dev.azure.com/<org>/...
#   - git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
#   - https://<org>.visualstudio.com/<project>/_git/<repo>
#   - <project>@vs-ssh.visualstudio.com:v3/<org>/...
#   - gitlab.com / *.gitlab.com / self-hosted Gitea / Bitbucket / etc.
#
# Implementation: extract the host component and compare to `github.com`
# exactly (case-insensitive). Substring matching is unsafe — it admits
# `notgithub.com`, `github.com.attacker.tld`, `github.company.internal`,
# and similar look-alikes. Source: code-review + security-review 2026-05-26.
extract_host() {
  local url="$1" host host_part path_part=""
  # Strip scheme (anything ending in `://`)
  case "$url" in *://*) url="${url#*://}" ;; esac
  # Split host portion from path FIRST. This is critical: `@` in the path
  # (e.g. `github.com/owner/repo@v1`) must not be mistaken for userinfo,
  # and double-`@` in userinfo (`user:pa@ss@github.com/...`, RFC-violating
  # but plausible from a `git remote set-url` typo or hostile injection)
  # must not split at the FIRST `@`. Source: security-review 2026-05-26 LOW.
  host_part="${url%%/*}"
  # Within host_part, take everything AFTER the last `@` (handles
  # `user:pa@ss@host` correctly, since the rightmost `@` separates
  # userinfo from authority).
  case "$host_part" in
    *@*)
      host_part="${host_part##*@}"
      ;;
  esac
  # host_part is now `host[:port]` or `host` (SCP-style `host:path` is
  # handled below — detected by absence of `://` and presence of `:`).
  # SCP-style: `user@host:path` (no scheme, no `/` before the `:`). The
  # `host_part="${url%%/*}"` above kept the whole `user@host:path` if no
  # `/` exists; strip from the first `:` to leave just the host.
  host="${host_part%%[:]*}"
  # Strip trailing `.` (absolute-DNS form). DNS treats `github.com.` and
  # `github.com` as the same authority; we must classify both as GitHub.
  # Source: security-review 2026-05-27 LOW (trailing-dot FQDN bypass);
  # RFC 3986 §3.2.2.
  host="${host%.}"
  # IPv6-literal URLs (`https://[::1]/...`) end up as `host="["` here —
  # acceptable: GitHub does not serve over an IPv6-literal authority, so
  # passthrough is the correct classification.
  # Lowercase (DNS hostnames are case-insensitive; bash 3.2-safe via tr)
  printf '%s' "$host" | tr '[:upper:]' '[:lower:]'
  # path_part declared but intentionally unused — reserved for future
  # path-aware classification.
  : "$path_part"
}

# Best-effort owner extraction from a remote URL (first path segment). Bash
# 3.2 safe. Returns "" on shapes we don't recognize; the caller validates
# with is_valid_login and an active-login equality check, so a wrong guess is
# simply never offered. Used only by the ADR-0025 interactive bootstrap to
# compute a reference-only suggestion.
extract_owner() {
  local url="$1" path
  case "$url" in
    *://*)            # scheme://[userinfo@]host[:port]/owner/repo[.git]
      url="${url#*://}"
      path="${url#*/}"            # everything after the first '/' = owner/repo
      ;;
    *@*:*)            # scp-style: user@host:owner/repo[.git]
      path="${url#*:}"
      ;;
    *)
      path="$url"
      ;;
  esac
  path="${path%%/*}"                # first path segment
  printf '%s' "$path"
}

# Best-effort gh call used ONLY for the interactive-bootstrap suggestion.
# Soft timeout via `timeout` when available (Linux/CI runners); on platforms
# without it (stock macOS) it degrades to a plain call — the operator is
# present at the prompt and can Ctrl-C. Failures and timeouts yield empty
# output, so a wedged network simply means "no suggestion offered".
bootstrap_gh() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 5 gh "$@" 2>/dev/null || true
  else
    gh "$@" 2>/dev/null || true
  fi
}

REMOTE_HOST="$(extract_host "$REMOTE_URL")"
case "$REMOTE_HOST" in
  github.com)
    # GitHub — fall through to identity checks
    :
    ;;
  *)
    # Non-GitHub remote (ADO, GitLab, Bitbucket, self-hosted, …). The
    # active GitHub identity does not gate this operation. Pass silently
    # — emitting noise on every non-GitHub push would punish the dual-host
    # workflow (which is exactly what asked for this filter).
    exit 0
    ;;
esac

# --- Session bypass --------------------------------------------------------
# Evaluated AFTER the scope filter so a non-GitHub push with the env var
# set doesn't emit a misleading "bypass" line for an operation that would
# have passed silently anyway (code-review 2026-05-26 INFO).
if [ "${SKIP_GH_IDENTITY_GUARD:-}" = "1" ]; then
  warn skip "SKIP_GH_IDENTITY_GUARD=1 — gh-identity-guard bypassed for this push"
  echo
  echo "PASS — 0 errors, 1 warning"
  exit 0
fi

# --- Per-invocation override: GH_IDENTITY_OVERRIDE=<login> -----------------
# Validate against the GitHub username regex BEFORE accepting, identical
# defense-in-depth to lib/overrides.ts in the extension (prevents
# prompt/env-injected newlines or ANSI from ever reaching downstream).
# NOTE: the bash group `([a-zA-Z0-9]|-[a-zA-Z0-9])` consumes up to 2 chars
# per iteration (vs. the TS lookahead form). With the optional EMU suffix
# the bare regex would admit strings up to 86 chars (1 + 38·2 + 1 + 8).
# Pair with an explicit length cap to match the extension's 39-char
# ceiling. Source: code-review 2026-05-26 WARNING; refreshed for EMU
# suffix 2026-05-27 (#262).
#
# Enterprise Managed Users (EMU) usernames carry a mandatory `_<shortcode>`
# suffix (shortcode = 3–8 alnum chars). Accept that suffix as optional. The
# 39-char length cap below remains authoritative for total length. Source:
# docs.github.com EMU username considerations (issue #262).
GH_LOGIN_RE='^[a-zA-Z0-9]([a-zA-Z0-9]|-[a-zA-Z0-9]){0,38}(_[a-zA-Z0-9]{3,8})?$'

is_valid_login() {
  [ "${#1}" -le 39 ] && [[ "$1" =~ $GH_LOGIN_RE ]]
}

if [ -n "${GH_IDENTITY_OVERRIDE:-}" ]; then
  override_raw="$GH_IDENTITY_OVERRIDE"
  # Strip one matching wrapping quote pair (operator ergonomics)
  case "$override_raw" in
    \"*\") override_raw="${override_raw#\"}"; override_raw="${override_raw%\"}" ;;
    \'*\') override_raw="${override_raw#\'}"; override_raw="${override_raw%\'}" ;;
  esac
  if ! is_valid_login "$override_raw"; then
    # Scrub control bytes before echoing operator-typed input to terminal.
    err override "GH_IDENTITY_OVERRIDE='$(sanitize "$GH_IDENTITY_OVERRIDE")' is not a valid GitHub username"
    err override "expected: 1–39 chars, alphanumeric with non-consecutive single dashes"
    echo
    echo "FAIL — 1 error, 0 warnings"
    exit 1
  fi
  # ALLOWED_LOGINS is an array — single-element here, multi-element when
  # resolved from config (per extension parity, see read_* functions below).
  ALLOWED_LOGINS=("$override_raw")
  warn override "GH_IDENTITY_OVERRIDE applied — expecting '${override_raw}' for this push"
else
  ALLOWED_LOGINS=()
fi

# --- Resolve expected identity (when no override) --------------------------
# Mirrors agent/extensions/gh-identity-guard/lib/identity.ts:
#   1. git-tracked <repo>/.pi/expected-identity (ALL valid logins; ignore blanks + '#' comments)
#   2. ~/.pi/agent/settings.json    (.extensionSettings.ghIdentityGuard.expectedIdentity,
#                                    string OR array — ALL valid entries)
# Fail-closed on neither set. Multi-login support is load-bearing for
# repos authorizing both a human maintainer AND a CI bot
# (`expectedIdentity: ["alice", "alice-bot"]`). Single-login parity bug
# fixed per code-review 2026-05-26 ERROR.

per_repo_pin_is_tracked() {
  local repo_root="$1"
  git -C "$repo_root" ls-files --error-unmatch -- .pi/expected-identity >/dev/null 2>&1
}

untracked_per_repo_pin_exists() {
  local repo_root path
  if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    return 1
  fi
  path="${repo_root}/.pi/expected-identity"
  [ -e "$path" ] || return 1
  per_repo_pin_is_tracked "$repo_root" && return 1
  return 0
}

read_per_repo_file() {
  local repo_root path line cleaned
  if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    return 1
  fi
  path="${repo_root}/.pi/expected-identity"
  [ -e "$path" ] || return 1
  if ! per_repo_pin_is_tracked "$repo_root"; then
    warn config ".pi/expected-identity exists but is not tracked by git; ignoring local-only identity policy"
    return 1
  fi
  [ -f "$path" ] || return 1
  if [ ! -r "$path" ]; then
    # Exists but unreadable (e.g. permission error) — surface it and fall
    # through to the user layer, parity with the extension's #268 notify.
    warn config ".pi/expected-identity exists but is not readable (check file permissions); falling back to user-layer settings"
    return 1
  fi
  local found=0
  while IFS= read -r line || [ -n "$line" ]; do
    # Strip CR, leading/trailing whitespace, inline '#' comments
    cleaned="${line%$'\r'}"
    cleaned="${cleaned%%#*}"
    # shellcheck disable=SC2001  # need regex, not parameter-expansion
    cleaned="$(printf '%s' "$cleaned" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "$cleaned" ] && continue
    if is_valid_login "$cleaned"; then
      printf '%s\n' "$cleaned"
      found=1
    fi
  done < "$path"
  if [ "$found" -eq 0 ]; then
    # File exists but yielded zero valid logins (likely a typo). Surface a
    # WARN, then fall through to the user layer (parity with the extension's
    # #259 item-2 notify). `warn` now writes to stderr (#267), so it survives
    # the `vals="$(read_per_repo_file)"` stdout capture and reaches the
    # operator — the explicit `>&2` workaround this replaced is no longer
    # needed.
    warn config ".pi/expected-identity exists but contains no valid logins — check for typos; falling back to user-layer settings"
  fi
  [ "$found" -eq 1 ]
}

read_user_layer() {
  local home="${HOME:-}"
  if [ -z "$home" ]; then
    return 1
  fi
  local path="${home}/.pi/agent/settings.json"
  [ -f "$path" ] || return 1
  if ! command -v jq >/dev/null 2>&1; then
    # shellcheck disable=SC2088  # literal path shown to operator, not expanded
    warn config "~/.pi/agent/settings.json exists but jq is not on PATH; cannot parse user-layer fallback"
    return 1
  fi
  # Extension supports string OR array. Yield all valid entries.
  local value
  if ! value="$(jq -r '
    .extensionSettings.ghIdentityGuard.expectedIdentity
    | if type == "string" then .
      elif type == "array" then .[]
      else empty
      end
  ' "$path" 2>/dev/null)"; then
    # shellcheck disable=SC2088  # literal path shown to operator, not expanded
    warn config "~/.pi/agent/settings.json present but jq failed to parse it"
    return 1
  fi
  local line found=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if is_valid_login "$line"; then
      printf '%s\n' "$line"
      found=1
    fi
  done <<< "$value"
  [ "$found" -eq 1 ]
}

if [ "${#ALLOWED_LOGINS[@]}" -eq 0 ]; then
  if vals="$(read_per_repo_file)"; then
    while IFS= read -r line; do
      [ -n "$line" ] && ALLOWED_LOGINS+=("$line")
    done <<< "$vals"
  elif vals="$(read_user_layer)"; then
    while IFS= read -r line; do
      [ -n "$line" ] && ALLOWED_LOGINS+=("$line")
    done <<< "$vals"
  else
    if untracked_per_repo_pin_exists; then
      err config ".pi/expected-identity exists but is not tracked by git; refusing to trust local-only identity policy"
      err config "commit it before re-running the push:"
      err config "    git add .pi/expected-identity"
      err config "    git commit -m 'chore: pin expected GitHub identity'"
      echo
      echo "FAIL — 1 error, 1 warning"
      exit 1
    fi

    # --- Interactive bootstrap (ADR-0025) --------------------------------
    # Offer to create <repo>/.pi/expected-identity, but ONLY with a provably
    # attached controlling terminal, and the triggering push STILL fails
    # closed after any write (operator commits + re-runs; the re-run hits the
    # real drift probe). git fed the ref list on stdin (drained above), so
    # `[ -t 0 ]` is false/useless here; open /dev/tty directly and check the
    # open succeeded (ENXIO => no controlling tty => CI/daemon => fail
    # closed). `[ -t 2 ]` is an intent heuristic suppressing IDE/CI clients
    # that inherit a tty with no human. ALL prompts -> &3, ALL input <&3 —
    # never stdin.
    #
    # INVARIANT (ADR-0025): this branch is reached only AFTER the scope
    # filter, SKIP_GH_IDENTITY_GUARD, and GH_IDENTITY_OVERRIDE short-circuits
    # above, so no bypass surface ever reaches the prompt.
    if [ -t 2 ] && { exec 3<>/dev/tty; } 2>/dev/null; then
      bootstrap_root="$(git rev-parse --show-toplevel 2>/dev/null)" || bootstrap_root=""
      if [ -n "$bootstrap_root" ]; then
        printf '\n' >&3
        printf 'No expected GitHub identity is configured for this repo.\n' >&3
        printf 'Create %s/.pi/expected-identity now? [y/N] ' "$bootstrap_root" >&3
        bootstrap_ans=""
        IFS= read -r -t 60 bootstrap_ans <&3 || bootstrap_ans=""   # Ctrl-D/timeout => ""
        case "$bootstrap_ans" in
          y|Y|yes|YES|Yes)
            # Reference-only suggestion (ADR-0025 B1): active gh login IFF it
            # equals the remote owner AND the remote is NOT a personal fork.
            # NEVER pre-accepted — shown for reference; operator re-types it.
            bootstrap_suggestion=""
            active_login=""
            owner=""
            if command -v gh >/dev/null 2>&1; then
              active_login="$(bootstrap_gh api /user --jq .login)"
              owner="$(extract_owner "$REMOTE_URL")"
              if [ -n "$active_login" ] && [ "$active_login" = "$owner" ] && is_valid_login "$active_login"; then
                # Suppress the suggestion on a personal fork (parent non-null).
                # gh resolves the repo from the cwd's default remote; in the
                # common single-origin case that IS the push target. A rare
                # multi-remote mismatch only risks SHOWING a suggestion that
                # should have been hidden — neutralized by the re-type rule.
                bootstrap_parent="$(bootstrap_gh repo view --json parent --jq 'if .parent then "fork" else empty end')"
                [ -z "$bootstrap_parent" ] && bootstrap_suggestion="$active_login"
              fi
              # Surface the facts so any owner/login conflation is visible.
              printf '  active gh login : %s\n' "$(sanitize "${active_login:-<none>}")" >&3
              printf '  remote owner    : %s\n' "$(sanitize "${owner:-<none>}")" >&3
              [ -n "$bootstrap_suggestion" ] && printf '  suggestion      : %s (re-type to confirm)\n' "$bootstrap_suggestion" >&3
            fi
            printf 'Enter the expected GitHub login: ' >&3
            bootstrap_login=""
            IFS= read -r -t 60 bootstrap_login <&3 || bootstrap_login=""
            bootstrap_login="$(sanitize "$bootstrap_login")"   # strips control bytes incl. newlines

            # Unconditional validation (ADR-0025) — SINGLE attempt, fail closed.
            if [ -z "$bootstrap_login" ] || ! is_valid_login "$bootstrap_login"; then
              exec 3<&-
              err config "invalid GitHub login '$(sanitize "$bootstrap_login")' — nothing written"
              err config "expected: 1–39 chars, alphanumeric with non-consecutive single dashes"
              echo
              echo "FAIL — 1 error, 0 warnings"
              exit 1
            fi

            # Atomic write: write to a temp file in the same dir, then mv (an
            # atomic rename) so a mid-write Ctrl-C never leaves an empty or
            # partial file that would demote to the user layer. Mode is the
            # default 0644 — the trust anchor is committed and world-readable
            # by design (parity with its tracked state; logins are public).
            bootstrap_path="${bootstrap_root}/.pi/expected-identity"
            bootstrap_tmp="${bootstrap_path}.tmp.$$"
            if ! mkdir -p "${bootstrap_root}/.pi" 2>/dev/null \
               || ! ( umask 0022; printf '%s\n' "$bootstrap_login" > "$bootstrap_tmp" ) 2>/dev/null \
               || ! mv "$bootstrap_tmp" "$bootstrap_path" 2>/dev/null; then
              rm -f "$bootstrap_tmp" 2>/dev/null || true
              exec 3<&-
              err config "could not write ${bootstrap_path}"
              echo
              echo "FAIL — 1 error, 0 warnings"
              exit 1
            fi
            exec 3<&-

            ok  config "wrote ${bootstrap_path} ('${bootstrap_login}')"
            # .gitignore-aware nudge: if .pi is ignored, the commit can't land
            # without an explicit un-ignore rule.
            if git -C "$bootstrap_root" check-ignore -q .pi/expected-identity 2>/dev/null; then
              warn config ".pi/expected-identity is gitignored — add a '!.pi/expected-identity' rule before committing"
            fi
            err config "this file is tracked policy — commit it, then re-run your push:"
            err config "    git add .pi/expected-identity"
            err config "    git commit -m 'chore: pin expected GitHub identity'"
            echo
            # ADR-0025 A1: fail closed even on success — the file is not yet
            # committed and the active-identity probe has not run. Re-pushing
            # after the commit exercises the real drift check.
            echo "FAIL — 1 error, 0 warnings"
            exit 1
            ;;
          *)
            # Declined / empty / EOF / timeout — fall through to static guidance.
            exec 3<&-
            ;;
        esac
      else
        exec 3<&-   # no worktree → nowhere to write
      fi
    fi

    # ---- Fail-closed static guidance (UNCHANGED) ------------------------
    # Reached for: non-TTY (CI/IDE/pipe), no worktree, declined, EOF/timeout,
    # or any bootstrap error that fell through.
    err config "no expected GitHub identity configured for this repo"
    err config "remote: ${REMOTE_NAME:-?} → $(sanitize "${REMOTE_URL}")"
    err config "configure one of:"
    err config "  • <repo>/.pi/expected-identity   (git-tracked per-repo file)"
    err config "  • ~/.pi/agent/settings.json      (user-layer:"
    err config "      .extensionSettings.ghIdentityGuard.expectedIdentity)"
    err config "  • GH_IDENTITY_OVERRIDE=<login>   (one-shot env override)"
    err config "  • SKIP_GH_IDENTITY_GUARD=1       (one-shot bypass)"
    err config "  • git push --no-verify           (bypass all pre-push hooks)"
    echo
    echo "FAIL — 1 error, 0 warnings"
    exit 1
  fi
fi

# --- Active-identity probe via shared helper -------------------------------
# Resolve through any symlinks first (production install path is a symlink
# from `.git/hooks/pre-push` to this file). Source: CRITICAL above.
RESOLVED_SELF="$(resolve_symlink "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$RESOLVED_SELF")" && pwd)"
REPO_ROOT_FOR_HOOK="$(cd "${SCRIPT_DIR}/.." && pwd)"
HELPER="${REPO_ROOT_FOR_HOOK}/scripts/lib/gh-verify-user.sh"

if [ ! -f "$HELPER" ]; then
  err env "gh-verify-user helper not found at ${HELPER}"
  err env "resolved hook path: ${RESOLVED_SELF}"
  err env "expected pi_config layout: pi_config/hooks/gh-identity-guard.sh"
  echo
  echo "FAIL — 1 error, 0 warnings"
  exit 2
fi

# shellcheck source=../scripts/lib/gh-verify-user.sh
. "$HELPER"

# Probe ONCE, capture the actual login, then compare against every
# ALLOWED_LOGINS entry. This avoids N probes for multi-login configs and
# matches the extension's identity-membership semantics in
# lib/identity.ts + lib/overrides.ts.
#
# We need to distinguish the helper's rc=0 (match), rc=1 (drift, with
# actual login on stdout), and rc=2 (env error — gh missing,
# unauthenticated, network). The natural `if ! cmd; then probe_rc=$?` form
# always sees 0 because `!` negates the status before `$?` is read — a
# subtle dead-branch hazard called out in code-review 2026-05-26. Use the
# explicit `&&/||` capture pattern instead.
actual_login="$(__gvu_quiet=1 gh_verify_user "${ALLOWED_LOGINS[0]}")" && probe_rc=0 || probe_rc=$?

if [ "$probe_rc" -eq 2 ]; then
  err probe "could not determine active gh identity (gh missing, unauthenticated, or API error)"
  err probe "run 'gh auth status' for details"
  echo
  echo "FAIL — 1 error, 0 warnings"
  exit 2
fi

if [ -z "$actual_login" ]; then
  # Defensive: rc=0 or rc=1 should both yield a login on stdout per the
  # current helper contract. Empty stdout with non-2 rc means the contract
  # changed underneath us — fail closed.
  err probe "gh-verify-user returned no login (rc=${probe_rc}); helper contract violation"
  echo
  echo "FAIL — 1 error, 0 warnings"
  exit 2
fi

matched=0
for candidate in "${ALLOWED_LOGINS[@]}"; do
  if [ "$actual_login" = "$candidate" ]; then
    matched=1
    break
  fi
done

if [ "$matched" -eq 1 ]; then
  ok identity "active gh user '${actual_login}' matches expected for ${REMOTE_NAME:-?}"
  echo
  echo "PASS — 0 errors, 0 warnings"
  exit 0
fi

expected_display="${ALLOWED_LOGINS[*]}"
err drift "identity drift: active gh user is '$(sanitize "$actual_login")', expected one of: ${expected_display}"
err drift "this push would attribute commits to the wrong GitHub account"
err drift "remediate with: gh auth switch  (then re-run push)"
err drift "or override with: GH_IDENTITY_OVERRIDE='${actual_login}' git push  (if intentional)"
echo
echo "FAIL — 1 error, 0 warnings"
exit 1
