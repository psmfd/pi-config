#!/usr/bin/env bash
#
# add-mirror-to-installation.sh — add one or more repos to the psmfd-mirror-sync
# App installation, PAT-free, via GitHub's Enterprise organization-installation
# automation API (ADR-0064, amends ADR-0061).
#
# Why this exists: keeping the psmfd-mirror-sync App on "selected repositories"
# (least privilege, ADR-0061) means each new mirror must be added to its
# installation. The org-UI add is manual; an org-admin classic PAT would be a
# standing credential broader than the App key it manages. Instead this script
# authenticates as a dedicated enterprise "installer" App whose ONLY permission is
# "Enterprise organization installation repositories: read/write" — it can change
# which repos an installation covers, but cannot read or write any repo's contents.
#
# actions/create-github-app-token does NOT support enterprise-installed apps
# (upstream actions/create-github-app-token#303), so the installation token is
# minted here directly: a short-lived RS256 JWT signed with the installer App's
# private key is exchanged for a ghs_ installation access token, which then calls
# PATCH /enterprises/<ent>/apps/organizations/<org>/installations/<id>/repositories/add.
#
# Usage:
#   INSTALLER_APP_CLIENT_ID=Iv23... \
#   INSTALLER_APP_PRIVATE_KEY="$(cat installer.pem)" \
#     scripts/add-mirror-to-installation.sh pi-gh-identity-guard [pi-other ...]
#   scripts/add-mirror-to-installation.sh --self-test     # JWT logic, no network
#   scripts/add-mirror-to-installation.sh -h | --help
#
# Environment:
#   INSTALLER_APP_CLIENT_ID    Client ID (Iv23...) of the enterprise installer App.
#   INSTALLER_APP_PRIVATE_KEY  PEM private-key contents of the installer App.
#   ENTERPRISE   (default: psmfd)      enterprise slug.
#   ORG          (default: psmfd)      enterprise-owned org that holds the mirrors.
#   INSTALL_ID   (default: 142753672)  the TARGET installation modified (the
#                                      psmfd-mirror-sync App's installation — NOT
#                                      the installer App's own installation).
#
# Exit codes:
#   0 — repo(s) added (or already present)
#   1 — a mint/API step failed
#   2 — environment / precondition failure (missing tools, env, or args)
#
# Per agent/rules/script-output-conventions.md. Installs standalone in CI and
# cannot source scripts/lib, so the output helpers are defined inline.

set -euo pipefail

ENTERPRISE="${ENTERPRISE:-psmfd}"
ORG="${ORG:-psmfd}"
INSTALL_ID="${INSTALL_ID:-142753672}"
API="${GITHUB_API_URL:-https://api.github.com}"
API_VERSION="2022-11-28"

ok()    { printf 'OK    [%s] %s\n' "$1" "$2"; }
skip()  { printf 'SKIP  [%s] %s\n' "$1" "$2"; }
info()  { printf 'INFO  %s\n' "$*"; }
warn()  { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; }
err()   { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }
die()   { err "${1:-add}" "${2:-fatal}"; exit "${3:-1}"; }

need() { command -v "$1" >/dev/null 2>&1 || die preflight "missing required tool: $1" 2; }

