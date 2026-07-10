#!/usr/bin/env bash
#
# install-expertise.sh — secondary installer that wires local expertise into pi.
#
# Companion to install.sh. Where install.sh installs pi + the config + the
# first-party extensions, THIS script stands up the local expertise backend and
# links it to the pi agent, so `search`/`create` expertise tools are ready to
# use after setup. It uses only PUBLIC packages:
#
#   1. the local agent-expertise-api A2 native service, installed by delegating
#      to the upstream signed installer (psmfd/agent-expertise-api's
#      scripts/install.sh --from-release --install-deps) — launchd on macOS,
#      systemd --user on Debian/Ubuntu;
#   2. the pi-expertise-client extension (psmfd/pi-expertise-client), installed
#      via `pi install` if not already present;
#   3. the code-indexing engine cocoindex-code (`ccc`, PyPI), pinned to the
#      version vendored in agent/vendor/cocoindex-code/, for the `indexing`
#      extension's semantic `search_codebase`.
#
# Linkage: the API is configured for local single-user auth (ASPNETCORE_ENVIRONMENT
# =Development, Auth:Mode=ApiKey) with an API key GENERATED at install time. The
# same key is written into the extension's .env.local so the two are wired with no
# manual step. The key is never echoed to stdout/stderr; both files are mode 600.
# NOTE: do NOT run this installer under shell tracing (`bash -x` / `set -x`) — the
# trace would print the generated key to stderr. A normal run never echoes it.
#
# Per ADR-0067 (this installer). See ADR-0051 (install.sh), ADR-0028
# (expertise-client), ADR-0033 (indexing), ADR-0089 (Debian cosign bootstrap).
#
# SCOPE: macOS (Homebrew) and Debian/Ubuntu (apt), validated on Debian 13 arm64
# 2026-07-03 (#485). Other Linux (RHEL) skips the API stand-up with a pointer to
# agent-expertise-api#247; the extension + indexing still install.
#
# Usage:
#   bash install-expertise.sh [--dir DIR] [--api-dir DIR] [--api-version vX.Y.Z]
#                             [--bind ADDR:PORT] [--ext-ref REF] [--allow-write]
#                             [--rotate-key] [--first-index [PROJECT_DIR]]
#                             [--skip-api] [--skip-indexing] [--dry-run] [-h|--help]
#
# Flags:
#   --dir DIR          pi-config clone (default: resolve ~/.pi, else ~/projects/pi-config).
#   --api-dir DIR      agent-expertise-api clone target (default: ~/projects/agent-expertise-api).
#   --api-version V    Release tag to install (default: latest published release).
#   --bind ADDR:PORT   API bind address (default: 127.0.0.1:8080). Must be loopback.
#   --ext-ref REF      Ref for the pi-expertise-client mirror (default: the EXT_REF pin below).
#   --allow-write      Enable local write/create tools (sets PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1).
#   --rotate-key       Force a new API key even if one already exists (re-wires .env.local).
#   --first-index [D]  After install, run `ccc init && ccc index` in D (default: cwd) to
#                      pull the embedding model now. Omitted by default (model pulls on
#                      first background re-index instead).
#   --skip-api         Do not touch the API service (only ensure extension + indexing).
#   --skip-indexing    Do not install the code-indexing engine.
#   --dry-run          Print every action without executing it.
#   -h | --help        Print this header and exit.
#
# Exit codes:
#   0 — wired (or --dry-run completed)      1 — an error occurred
#   2 — precondition failure (missing tool, bad flag, non-loopback bind)
#
# Per agent/rules/script-output-conventions.md.

set -euo pipefail

# Uses bash arrays — refuse to run under a non-bash shell.
[ -n "${BASH_VERSION:-}" ] || { printf 'ERROR [install-expertise] run with bash: bash install-expertise.sh\n' >&2; exit 2; }

API_REPO="psmfd/agent-expertise-api"
API_URL="https://github.com/${API_REPO}.git"
EXT_MIRROR="psmfd/pi-expertise-client"
EXT_REF="v0.3.1"

DIR=""
API_DIR="${HOME}/projects/agent-expertise-api"
API_VERSION=""
BIND_ADDR="127.0.0.1:8080"
ALLOW_WRITE=0
ROTATE_KEY=0
FIRST_INDEX=0
FIRST_INDEX_DIR=""
SKIP_API=0
SKIP_INDEXING=0
DRY_RUN=0

# --- Output helpers (script-output-conventions; standalone, no shared lib) ---
errors=0
warnings=0
ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
skip() { printf 'SKIP  [%s] %s\n' "$1" "$2"; }
warn() { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; warnings=$((warnings + 1)); }
info() { printf 'INFO  %s\n' "$*"; }
detail(){ [ "${VERBOSE:-0}" = "1" ] && printf '      %s\n' "$*" || true; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }
die()  { err "${1:-install-expertise}" "${2:-fatal}"; exit "${3:-1}"; }
run()  { if [ "$DRY_RUN" = "1" ]; then info "[dry-run] $*"; else "$@"; fi; }

