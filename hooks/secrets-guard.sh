#!/usr/bin/env bash
#
# secrets-guard.sh — git pre-commit hook
#
# Blocks commits containing unencrypted Ansible vault files and common secret
# patterns (PEM private keys, AWS access keys, GitHub tokens, signed JWTs,
# Authorization: Bearer literals, SSH private key file paths).
#
# This is a git pre-commit hook, not a pi extension. The pi-extension
# counterpart lives at agent/extensions/secrets-guard/index.ts and uses the
# same pattern set.
#
# Install (per repo):
#   ln -s "$(git rev-parse --show-toplevel)/hooks/secrets-guard.sh" \
#         "$(git rev-parse --show-toplevel)/.git/hooks/pre-commit"
# Or run pi_config setup with:
#   INSTALL_GIT_HOOKS=1 ./setup.sh
#
# Override mechanisms (lowest blast radius first):
#   SKIP_SECRETS_GUARD=1 git commit ...     one-shot env-var bypass
#   .secrets-guard-allowlist (repo root)    per-path glob allowlist
#   git commit --no-verify                  emergency bypass (all hooks)
#
# Exit codes:
#   0 — pass (no findings)
#   1 — fail (findings present)
#   2 — environment failure
#
# Targets bash 3.2+ (no associative arrays, no ${var,,}).

set -uo pipefail

VERBOSE="${SECRETS_GUARD_VERBOSE:-false}"

ok()     { echo "OK    [$1] $2"; }
warn()   { echo "WARN  [$1] $2"; }
err()    { echo "ERROR [$1] $2" >&2; }
detail() { if [ "$VERBOSE" = "true" ]; then echo "      $*"; fi; }

if [ "${SKIP_SECRETS_GUARD:-}" = "1" ]; then
  warn "skip" "SKIP_SECRETS_GUARD=1 set — secrets guard bypassed"
  exit 0
fi

for required_command in git grep awk head mktemp; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    err "env" "$required_command is required but not on PATH"
    exit 2
  fi
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  err "env" "not inside a git repository"
  exit 2
fi

# --- Allowlist -------------------------------------------------------------
ALLOWLIST_FILE="$REPO_ROOT/.secrets-guard-allowlist"
ALLOWLIST_PATTERNS=()
if [ -f "$ALLOWLIST_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    case "$line" in \#*|[[:space:]]\#*) continue ;; esac
    ALLOWLIST_PATTERNS+=("$line")
  done < "$ALLOWLIST_FILE"
fi

is_allowlisted() {
  local path="$1" pat
  for pat in ${ALLOWLIST_PATTERNS[@]+"${ALLOWLIST_PATTERNS[@]}"}; do
    # shellcheck disable=SC2254
    case "$path" in $pat) return 0 ;; esac
  done
  return 1
}

is_skip_pattern() {
  case "$1" in
    *.example|*.sample|*.template|*.j2) return 0 ;;
    molecule/*|*/molecule/*) return 0 ;;
    tests/*|*/tests/*) return 0 ;;
    spec/*|*/spec/*) return 0 ;;
    fixtures/*|*/fixtures/*) return 0 ;;
  esac
  return 1
}

is_vault_named() {
  case "$1" in
    *vault.yml|*vault.yaml|*vault*.yml|*vault*.yaml) return 0 ;;
    */host_vars/*/vault*|*/group_vars/*/vault*) return 0 ;;
    host_vars/*/vault*|group_vars/*/vault*) return 0 ;;
  esac
  return 1
}

is_sensitive_path() {
  local base="${1##*/}"
  case "$base" in
    id_rsa|id_dsa|id_ecdsa|id_ed25519) return 0 ;;
    # FIDO2 hardware-backed keys, OpenSSH 8.2+ (#796, ADR-0111).
    id_ecdsa_sk|id_ed25519_sk) return 0 ;;
    id_rsa.pem|id_dsa.pem|id_ecdsa.pem|id_ed25519.pem) return 0 ;;
  esac
  case "$1" in
    *.pem|*.key) return 0 ;;
  esac
  return 1
}

