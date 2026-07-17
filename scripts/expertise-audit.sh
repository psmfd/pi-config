#!/usr/bin/env bash
#
# expertise-audit.sh — read-only expertise audit for PRs touching the
# governed surfaces (agent/{extensions,agents,skills,rules}/**). #601,
# ADR-0095; shared implementation body for the validate.sh stage (now) and
# the opt-in pre-push hook (#604, later).
#
# Skip philosophy (documented deviation from validate.sh's "missing env is
# an error" rule): expertise-api is an operator-provisioned service (local or
# upstream static-OIDC) that no CI runner provisions today (#693), so absent
# config is a clean SKIP. A configured-but-broken auth state fails loud.
#
# Secret handling: the API key/JWT travels only through process env or the
# fixed operator-owned config files — never argv, output, or artifacts.
#
# Exit codes: 0 pass/skip (SKIP lines mark skips), 1 audit failure,
# 2 environment failure.
#
# Inputs (set by the workflow / caller):
#   EXPERTISE_AUDIT_BASE_SHA   PR base sha (unset → SKIP: not a PR context)
#   EXPERTISE_AUDIT_HEAD_SHA   head sha (default: git rev-parse HEAD)
#   EXPERTISE_AUDIT_TELEMETRY_DIR  optional telemetry dir to consistency-check
#   PI_EXPERTISE_API_BASE_URL / PI_EXPERTISE_API_KEY  legacy local profile
#   EXPERTISE_API_BASE_URL / EXPERTISE_API_TOKEN      upstream bearer profile
#   EXPERTISE_API_SECRETS_FILE optional upstream secrets-file override

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "ERROR expertise-audit: cannot cd to $REPO_DIR" >&2; exit 2; }

skipline() { printf 'SKIP  expertise-audit: %s\n' "$1"; }

# --- 1. PR context gate ------------------------------------------------------
BASE_SHA="${EXPERTISE_AUDIT_BASE_SHA:-}"
if [ -z "$BASE_SHA" ]; then
  skipline "no PR base context (EXPERTISE_AUDIT_BASE_SHA unset — local or push run)"
  exit 0
fi
HEAD_SHA="${EXPERTISE_AUDIT_HEAD_SHA:-$(git rev-parse HEAD 2>/dev/null)}"
if [ -z "$HEAD_SHA" ]; then
  echo "ERROR expertise-audit: cannot resolve HEAD sha" >&2
  exit 2
fi

# --- 2. Changed-set gate -----------------------------------------------------
if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  echo "ERROR expertise-audit: base sha $BASE_SHA not present (shallow clone? fetch it in the workflow)" >&2
  exit 2
fi
CHANGED="$(git diff --name-only --diff-filter=ACMR "${BASE_SHA}..${HEAD_SHA}" -- \
  'agent/extensions/' 'agent/agents/' 'agent/skills/' 'agent/rules/' 2>/dev/null)"
if [ -z "$CHANGED" ]; then
  skipline "no changes under governed paths in ${BASE_SHA:0:12}..${HEAD_SHA:0:12}"
  exit 0
fi

# --- 3. Credential-source presence -------------------------------------------
UPSTREAM_SECRETS_FILE="${EXPERTISE_API_SECRETS_FILE:-${HOME:-}/.config/expertise-api/secrets.env}"
if [ -z "${PI_EXPERTISE_API_KEY:-}" ] && \
   [ -z "${EXPERTISE_API_TOKEN:-}" ] && \
   [ ! -f agent/extensions/expertise-client/.env.local ] && \
   { [ -z "$UPSTREAM_SECRETS_FILE" ] || [ ! -f "$UPSTREAM_SECRETS_FILE" ]; }; then
  skipline "no local API key or upstream bearer-token configuration"
  exit 0
fi

# --- 4. Toolchain (configured clients make the audit a required check) -------
if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "ERROR expertise-audit: node/npx required once the API is reachable" >&2
  exit 2
fi
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/extension-deps.sh"
if ! ensure_extension_deps; then
  echo "ERROR expertise-audit: extension-deps install failed" >&2
  exit 2
fi

# --- 5. Delegate to the TS runner (credential never enters argv) -------------
TSX_VERSION="${TSX_VERSION:-4.19.2}"
audit_args=(--base-sha "$BASE_SHA" --head-sha "$HEAD_SHA" --out-dir "$REPO_DIR")
if [ -n "${EXPERTISE_AUDIT_TELEMETRY_DIR:-}" ]; then
  audit_args+=(--telemetry-dir "$EXPERTISE_AUDIT_TELEMETRY_DIR")
fi
set +e
npx --yes "tsx@${TSX_VERSION}" agent/extensions/expertise-indexer/audit-cli.ts "${audit_args[@]}"
status=$?
set -e
case "$status" in
  0) exit 0 ;;
  3) exit 0 ;;   # runner-level skip (config/ready raced away) — SKIP line already printed
  1) echo "ERROR expertise-audit: audit failed (see lines above)" >&2; exit 1 ;;
  *) echo "ERROR expertise-audit: runner environment failure (exit $status)" >&2; exit 2 ;;
esac