# Temp-file registry + cleanup: any interrupted run (Ctrl-C, disk full, crash)
# must not strand a temp file holding the plaintext generated API key on disk.
# _tmpdirs holds whole scratch directories (cosign bootstrap downloads).
_tmpfiles=()
_tmpdirs=()
cleanup() {
  local f
  for f in "${_tmpfiles[@]:-}"; do [ -n "${f}" ] && rm -f  -- "${f}" 2>/dev/null || true; done
  for f in "${_tmpdirs[@]:-}";  do [ -n "${f}" ] && rm -rf -- "${f}" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM
# mktemp in the TARGET directory (so the later mv is an atomic same-filesystem
# rename) with mode 0600; register it for cleanup. Echoes the temp path.
mktemp_secure() { local t; t="$(mktemp "${1}.XXXXXX")" || die tmp "mktemp failed for ${1}"; _tmpfiles+=("${t}"); printf '%s' "${t}"; }

# require the flag's value argument or fail with the documented exit code (2).
req() { [ "$1" -ge 2 ] || die args "${2} requires a value" 2; }

# --- cosign >= 3 verified bootstrap (Debian/Ubuntu; ADR-0089) ----------------
# Upstream v1.4.1 moved release signing to the Sigstore bundle format and
# raised verify-release.sh's floor to cosign >= 3.0.0, but Debian 13's apt
# archive ships cosign 2.5.0 (trixie-backports has none; 3.x is only in
# sid/forky), so a fresh upstream --install-deps run self-breaks
# (agent-expertise-api#402). Bootstrap: "old cosign verifies new cosign" —
# the apt cosign (trusted via Debian's archive signature chain) keylessly
# verifies the pinned 3.x release's signed checksums manifest (Fulcio cert
# identity + Rekor transparency-log inclusion; 2.5.x parses the v3 bundles,
# confirmed with negative controls), the binary is sha256-checked against
# that verified manifest, and the result lands in /usr/local/bin — which
# upstream's _debian_ensure_cosign honors (on PATH, not dpkg-managed) and
# leaves alone. Fail-closed: ANY verification failure dies; this never falls
# back to an unverified binary. Exact-version pin per house style (cf.
# EXT_REF); staleness is watched by pin-drift automation (pi_config#646).
# v3.0.0 was never published and v3.0.1 shipped without artifact-key
# signatures — never pin below v3.0.2.
COSIGN_PIN_VERSION="v3.1.1"
# cosign's release CI signs as this GCP identity (docs.sigstore.dev) — NOT a
# GitHub Actions identity. Exact match on purpose: if sigstore ever rotates
# it, the bootstrap breaks loudly and the pin gets reviewed, never silently
# bypassed.
COSIGN_RELEASE_IDENTITY="keyless@projectsigstore.iam.gserviceaccount.com"
COSIGN_RELEASE_OIDC_ISSUER="https://accounts.google.com"

# Run "$@" as root: directly when already root, else via sudo.
_as_root() { if [ "$(id -u)" = "0" ]; then "$@"; else sudo "$@"; fi; }

_ensure_cosign_ge3() {
  local have_ver="" have_major=0
  if command -v cosign >/dev/null 2>&1; then
    have_ver="$(cosign version 2>/dev/null | awk -F': *' '/GitVersion/{print $2; exit}')"
    have_major="${have_ver#v}"; have_major="${have_major%%.*}"
    case "${have_major}" in ''|*[!0-9]*) have_major=0 ;; esac
    if [ "${have_major}" -ge 3 ]; then
      ok cosign "cosign ${have_ver} already meets the upstream >= 3.0.0 verify floor"
      return 0
    fi
  fi
  info "cosign ${have_ver:-<absent>} is below upstream's 3.0.0 verify floor; bootstrapping ${COSIGN_PIN_VERSION} (verified)"
  if [ "${DRY_RUN}" = "1" ]; then
    info "[dry-run] apt-get install cosign (bootstrap verifier), verify ${COSIGN_PIN_VERSION} checksums via Sigstore bundle, sha256-check the binary, install to /usr/local/bin/cosign"
    return 0
  fi

  # The apt cosign is the VERIFIER for the new one, not the target.
  if ! command -v cosign >/dev/null 2>&1; then
    _as_root apt-get update -qq || die cosign "apt-get update failed" 2
    _as_root apt-get install -y -qq cosign \
      || die cosign "apt-get install cosign failed — the Debian-archive cosign is required as the bootstrap verifier" 2
    command -v cosign >/dev/null 2>&1 || die cosign "apt-get install cosign produced no cosign on PATH" 2
  fi

  local arch asset base tmpd
  arch="$(dpkg --print-architecture 2>/dev/null || true)"
  case "${arch}" in
    amd64|arm64) : ;;
    *) case "$(uname -m)" in
         x86_64)        arch="amd64" ;;
         aarch64|arm64) arch="arm64" ;;
         *) die cosign "unsupported CPU architecture for the cosign bootstrap: $(uname -m)" 2 ;;
       esac ;;
  esac
  asset="cosign-linux-${arch}"
  base="https://github.com/sigstore/cosign/releases/download/${COSIGN_PIN_VERSION}"
  tmpd="$(mktemp -d)" || die cosign "mktemp -d failed" 1
  _tmpdirs+=("${tmpd}")

  curl -fsSL --retry 3 -o "${tmpd}/${asset}" "${base}/${asset}" \
    || die cosign "download failed: ${base}/${asset}" 1
  curl -fsSL --retry 3 -o "${tmpd}/cosign_checksums.txt" "${base}/cosign_checksums.txt" \
    || die cosign "download failed: ${base}/cosign_checksums.txt" 1
  curl -fsSL --retry 3 -o "${tmpd}/cosign_checksums.txt.sigstore.json" "${base}/cosign_checksums.txt.sigstore.json" \
    || die cosign "download failed: ${base}/cosign_checksums.txt.sigstore.json" 1

  # Keyless verify of the checksums manifest. Fulcio identity and Rekor
  # inclusion are checked by default — never pass --insecure-ignore-* here.
  # A network MITM can withhold these files (we die), but cannot forge them.
  cosign verify-blob \
      --bundle "${tmpd}/cosign_checksums.txt.sigstore.json" \
      --certificate-identity "${COSIGN_RELEASE_IDENTITY}" \
      --certificate-oidc-issuer "${COSIGN_RELEASE_OIDC_ISSUER}" \
      "${tmpd}/cosign_checksums.txt" >/dev/null 2>&1 \
    || die cosign "signature verification FAILED for ${COSIGN_PIN_VERSION}'s checksums manifest — refusing to install an unverified cosign" 2

  # sha256-check the binary against the NOW-VERIFIED manifest (never against
  # an unverified checksums file).
  local want_line
  want_line="$(grep -E "[[:space:]]${asset}\$" "${tmpd}/cosign_checksums.txt" | head -1 || true)"
  [ -n "${want_line}" ] || die cosign "no entry for ${asset} in the verified checksums manifest" 2
  ( cd "${tmpd}" && printf '%s\n' "${want_line}" | sha256sum --check --strict - >/dev/null ) \
    || die cosign "sha256 mismatch for ${asset} — refusing to install" 2

  _as_root install -m 0755 "${tmpd}/${asset}" /usr/local/bin/cosign \
    || die cosign "failed to install /usr/local/bin/cosign" 1
  hash -r 2>/dev/null || true
  have_ver="$(cosign version 2>/dev/null | awk -F': *' '/GitVersion/{print $2; exit}')"
  have_major="${have_ver#v}"; have_major="${have_major%%.*}"
  case "${have_major}" in ''|*[!0-9]*) have_major=0 ;; esac
  if [ "${have_major}" -ge 3 ]; then
    ok cosign "installed verified cosign ${have_ver} to /usr/local/bin (upstream's apt bootstrap honors it)"
  else
    die cosign "/usr/local/bin/cosign installed but PATH still resolves ${have_ver:-nothing} — ensure /usr/local/bin precedes /usr/bin in PATH" 1
  fi
}