# base64url (no padding) of stdin.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# decode base64url from $1 to raw bytes on stdout (re-pads first).
b64url_decode() {
  local s="$1" pad
  pad=$(( (4 - ${#s} % 4) % 4 ))
  case "$pad" in 2) s="${s}==";; 3) s="${s}=";; esac
  printf '%s' "$s" | tr '_-' '/+' | openssl base64 -d -A
}

# make_jwt <issuer-client-id> <pem-contents> : print an RS256 app JWT (9-min TTL).
# The key is fed to openssl via a process-substitution fd, never written to disk.
make_jwt() {
  local iss="$1" pem="$2" now iat exp header payload si sig
  now="$(date +%s)"; iat=$((now - 60)); exp=$((now + 540))
  header='{"alg":"RS256","typ":"JWT"}'
  payload="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$iat" "$exp" "$iss")"
  si="$(printf '%s' "$header" | b64url).$(printf '%s' "$payload" | b64url)"
  sig="$(printf '%s' "$si" | openssl dgst -sha256 -sign <(printf '%s' "$pem") | b64url)" \
    || die jwt "openssl failed to sign the JWT (malformed INSTALLER_APP_PRIVATE_KEY?)"
  printf '%s.%s' "$si" "$sig"
}

# --- network-free self-test: prove the JWT is well-formed and verifies ---------
self_test() {
  need openssl
  info "self-test: RS256 JWT generation + signature verification (no network)"
  local key pub jwt si sig sigf sif fails=0 hdr
  key="$(mktemp)"; pub="$(mktemp)"; sif="$(mktemp)"; sigf="$(mktemp)"
  trap 'rm -f "$key" "$pub" "$sif" "$sigf"' RETURN
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$key" 2>/dev/null \
    || die self-test "could not generate a test RSA key"
  openssl rsa -in "$key" -pubout -out "$pub" 2>/dev/null
  jwt="$(make_jwt "Iv23selftest" "$(cat "$key")")"

  if [ "$(printf '%s' "$jwt" | awk -F. '{print NF}')" = "3" ]; then
    ok self-test "JWT has three segments"
  else err self-test "JWT does not have three segments"; fails=$((fails + 1)); fi

  hdr="$(printf '%s' "${jwt%%.*}" | { read -r p; b64url_decode "$p"; } 2>/dev/null)"
  if printf '%s' "$hdr" | grep -q '"alg":"RS256"'; then
    ok self-test "header decodes to RS256"
  else err self-test "header did not decode to the expected RS256 alg"; fails=$((fails + 1)); fi

  si="${jwt%.*}"; sig="${jwt##*.}"
  printf '%s' "$si" > "$sif"
  b64url_decode "$sig" > "$sigf"
  if openssl dgst -sha256 -verify "$pub" -signature "$sigf" "$sif" >/dev/null 2>&1; then
    ok self-test "signature verifies against the public key"
  else err self-test "signature failed verification"; fails=$((fails + 1)); fi

  if [ "$fails" = 0 ]; then
    printf '==================================\nPASS — 0 errors\n'; exit 0
  else
    printf '==================================\nFAIL — %s error(s)\n' "$fails"; exit 1
  fi
}

# --- main ----------------------------------------------------------------------
case "${1:-}" in
  -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
  --self-test) self_test ;;
  "") die usage "no repositories given; pass one or more bare mirror names (e.g. pi-gh-identity-guard)" 2 ;;
esac

need openssl; need curl; need jq

[ -n "${INSTALLER_APP_CLIENT_ID:-}" ]   || die preflight "INSTALLER_APP_CLIENT_ID is not set" 2
[ -n "${INSTALLER_APP_PRIVATE_KEY:-}" ] || die preflight "INSTALLER_APP_PRIVATE_KEY is not set" 2

# Validate the repo-name arguments (bare names only, never owner/name).
for r in "$@"; do
  case "$r" in
    */*|"") die usage "invalid repository name '$r' — pass a bare name (pi-foo), not owner/name" 2 ;;
  esac
done

info "minting an installer App token (enterprise $ENTERPRISE)"
JWT="$(make_jwt "$INSTALLER_APP_CLIENT_ID" "$INSTALLER_APP_PRIVATE_KEY")"

# Find the installer App's own (enterprise) installation, then exchange for a token.
gh_jwt() { curl -fsS -H "Authorization: Bearer $JWT" -H "Accept: application/vnd.github+json" \
                -H "X-GitHub-Api-Version: $API_VERSION" "$@"; }

INST_JSON="$(gh_jwt "$API/app/installations")" \
  || die mint "GET /app/installations failed (is the installer App's key/client-id correct?)"
INSTALLER_INSTALL_ID="$(printf '%s' "$INST_JSON" \
  | jq -r 'map(select(.target_type=="Enterprise")) | (.[0].id // empty)')"
[ -n "$INSTALLER_INSTALL_ID" ] \
  || die mint "the installer App has no Enterprise installation — install it on the $ENTERPRISE enterprise first"

TOKEN="$(gh_jwt -X POST "$API/app/installations/$INSTALLER_INSTALL_ID/access_tokens" | jq -r '.token // empty')" \
  || die mint "could not exchange the JWT for an installation token"
[ -n "$TOKEN" ] || die mint "installation token response had no .token"
ok mint "minted a short-lived installer token (ghs_, installation $INSTALLER_INSTALL_ID)"

# Add the repo(s) to the target (psmfd-mirror-sync) installation.
BODY="$(jq -nc --args '{repositories: $ARGS.positional}' "$@")"
ENDPOINT="$API/enterprises/$ENTERPRISE/apps/organizations/$ORG/installations/$INSTALL_ID/repositories/add"

if curl -fsS -X PATCH \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: $API_VERSION" \
      "$ENDPOINT" -d "$BODY" >/dev/null; then
  ok add "added to the psmfd-mirror-sync installation ($INSTALL_ID): $*"
else
  die add "PATCH .../repositories/add failed for: $* (token permission, repo name, or installation id?)"
fi

printf '==================================\nPASS — 0 errors\n'
