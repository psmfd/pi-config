#!/usr/bin/env bash
#
# secrets-guard.sh — git pre-commit hook
#
# Blocks commits containing unencrypted Ansible vault files and common secret
# patterns (PEM private keys, AWS access keys, GitHub personal access tokens,
# SSH private key file paths).
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

if ! command -v git >/dev/null 2>&1; then
  err "env" "git is required but not on PATH"
  exit 2
fi

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

# Combined secret-content patterns (single grep -E).
SECRET_PATTERNS='-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |)PRIVATE KEY|(^|[^A-Z0-9])(AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}([^A-Z0-9]|$)|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}'

errors=0
warnings=0
scanned=0
skipped_count=0

files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(git diff --cached --name-only --diff-filter=ACM -z 2>/dev/null)

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

  # Content scan, capped at 512 KB. The leading `--` is required because the
  # combined regex starts with `-----BEGIN ... PRIVATE KEY` — without it grep
  # interprets the pattern as an option flag.
  if head -c 524288 "$full_path" 2>/dev/null | grep -qE -- "$SECRET_PATTERNS"; then
    err "secret" "$staged_path contains a secret pattern"
    errors=$((errors + 1))
  fi
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