# --- Flags -----------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          req $# --dir;         DIR="$2"; shift 2 ;;
    --api-dir)      req $# --api-dir;      API_DIR="$2"; shift 2 ;;
    --api-version)  req $# --api-version;  API_VERSION="$2"; shift 2 ;;
    --bind)         req $# --bind;         BIND_ADDR="$2"; shift 2 ;;
    --ext-ref)      req $# --ext-ref;      EXT_REF="$2"; shift 2 ;;
    --allow-write)  ALLOW_WRITE=1; shift ;;
    --rotate-key)   ROTATE_KEY=1; shift ;;
    --first-index)  FIRST_INDEX=1
                    # Optional path argument (only if the next token is not a flag).
                    if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then FIRST_INDEX_DIR="$2"; shift 2; else shift; fi ;;
    --skip-api)     SKIP_API=1; shift ;;
    --skip-indexing) SKIP_INDEXING=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      sed -nE '/^# /{s/^# ?//;p;};/^$/q' "$0"; exit 0 ;;
    *)              die args "unknown flag: $1" 2 ;;
  esac
done

# --- Preflight -------------------------------------------------------------
command -v git  >/dev/null 2>&1 || die deps "git not found in PATH; install git first" 2
command -v curl >/dev/null 2>&1 || die deps "curl not found in PATH; install curl first" 2