is_binary() {
  local numstat
  numstat="$(git diff --cached --numstat -- "$1" 2>/dev/null | head -n 1)"
  case "$numstat" in -[[:space:]]*-[[:space:]]*) return 0 ;; esac
  return 1
}

# Vault encryption header (covers 1.1 and 1.2 with vault IDs)
# shellcheck disable=SC2016
VAULT_HEADER_RE='^\$ANSIBLE_VAULT;[0-9]+\.[0-9]+;[A-Z0-9]+'

# Secret-content patterns supported directly by both GNU and BSD grep -E.
# Keep their detector semantics in lockstep with
# agent/extensions/secrets-guard/index.ts and
# agent/extensions/shared/secret-scan.ts (ADR-0071/0088). Signed JWTs use the
# bounded awk scanner below because BSD grep rejects interval maxima above 255.
GREP_SECRET_PATTERNS='-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY|(^|[^A-Z0-9])(AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}([^A-Z0-9]|$)|gh[oprsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{82,}|[Aa]uthorization: [Bb]earer [A-Za-z0-9._~+/=-]{20,}'

# These bounds are semantically identical to each TS copy's V8
# `{10,4000}` intervals. They remain separate constants so validate.sh and the
# hook regression suite can enforce the cross-engine contract honestly.
JWT_SEGMENT_MIN=10
JWT_SEGMENT_MAX=4000

# scan_grep_patterns <file>
# scan_signed_jwt <file>
# scan_content <file>
# Return 0 for a match, 1 for no match, and 2 for an input/scanner failure.
# grep deliberately runs without -q so it consumes the capped input; otherwise
# an early match can SIGPIPE head under pipefail and disguise a real finding.
scan_grep_patterns() {
  local file="$1" statuses grep_status
  head -c 524288 "$file" 2>/dev/null \
    | grep -E -- "$GREP_SECRET_PATTERNS" >/dev/null
  statuses=("${PIPESTATUS[@]}")
  [ "${statuses[0]}" -eq 0 ] || return 2
  grep_status="${statuses[1]}"
  case "$grep_status" in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

scan_signed_jwt() {
  local file="$1" statuses awk_status
  head -c 524288 "$file" 2>/dev/null \
    | awk -v min="$JWT_SEGMENT_MIN" -v max="$JWT_SEGMENT_MAX" '
      function valid_prefixed(segment, body_length) {
        body_length = length(segment) - 3
        return substr(segment, 1, 3) == "eyJ" \
          && body_length >= min && body_length <= max
      }
      function valid_header_suffix(segment, segment_length, window_start, window, offset, body_length) {
        segment_length = length(segment)
        window_start = segment_length - max - 2
        if (window_start < 1) window_start = 1
        window = substr(segment, window_start)
        while ((offset = index(window, "eyJ")) > 0) {
          body_length = segment_length - (window_start + offset - 1) - 2
          if (body_length >= min && body_length <= max) return 1
          window_start += offset
          window = substr(segment, window_start)
        }
        return 0
      }
      function valid_signature(segment) {
        return length(segment) >= min && length(segment) <= max
      }
      {
        if (found) next
        chunk_count = split($0, chunks, /[^A-Za-z0-9_.-]+/)
        for (chunk_index = 1; chunk_index <= chunk_count && !found; chunk_index++) {
          segment_count = split(chunks[chunk_index], segments, /[.]/)
          for (segment_index = 1; segment_index + 2 <= segment_count; segment_index++) {
            if (valid_header_suffix(segments[segment_index]) \
                && valid_prefixed(segments[segment_index + 1]) \
                && valid_signature(segments[segment_index + 2])) {
              found = 1
              break
            }
          }
        }
      }
      END { exit found ? 0 : 1 }
    ' >/dev/null
  statuses=("${PIPESTATUS[@]}")
  [ "${statuses[0]}" -eq 0 ] || return 2
  awk_status="${statuses[1]}"
  case "$awk_status" in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

scan_content() {
  local file="$1" scan_status
  scan_grep_patterns "$file"
  scan_status=$?
  case "$scan_status" in
    0) return 0 ;;
    2) return 2 ;;
  esac

  scan_signed_jwt "$file"
}

