#!/usr/bin/env bash
#
# expertise-audit.sh — read-only expertise audit for PRs touching the
# governed surfaces (agent/{extensions,agents,skills,rules}/**). #601,
# ADR-0095; shared implementation body for the validate.sh stage (now) and
# the opt-in pre-push hook (#604, later).
#
# Skip philosophy (documented deviation from validate.sh's "missing env is
# an error" rule): the loopback agent-expertise-api is a per-machine local
# service that no CI runner provisions today (#693), so its ABSENCE is the
# expected state — a clean SKIP, not a failure. A present-but-broken state
# (401/403 with a key set, telemetry inconsistency) fails loud.
#
# Secret handling: PI_EXPERTISE_API_KEY travels via the environment only —
# never argv (visible in `ps`), never echoed, never in artifacts. The
# reachability probe hits the UNAUTHENTICATED /health/ready with no key.
#
# Exit codes: 0 pass/skip (SKIP lines mark skips), 1 audit failure,
# 2 environment failure.
#
# Inputs (set by the workflow / caller):
#   EXPERTISE_AUDIT_BASE_SHA   PR base sha (unset → SKIP: not a PR context)
#   EXPERTISE_AUDIT_HEAD_SHA   head sha (default: git rev-parse HEAD)
#   EXPERTISE_AUDIT_TELEMETRY_DIR  optional telemetry dir to consistency-check
#   PI_EXPERTISE_API_BASE_URL  API base (default http://127.0.0.1:8080)
#   PI_EXPERTISE_API_KEY       API key (unset → SKIP past reachability)

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

# --- 3. Reachability probe — unauthenticated, no key ever in argv ------------
BASE_URL="${PI_EXPERTISE_API_BASE_URL:-http://127.0.0.1:8080}"
if ! command -v curl >/dev/null 2>&1; then
  skipline "curl unavailable for the reachability probe"
  exit 0
fi
if ! curl -fsS --max-time 3 "${BASE_URL%/}/health/ready" >/dev/null 2>&1; then
  skipline "agent-expertise-api not reachable at ${BASE_URL%/}/health/ready (#693 tracks CI provisioning)"
  exit 0
fi

# --- 4. Key presence (past this point a broken auth FAILS, not skips) --------
if [ -z "${PI_EXPERTISE_API_KEY:-}" ] && [ ! -f agent/extensions/expertise-client/.env.local ]; then
  skipline "loopback API reachable but no PI_EXPERTISE_API_KEY and no client .env.local"
  exit 0
fi

# --- 5. Toolchain (a reachable API makes the audit a required check) ---------
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

# --- 6. Delegate to the TS runner (key via env only) -------------------------
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