# The bind address must be loopback with a numeric port. This is the LOAD-BEARING
# control (ADR-0067): the API is downgraded to Development + Auth:Mode=ApiKey, which
# is only safe because it is reachable on loopback alone. The check must be strict,
# NOT a prefix glob: a hostname that merely starts with "127." (e.g.
# 127.0.0.1.attacker.tld) is treated by Kestrel/ASP.NET Core as a non-literal host
# and bound as a wildcard across ALL interfaces — so accept only a real loopback
# literal. The extension enforces the same loopback rule at load (ADR-0028).
case "${BIND_ADDR}" in
  *:*) : ;;
  *) die bind "--bind must be ADDR:PORT (e.g. 127.0.0.1:8080); got '${BIND_ADDR}'" 2 ;;
esac
bind_host="${BIND_ADDR%:*}"
bind_port="${BIND_ADDR##*:}"
bind_host_bare="${bind_host#[}"; bind_host_bare="${bind_host_bare%]}"   # strip [] from IPv6 literal
case "${bind_host_bare}" in
  localhost|::1) : ;;
  *) # strict 127.0.0.0/8 with numeric 0-255 octets (rejects 127.x.y.z.dnslabel)
    printf '%s' "${bind_host_bare}" | grep -qE '^127\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$' \
      || die bind "--bind host must be a loopback literal (127.0.0.0/8, localhost, or ::1); got '${bind_host}'" 2 ;;
esac
case "${bind_port}" in
  ''|*[!0-9]*) die bind "--bind port must be numeric; got '${bind_port:-<empty>}'" 2 ;;
esac

# Resolve the pi-config clone (for agent/vendor/, ~/.pi, and the extension path).
# Precedence: --dir > ~/.pi symlink target > default.
if [ -z "${DIR}" ]; then
  if [ -L "${HOME}/.pi" ]; then
    DIR="$(cd -P "${HOME}/.pi" 2>/dev/null && pwd)" || DIR=""
  fi
  [ -z "${DIR}" ] && DIR="${HOME}/projects/pi-config"
fi
[ -d "${DIR}" ] || warn dir "pi-config clone not found at ${DIR} (pass --dir); vendored pins may be unavailable"

# Detect a dev-host checkout: ~/.pi symlinked into a repo that ships the
# expertise-client extension in-repo (agent/extensions/expertise-client/) —
# true only for the private monorepo; the public mirror excludes this path
# (see mirror/targets.yml). Reuses the same ~/.pi symlink-resolution idiom as
# the DIR block above rather than inventing a second detection mechanism.
REPO_EXT_DIR=""
if [ -L "${HOME}/.pi" ]; then
  pi_link_target="$(cd -P "${HOME}/.pi" 2>/dev/null && pwd)" || pi_link_target=""
  if [ -n "${pi_link_target}" ] && [ -d "${pi_link_target}/agent/extensions/expertise-client" ]; then
    REPO_EXT_DIR="${pi_link_target}/agent/extensions/expertise-client"
  fi
fi

# Installed git extensions live at ~/.pi/agent/git/<host>/<owner>/<repo> (pi
# docs packages.md). EXT_DIR is the SINGLE source of truth for where the
# extension linkage (.env.local, step 4) is wired: it prefers the repo-shipped
# copy over the git-install path whenever both exist. Without this precedence,
# pi loads the repo-shipped copy (it wins the load race via the ~/.pi symlink)
# while step 4 would wire .env.local into the git-install copy nobody reads —
# leaving the winning copy unauthenticated (pi_config#529).
GIT_EXT_DIR="${HOME}/.pi/agent/git/github.com/${EXT_MIRROR}"
if [ -n "${REPO_EXT_DIR}" ]; then
  EXT_DIR="${REPO_EXT_DIR}"
else
  EXT_DIR="${GIT_EXT_DIR}"
fi

# pi must be installed already (run install.sh first). Make ~/.local/bin visible.
export PATH="${HOME}/.local/bin:${PATH}"
if ! command -v pi >/dev/null 2>&1 && [ "${DRY_RUN}" != "1" ]; then
  die pi "pi not found in PATH. Run install.sh first (it installs pi + the config), then re-run this script." 2
fi

IS_MACOS=0
[ "$(uname -s)" = "Darwin" ] && IS_MACOS=1

info "Wiring local expertise for pi (bind ${BIND_ADDR})"

# --- 1. Ensure the expertise-client extension is installed -----------------
# The extension resolves .env.local relative to its own module, so EXT_DIR
# (resolved above) is where the linkage file must land.
if [ -n "${REPO_EXT_DIR}" ] && [ -d "${GIT_EXT_DIR}" ]; then
  # Already-broken dev-host state (pi_config#529): both copies present. pi
  # loads the repo-shipped copy; the git-install copy is a dead duplicate that
  # fails to load ("Tool \"expertise_search\" conflicts...") and its .env.local
  # (if any) is never read. Point at remediation rather than silently fixing —
  # removing an installed extension out from under the operator is not this
  # script's call to make.
  warn extension "both a repo-shipped copy (${REPO_EXT_DIR}) and a git-install copy (${GIT_EXT_DIR}) of expertise-client are present; pi loads the repo-shipped copy, so the git-install copy is a dead duplicate — remove it: pi remove git:github.com/${EXT_MIRROR}"