errors=0
warnings=0
scanned=0
skipped_count=0

staged_file_list="$(mktemp -t secrets-guard.XXXXXX)" || {
  err "env" "cannot create staged-file list — commit blocked"
  exit 2
}
# shellcheck disable=SC2329  # invoked indirectly by the traps below
cleanup_staged_file_list() { rm -f "$staged_file_list"; }
trap cleanup_staged_file_list EXIT
trap 'cleanup_staged_file_list; exit 2' HUP INT TERM

if ! git diff --cached --name-only --diff-filter=ACM -z >"$staged_file_list" 2>/dev/null; then
  err "git" "staged-file enumeration failed — commit blocked"
  exit 2
fi

files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done <"$staged_file_list"

if [ ${#files[@]} -eq 0 ]; then
  ok "scan" "no staged files to check"
  echo "=================================="
  echo "PASS — 0 errors, 0 warnings"
  exit 0
fi

for staged_path in "${files[@]}"; do
  full_path="$REPO_ROOT/$staged_path"

  if is_allowlisted "$staged_path"; then
    warn "allowlist" "$staged_path matches allowlist — skipped"
    warnings=$((warnings + 1))
    skipped_count=$((skipped_count + 1))
    continue
  fi

  if is_skip_pattern "$staged_path"; then
    detail "skip $staged_path (skip-pattern)"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  scanned=$((scanned + 1))

  if is_sensitive_path "$staged_path"; then
    err "sensitive-path" "$staged_path looks like a private key or sensitive file"
    errors=$((errors + 1))
    continue
  fi

  if is_vault_named "$staged_path"; then
    if [ ! -f "$full_path" ]; then
      detail "vault $staged_path not on disk (skipped)"
      continue
    fi
    first_line="$(head -n 1 "$full_path" 2>/dev/null || true)"
    if [[ "$first_line" =~ $VAULT_HEADER_RE ]]; then
      detail "vault $staged_path is encrypted"
      continue
    fi
    err "vault" "$staged_path matches vault-naming pattern but is not encrypted"
    errors=$((errors + 1))
    continue
  fi

  if is_binary "$staged_path"; then
    detail "skip $staged_path (binary)"
    continue
  fi

  if [ ! -f "$full_path" ]; then
    detail "skip $staged_path (not regular file)"
    continue
  fi

  # Content scan, capped at 512 KB by each engine. Scanner failures are
  # environment failures, never equivalent to a clean file (#922).
  scan_content "$full_path"
  scan_status=$?
  case "$scan_status" in
    0)
      err "secret" "$staged_path contains a secret pattern"
      errors=$((errors + 1))
      ;;
    1) ;;
    *)
      err "scan" "content scanner failed for $staged_path — commit blocked"
      exit 2
      ;;
  esac
done

echo "=================================="
if [ "$errors" -gt 0 ]; then
  echo "FAIL — $errors errors, $warnings warnings ($scanned files scanned, $skipped_count skipped)"
  echo ""
  echo "Override options (lowest blast radius first):"
  echo "  SKIP_SECRETS_GUARD=1 git commit ...    one-shot bypass (auditable)"
  echo "  Add path to .secrets-guard-allowlist   known false positives"
  echo "  git commit --no-verify                 emergency bypass (all hooks)"
  exit 1
fi
echo "PASS — 0 errors, $warnings warnings ($scanned files scanned, $skipped_count skipped)"
exit 0
