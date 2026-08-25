#!/usr/bin/env bash
#
# commit-trailer-guard.sh — git commit-msg hook (ADR-0143, #1028)
#
# Mechanically enforces conventional-commits.md's no-attribution rule:
# authorship-attribution trailers and tool-attribution lines are removed from
# (or, in reject mode, fail) every commit message, on every composition path —
# -m, -F, editor, amend, and harness sessions whose platforms mandate the
# trailers. Signed-off-by (DCO) is attestation, not attribution, and is never
# matched.
#
# Default posture is STRIP: matched lines are removed in place and the commit
# proceeds clean. A harness session cannot change its platform's mandate, so a
# reject default would create a failure loop nobody can fix from inside the
# session. Every strip is announced with one WARN line — a silently edited
# message must never be a mystery hunt.
#
# Install (per repo):
#   ln -s "$(git rev-parse --show-toplevel)/hooks/commit-trailer-guard.sh" \
#         "$(git rev-parse --show-toplevel)/.git/hooks/commit-msg"
# Or run pi_config setup with:
#   INSTALL_GIT_HOOKS=1 ./setup.sh
#
# Posture configuration (env wins over file; default strip):
#   COMMIT_TRAILER_GUARD_MODE=reject       fail the commit naming each trailer
#   <repo>/.pi/trailer-guard-mode          file containing "strip" or "reject"
#
# Override mechanisms (lowest blast radius first; every use is visible —
# refusal policy: continue-eligible per the #69 convention):
#   SKIP_COMMIT_TRAILER_GUARD=1 git commit ...   one-shot env-var bypass
#   .pi/trailer-allowlist (repo root)            per-repo permitted-trailer
#                                                patterns (case-insensitive
#                                                extended regex, one per line;
#                                                the recorded exemption for
#                                                repos that keep harness
#                                                attribution)
#   git commit --no-verify                       emergency bypass (all hooks)
#
# Exit codes:
#   0 — pass (message clean, or stripped clean)
#   1 — fail (reject mode only: attribution present)
#   2 — environment failure
#
# Targets bash 3.2+ (no associative arrays, no ${var,,}).

set -uo pipefail

# Inline helpers: installed standalone into .git/hooks/, so scripts/lib is
# not reachable from every invocation context.
warn() { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }

if [ "${SKIP_COMMIT_TRAILER_GUARD:-}" = "1" ]; then
  warn "skip" "SKIP_COMMIT_TRAILER_GUARD=1 set — commit-trailer guard bypassed"
  exit 0
fi

MSG_FILE="${1:-}"
if [ -z "$MSG_FILE" ] || [ ! -f "$MSG_FILE" ]; then
  err "env" "commit-msg hook invoked without a readable message file"
  exit 2
fi

for required_command in git grep mktemp head tr cat rm; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    err "env" "$required_command is required but not on PATH"
    exit 2
  fi
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"

# --- Posture ---------------------------------------------------------------
MODE="strip"
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.pi/trailer-guard-mode" ]; then
  file_mode="$(head -n1 "$REPO_ROOT/.pi/trailer-guard-mode" | tr -d '[:space:]')"
  case "$file_mode" in
    strip|reject) MODE="$file_mode" ;;
    *) warn "config" ".pi/trailer-guard-mode contains '$file_mode' (expected strip|reject); using strip" ;;
  esac
fi
if [ -n "${COMMIT_TRAILER_GUARD_MODE:-}" ]; then
  case "$COMMIT_TRAILER_GUARD_MODE" in
    strip|reject) MODE="$COMMIT_TRAILER_GUARD_MODE" ;;
    *) warn "config" "COMMIT_TRAILER_GUARD_MODE='$COMMIT_TRAILER_GUARD_MODE' (expected strip|reject); using $MODE" ;;
  esac
fi

# --- Allowlist -------------------------------------------------------------
# One case-insensitive extended regex per line; a message line matching any
# allowlist pattern is kept even when it matches the attribution set below.
ALLOWLIST_PATTERNS=()
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.pi/trailer-allowlist" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    case "$line" in \#*|[[:space:]]\#*) continue ;; esac
    ALLOWLIST_PATTERNS+=("$line")
  done < "$REPO_ROOT/.pi/trailer-allowlist"
fi

is_allowlisted() {
  local text="$1" pat
  for pat in ${ALLOWLIST_PATTERNS[@]+"${ALLOWLIST_PATTERNS[@]}"}; do
    if printf '%s\n' "$text" | grep -Eiq -- "$pat"; then
      return 0
    fi
  done
  return 1
}

# --- Match set (test-pinned; ADR-0143) -------------------------------------
# Deliberately narrow: attribution forms observed from harness platforms.
#   1. Co-Authored-By trailers (any case).
#   2. "Generated with <tool>" attribution lines, with or without the robot
#      emoji / markdown link the harnesses emit.
#   3. Robot-emoji attribution lines.
#   4. Tool/session attribution trailers (Claude-*/Codex-*/Copilot-*
#      trailer keys, and *-Session-Id style session trailers).
# Explicitly NOT matched: Signed-off-by (DCO attestation).
is_attribution() {
  local text="$1"
  # DCO attestation is never attribution — checked first, case-insensitively.
  if printf '%s\n' "$text" | grep -Eiq '^[[:space:]]*signed-off-by:'; then
    return 1
  fi
  printf '%s\n' "$text" | grep -Eiq \
    -e '^[[:space:]]*co-authored-by:' \
    -e '^[[:space:]]*(🤖[[:space:]]*)?generated (with|by) ' \
    -e '^[[:space:]]*🤖' \
    -e '^[[:space:]]*(claude|codex|copilot|gemini|cursor|aider)-[a-z0-9-]+:' \
    -e '^[[:space:]]*[a-z0-9-]*session-id:'
}

# --- Scan ------------------------------------------------------------------
matched=()
while IFS= read -r line || [ -n "$line" ]; do
  # Comment lines are git's own scaffolding, never part of the message.
  case "$line" in \#*) continue ;; esac
  [ -z "$line" ] && continue
  if is_attribution "$line" && ! is_allowlisted "$line"; then
    matched+=("$line")
  fi
done < "$MSG_FILE"

if [ "${#matched[@]}" -eq 0 ]; then
  exit 0
fi

if [ "$MODE" = "reject" ]; then
  for line in "${matched[@]}"; do
    err "trailer" "attribution line rejected: $line"
  done
  err "trailer" "conventional-commits.md bans authorship attributions (ADR-0143); overrides: SKIP_COMMIT_TRAILER_GUARD=1, .pi/trailer-allowlist, --no-verify"
  exit 1
fi

# --- Strip -----------------------------------------------------------------
tmp="$(mktemp "${TMPDIR:-/tmp}/commit-trailer-guard.XXXXXX")" || {
  err "env" "mktemp failed"
  exit 2
}
trap 'rm -f "$tmp"' EXIT

while IFS= read -r line || [ -n "$line" ]; do
  keep=1
  case "$line" in
    \#*) keep=1 ;;
    "") keep=1 ;;
    *)
      if is_attribution "$line" && ! is_allowlisted "$line"; then
        keep=0
      fi
      ;;
  esac
  if [ "$keep" = "1" ]; then
    printf '%s\n' "$line" >>"$tmp"
  fi
done < "$MSG_FILE"

cat "$tmp" > "$MSG_FILE"

warn "strip" "removed ${#matched[@]} attribution line(s) per conventional-commits.md (ADR-0143); overrides: SKIP_COMMIT_TRAILER_GUARD=1, .pi/trailer-allowlist"
exit 0