elif [ -n "${REPO_EXT_DIR}" ]; then
  skip extension "expertise-client already active via the repo-shipped copy (${REPO_EXT_DIR}, via the ~/.pi symlink); not installing a second global copy — see pi_config#529"
elif [ -d "${GIT_EXT_DIR}" ]; then
  ok extension "pi-expertise-client already installed (${EXT_DIR})"
else
  info "Installing pi-expertise-client extension"
  if ! run pi install "git:github.com/${EXT_MIRROR}@${EXT_REF}"; then
    die extension "pi install ${EXT_MIRROR} failed; install it, then re-run"
  fi
fi

# --- 2. Stand up the local agent-expertise-api service (delegated) ---------
# The upstream installer resolves CONFIG_DIR per-OS: macOS uses
# ~/Library/Application Support/expertise-api; Linux uses XDG
# ${XDG_CONFIG_HOME:-~/.config}/expertise-api. Match it so the managed auth
# block lands in the file the service actually sources. macOS delegates
# --install-deps to Homebrew; Debian/Ubuntu to apt (agent-expertise-api#246,
# validated on Debian 13 2026-07-03 — closes pi_config#485).
if [ "${IS_MACOS}" = "1" ]; then
  API_CONFIG_DIR="${HOME}/Library/Application Support/expertise-api"
else
  API_CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/expertise-api"
fi
SECRETS_FILE="${API_CONFIG_DIR}/secrets.env"

if [ "${SKIP_API}" = "1" ]; then
  skip api "--skip-api set; not touching the expertise-api service"
  [ "${ROTATE_KEY}" = "1" ] && warn api "--rotate-key has no effect with --skip-api (the linkage step is skipped)" || true
elif [ "${IS_MACOS}" != "1" ] && ! command -v apt-get >/dev/null 2>&1; then
  # The upstream --install-deps Linux bootstrap is apt-based (Debian/Ubuntu,
  # #246); RHEL parity is tracked upstream by #247.
  skip api "non-apt Linux host — the delegated --install-deps path currently supports macOS (Homebrew) and Debian/Ubuntu (apt). See agent-expertise-api#247 for RHEL."
  warn api "the extension is installed but has no local API to talk to yet on this platform"
else
  # Homebrew is only needed for the REAL macOS --install-deps run; Debian uses
  # apt (no brew). Under --dry-run nothing brew-related executes, so warn
  # (don't die) to keep dry-run usable without brew.
  if [ "${IS_MACOS}" = "1" ] && ! command -v brew >/dev/null 2>&1; then
    if [ "${DRY_RUN}" = "1" ]; then
      warn deps "Homebrew (brew) not found; a real run needs it for the macOS --install-deps path"
    else
      die deps "Homebrew (brew) is required for the macOS --install-deps path; install it from https://brew.sh and re-run" 2
    fi
  fi

  # Debian/Ubuntu: satisfy upstream's cosign >= 3.0.0 verify floor BEFORE
  # delegating — upstream's own apt bootstrap can only install 2.5.0
  # (agent-expertise-api#402; ADR-0089). macOS is covered by Homebrew's
  # cosign formula, which upstream's bootstrap installs/upgrades itself.
  if [ "${IS_MACOS}" != "1" ]; then
    _ensure_cosign_ge3
  fi

  # Resolve the release tag. --from-release needs a concrete vX.Y.Z on first
  # install; default to the latest published release via the public GitHub API.
  if [ -z "${API_VERSION}" ]; then
    info "Resolving latest ${API_REPO} release"
    API_VERSION="$(curl -fsSL "https://api.github.com/repos/${API_REPO}/releases/latest" 2>/dev/null \
      | grep -oE '"tag_name":[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')" || true
    [ -n "${API_VERSION}" ] || die api "could not resolve latest release tag; pass --api-version vX.Y.Z" 2
    info "Latest release: ${API_VERSION}"
  fi

  # Clone or update the API repo at the pinned tag (its scripts drive the install).
  if [ -d "${API_DIR}/.git" ]; then
    origin="$(git -C "${API_DIR}" remote get-url origin 2>/dev/null || echo '')"
    case "${origin}" in
      *github.com[:/]"${API_REPO}"|*github.com[:/]"${API_REPO}".git)
        run git -C "${API_DIR}" fetch --depth 1 origin "${API_VERSION}"
        run git -C "${API_DIR}" reset --hard FETCH_HEAD ;;
      *) die api "${API_DIR} is a git repo but its origin is not github.com/${API_REPO} (${origin:-none}); pass --api-dir" 2 ;;
    esac
  elif [ -e "${API_DIR}" ]; then
    die api "${API_DIR} exists and is not a ${API_REPO} checkout; pass --api-dir" 2
  else
    run mkdir -p "$(dirname "${API_DIR}")"
    run git clone --depth 1 --branch "${API_VERSION}" "${API_URL}" "${API_DIR}"
  fi

  # --- 3. Linkage: local ApiKey auth with a generated key ------------------
  # The API defaults to Auth:Mode=Oidc, which needs an IdP. For a single-user
  # local install we override to Development + ApiKey via a MANAGED block in
  # secrets.env. This block MUST be seeded BEFORE delegating to the upstream
  # installer (validated live 2026-07-03): upstream's install runs migrate.sh,
  # which boots the full host and aborts on the Auth:Mode=Oidc issuer guard if
  # the override is not yet in place — and launchd's first kickstart sources the
  # same file, so pre-seeding also means the service comes up healthy with no
  # crash-loop window and the key never transits any process environment.
  # Upstream preserves an existing secrets.env (its stub step skips) and appends
  # the generated connection string to it only if absent, so pre-seeding is safe.
  BEGIN='# >>> pi_config expertise linkage (install-expertise.sh) >>>'
  END='# <<< pi_config expertise linkage <<<'

  api_key=""
  if [ "${DRY_RUN}" != "1" ] && [ -f "${SECRETS_FILE}" ] && [ "${ROTATE_KEY}" != "1" ]; then
    # Reuse an existing key so the extension stays wired across re-runs. Read it
    # ONLY from inside our managed block, so a stray hand-edited Auth__ApiKey= line
    # elsewhere cannot be mistaken for the effective key.
    api_key="$(awk -v b="${BEGIN}" -v e="${END}" '
      $0==b {inb=1; next} $0==e {inb=0}
      inb && /^Auth__ApiKey=/ { v=$0; sub(/^Auth__ApiKey=/,"",v); gsub(/^"|"$/,"",v); print v; exit }
    ' "${SECRETS_FILE}" 2>/dev/null)" || true
  fi
  if [ -z "${api_key}" ]; then
    if [ "${DRY_RUN}" = "1" ]; then
      api_key="DRYRUN_PLACEHOLDER_KEY"
    else
      # 32 random bytes, hex — no shell-special chars, safe in secrets.env and headers.
      api_key="$(openssl rand -hex 32)" || die linkage "openssl rand failed; is openssl installed?"
    fi
  fi

  if [ "${DRY_RUN}" = "1" ]; then
    info "[dry-run] write managed auth block (Development + Auth__Mode=ApiKey + generated key) to ${SECRETS_FILE}"
  else
    # First run: the file does not exist yet (upstream creates its stub later
    # and preserves ours). Create the dir/file with tight modes.
    mkdir -p "${API_CONFIG_DIR}" || die linkage "failed to create ${API_CONFIG_DIR}"
    chmod 700 "${API_CONFIG_DIR}" 2>/dev/null || true
    [ -f "${SECRETS_FILE}" ] || { : > "${SECRETS_FILE}" && chmod 600 "${SECRETS_FILE}"; } \
      || die linkage "failed to create ${SECRETS_FILE}"
    tmp="$(mktemp_secure "${SECRETS_FILE}")"   # mode 0600, registered for cleanup
    # Strip any prior managed block, then append a fresh one.
    awk -v b="${BEGIN}" -v e="${END}" '
      $0==b {skip=1} skip==1 && $0==e {skip=0; next} skip!=1 {print}
    ' "${SECRETS_FILE}" > "${tmp}" || die linkage "failed to stage ${SECRETS_FILE}"
    {
      printf '%s\n' "${BEGIN}"
      printf 'ASPNETCORE_ENVIRONMENT=Development\n'
      printf 'Auth__Mode=ApiKey\n'
      printf 'Auth__ApiKey="%s"\n' "${api_key}"
      # ONNX model paths — pinned ONLY on macOS. Upstream migrate.sh derives
      # these from a Linux-only PREFIX (~/.local/share) default, so on macOS
      # IEmbeddingGenerator silently never registers — latent in Production but
      # fatal under the Development environment this block sets (eager DI
      # validation / ValidateOnBuild). On Linux that same PREFIX default is the
      # CORRECT location (validated on Debian 13 2026-07-03: the model loads and
      # semantic search runs), so pinning here to CONFIG_DIR/models would point
      # the service at the wrong path — omit it and let the default stand.
      # Values are double-quoted: the macOS path contains a space and the file
      # is bash-sourced.
      if [ "${IS_MACOS}" = "1" ]; then
        printf 'Onnx__ModelPath="%s/models/model.onnx"\n' "${API_CONFIG_DIR}"
        printf 'Onnx__VocabPath="%s/models/vocab.txt"\n' "${API_CONFIG_DIR}"
      fi
      printf '%s\n' "${END}"
    } >> "${tmp}" || die linkage "failed to write auth block to ${SECRETS_FILE}"
    chmod 600 "${tmp}"
    mv -f -- "${tmp}" "${SECRETS_FILE}" || die linkage "failed to update ${SECRETS_FILE}"
    ok linkage "configured local ApiKey auth in secrets.env (key not shown)"
  fi

  # Delegate to the upstream signed installer. --install-deps bootstraps .NET 10,
  # PostgreSQL 17, pgvector and the expertise role/DB via Homebrew, and appends the
  # generated connection string to secrets.env (mode 600, preserved — see above).
  # --from-release verifies the cosign-signed portable tarball.
  info "Installing the agent-expertise-api service (${API_VERSION}) via upstream installer"
  if [ "${DRY_RUN}" = "1" ]; then
    info "[dry-run] (cd '${API_DIR}' && scripts/install.sh --from-release --version '${API_VERSION}' --install-deps --bind '${BIND_ADDR}')"
  else
    if ! ( cd "${API_DIR}" && scripts/install.sh --from-release --version "${API_VERSION}" --install-deps --bind "${BIND_ADDR}" ); then
      die api "upstream scripts/install.sh failed (see its ERROR lines above)"
    fi
  fi

  # Restart to be certain the running service reflects secrets.env, and as a
  # health gate: apictl blocks until /health/ready.
  info "Restarting the service (health-gating on /health/ready)"
  if [ "${DRY_RUN}" = "1" ]; then
    info "[dry-run] EXPERTISE_API_URL=http://${BIND_ADDR} ${API_DIR}/scripts/expertise-apictl restart"
  else
    [ -x "${API_DIR}/scripts/expertise-apictl" ] || die api "control wrapper missing/not executable at ${API_DIR}/scripts/expertise-apictl (did the upstream install complete?)"
    if ! EXPERTISE_API_URL="http://${BIND_ADDR}" "${API_DIR}/scripts/expertise-apictl" restart; then
      die api "service failed to become healthy after restart; check: ${API_DIR}/scripts/expertise-apictl status"
    fi
    ok api "expertise-api healthy at http://${BIND_ADDR}"
  fi

  # --- 4. Wire the extension's .env.local ----------------------------------
  ENV_LOCAL="${EXT_DIR}/.env.local"
  if [ "${DRY_RUN}" = "1" ]; then
    info "[dry-run] write ${ENV_LOCAL} (base URL + generated key + write toggle, mode 600)"
  elif [ ! -d "${EXT_DIR}" ]; then
    warn linkage "extension dir ${EXT_DIR} not found; cannot write .env.local. Re-run after the extension installs."
  else
    tmp="$(mktemp_secure "${ENV_LOCAL}")"   # mode 0600, registered for cleanup
    {
      printf '# Written by install-expertise.sh (ADR-0067). Do NOT commit. mode 600.\n'
      printf 'PI_EXPERTISE_API_BASE_URL=http://%s\n' "${BIND_ADDR}"
      printf 'PI_EXPERTISE_API_KEY=%s\n' "${api_key}"
      printf 'PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=%s\n' "${ALLOW_WRITE}"
    } > "${tmp}" || die linkage "failed to write ${ENV_LOCAL}"
    chmod 600 "${tmp}"
    mv -f -- "${tmp}" "${ENV_LOCAL}" || die linkage "failed to update ${ENV_LOCAL}"
    ok linkage "wired extension .env.local -> http://${BIND_ADDR} (write=${ALLOW_WRITE})"
  fi
fi

# --- 5. Code-indexing engine (cocoindex-code / ccc) ------------------------
if [ "${SKIP_INDEXING}" = "1" ]; then
  skip indexing "--skip-indexing set; not installing the code-indexing engine"
else
  # Pin to the version vendored in the pi-config clone (single source of truth,
  # mirrored under agent/vendor/cocoindex-code/); fall back to the known-good pin.
  CCC_VERSION="0.2.35"
  if [ -f "${DIR}/agent/vendor/cocoindex-code/VERSION" ]; then
    CCC_VERSION="$(tr -d '[:space:]' < "${DIR}/agent/vendor/cocoindex-code/VERSION")"
  fi

  # cocoindex-code needs Python >= 3.11. Prefer an existing new-enough python3.
  PY=""
  for cand in python3.13 python3.12 python3.11 python3; do
    if command -v "${cand}" >/dev/null 2>&1; then
      if "${cand}" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,11) else 1)' 2>/dev/null; then
        PY="${cand}"; break
      fi
    fi
  done
  if [ -z "${PY}" ]; then
    # Package-manager presence is checked before use so a non-apt Linux (RHEL)
    # or a mac without Homebrew gets a clean die() with guidance, not a raw
    # `command not found` crash under `set -euo pipefail` (this branch is
    # reachable independently of the API stand-up via --skip-api).
    if [ "${IS_MACOS}" = "1" ]; then
      if ! command -v brew >/dev/null 2>&1 && [ "${DRY_RUN}" != "1" ]; then
        die indexing "Homebrew required to install Python for the indexing engine; install it from https://brew.sh, or pass --skip-indexing"
      fi
      info "Installing Python 3.13 (Homebrew) for the indexing engine"
      run brew install python@3.13
      command -v python3.13 >/dev/null 2>&1 && PY="python3.13"
    elif command -v apt-get >/dev/null 2>&1; then
      # Debian/Ubuntu ships python3 (3.13 on trixie) in its own repos.
      info "Installing python3 (apt) for the indexing engine"
      run sudo apt-get update -qq
      run sudo apt-get install -y -qq python3
      command -v python3 >/dev/null 2>&1 && PY="python3"
    else
      die indexing "no python >=3.11 found and no supported package manager (brew/apt) to install one on this host; install Python >=3.11, or pass --skip-indexing"
    fi
    [ -z "${PY}" ] && [ "${DRY_RUN}" != "1" ] && die indexing "python >=3.11 still not available after install"
    [ -z "${PY}" ] && PY="python3"
  fi

  # pipx installs the CLI into an isolated venv on PATH.
  if ! command -v pipx >/dev/null 2>&1; then
    if [ "${IS_MACOS}" = "1" ]; then
      if ! command -v brew >/dev/null 2>&1 && [ "${DRY_RUN}" != "1" ]; then
        die indexing "Homebrew required to install pipx; install it from https://brew.sh, or pass --skip-indexing"
      fi
      info "Installing pipx (Homebrew)"
      run brew install pipx
    elif command -v apt-get >/dev/null 2>&1; then
      info "Installing pipx (apt)"
      run sudo apt-get update -qq
      run sudo apt-get install -y -qq pipx
    else
      die indexing "no pipx and no supported package manager (brew/apt) to install it on this host; install pipx, or pass --skip-indexing"
    fi
    run pipx ensurepath
  fi

  info "Installing cocoindex-code[full]==${CCC_VERSION} (local embeddings, no cloud key)"
  if ! run pipx install --python "${PY}" "cocoindex-code[full]==${CCC_VERSION}"; then
    warn indexing "pipx install cocoindex-code failed; retry: pipx install --python ${PY} 'cocoindex-code[full]==${CCC_VERSION}'"
  fi

  if [ "${DRY_RUN}" != "1" ] && command -v ccc >/dev/null 2>&1; then
    # ccc has no version flag; pipx metadata is the installed-version truth.
    ccc_ver="$(pipx list --short 2>/dev/null | awk '$1=="cocoindex-code"{print $2}')"
    ok indexing "ccc installed (cocoindex-code ${ccc_ver:-version unknown})"
  fi

  # Optional: pull the ~90 MB embedding model now by building a first index.
  if [ "${FIRST_INDEX}" = "1" ]; then
    idx_dir="${FIRST_INDEX_DIR:-$(pwd)}"
    info "Building first index in ${idx_dir} (pulls the embedding model, ~90 MB one-time)"
    if [ "${DRY_RUN}" = "1" ]; then
      info "[dry-run] (cd '${idx_dir}' && ccc init && ccc index)"
    else
      ( cd "${idx_dir}" && ccc init && ccc index ) || warn indexing "first index failed; run 'ccc init && ccc index' in your project later"
    fi
  fi
fi

# --- Summary + next steps --------------------------------------------------
echo
info "Expertise wiring complete."
echo "Next steps:"
# The API stand-up runs on macOS (brew) and apt-based Linux (#500); show the
# service hints whenever it actually ran, not on macOS only.
if [ "${SKIP_API}" != "1" ] && { [ "${IS_MACOS}" = "1" ] || command -v apt-get >/dev/null 2>&1; }; then
  echo "  * Manage the service: ${API_DIR}/scripts/expertise-apictl {status|restart|stop}"
  echo "  * The generated API key lives in ${SECRETS_FILE} and the extension's .env.local (mode 600)."
fi
if [ "${SKIP_INDEXING}" != "1" ] && [ "${FIRST_INDEX}" != "1" ]; then
  echo "  * Pull the indexing model when ready: run 'ccc init && ccc index' in a project,"
  echo "    or start pi with --index (the background re-index pulls the model on first run)."
fi
echo "  * Run: pi   — the expertise search/create tools and search_codebase are now available."
echo

echo "=================================="
if [ "${errors}" -gt 0 ]; then
  echo "FAIL — ${errors} errors, ${warnings} warnings"
  exit 1
fi
echo "PASS — ${errors} errors, ${warnings} warnings"
