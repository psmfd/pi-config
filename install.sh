#!/usr/bin/env bash
#
# install.sh — one-shot installer for the pi_config orchestration setup.
#
# Send this file to anyone; they save it and run `bash install.sh`. It:
#   1. clones the public distribution mirror (psmfd/pi-config),
#   2. runs its setup.sh (installs pi + the developer toolchain, seeds a generic
#      config from the *.example.json templates, and symlinks ~/.pi to the clone),
#   3. installs the first-party pi extensions from their own public mirrors
#      (psmfd/pi-<name>) via `pi install` — so they are not carried in the clone
#      and never double-load.
#
# The mirror ships GENERIC config only — none of the upstream maintainer's
# personalizations (provider/model/theme, identity pins) travel. Pass
# --owner/--repo/--gh-login to also personalize the clone for your own fork.
#
# Per ADR-0051 (this installer) and ADR-0050 (the verified mirror it consumes).
#
# Usage:
#   bash install.sh [--dir DIR] [--ref REF] [--skip-extensions]
#                   [--owner X --repo Y --gh-login Z] [--dry-run] [-h|--help]
#
# Flags:
#   --dir DIR          Clone target (default: ~/projects/pi-config).
#   --ref REF          Branch or tag to install (default: main). Release-tag
#                      pinning will replace this default once the mirror cuts
#                      releases (tracked as a follow-up).
#   --ext-ref REF      Tag/ref for the extension mirrors (default: v0.1.0).
#   --skip-extensions  Do not `pi install` the first-party extension mirrors.
#   --owner/--repo/--gh-login
#                      Passed to scripts/personalize.sh --init (for redistributors
#                      who will host their own fork). Omit for a plain install.
#   --dry-run          Print every action without executing it.
#   -h | --help        Print this header and exit.
#
# Environment: PI_* variables (PI_CONFIG_SKIP_DEPS, PI_USE_VENDORED, PI_ALLOW_SUDO_APT,
# ...) pass through to setup.sh unchanged. See the mirror's README for the full list.
#
# Exit codes:
#   0 — installed (or --dry-run completed)
#   1 — an error occurred
#   2 — precondition failure (missing git, bad --dir)
#
# Per agent/rules/script-output-conventions.md.

set -euo pipefail

# Uses bash arrays — refuse to run under a non-bash shell (e.g. `sh install.sh`).
[ -n "${BASH_VERSION:-}" ] || { printf 'ERROR [install] run with bash: bash install.sh\n' >&2; exit 2; }

MIRROR_OWNER="psmfd"
MIRROR_REPO="${MIRROR_OWNER}/pi-config"
MIRROR_URL="https://github.com/${MIRROR_REPO}.git"
EXT_REF="v0.1.0"
EXT_MIRRORS=(pi-secrets-guard pi-bash-destructive-guard pi-artifact-handoff pi-web-fetch pi-cache-meter)

DIR="${HOME}/projects/pi-config"
REF="main"
SKIP_EXT=0
DRY_RUN=0
OWNER=""; REPO=""; GH_LOGIN=""

# --- Output helpers (script-output-conventions; standalone, no shared lib) ---
errors=0
warnings=0
ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
skip() { printf 'SKIP  [%s] %s\n' "$1" "$2"; }
warn() { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; warnings=$((warnings + 1)); }
info() { printf 'INFO  %s\n' "$*"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }
die()  { err "${1:-install}" "${2:-fatal}"; exit "${3:-1}"; }
# run: execute, or just print under --dry-run.
run()  { if [ "$DRY_RUN" = "1" ]; then info "[dry-run] $*"; else "$@"; fi; }

# --- Flags -----------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)             DIR="${2:?--dir requires a path}"; shift 2 ;;
    --ref)             REF="${2:?--ref requires a value}"; shift 2 ;;
    --ext-ref)         EXT_REF="${2:?--ext-ref requires a value}"; shift 2 ;;
    --skip-extensions) SKIP_EXT=1; shift ;;
    --owner)           OWNER="${2:?--owner requires a value}"; shift 2 ;;
    --repo)            REPO="${2:?--repo requires a value}"; shift 2 ;;
    --gh-login)        GH_LOGIN="${2:?--gh-login requires a value}"; shift 2 ;;
    --dry-run)         DRY_RUN=1; shift ;;
    -h|--help)         sed -nE '/^# /{s/^# ?//;p;};/^$/q' "$0"; exit 0 ;;
    *)                 die args "unknown flag: $1" 2 ;;
  esac
done

command -v git >/dev/null 2>&1 || die deps "git not found in PATH; install git first" 2

# --- 1. Clone or update the mirror -----------------------------------------
info "Installing pi_config from ${MIRROR_REPO} (ref: ${REF}) into ${DIR}"
if [ -d "${DIR}/.git" ]; then
  origin="$(git -C "${DIR}" remote get-url origin 2>/dev/null || echo '')"
  # Host- AND end-anchored: only a real github.com/<MIRROR_REPO> checkout matches
  # (not a lookalike like .../pi-config-evil, nor another host's matching path).
  case "${origin}" in
    *github.com[:/]"${MIRROR_REPO}"|*github.com[:/]"${MIRROR_REPO}".git)
      # fetch + reset is robust for BOTH a branch and a tag ref (a tag checkout
      # would otherwise leave a detached HEAD that `pull --ff-only` rejects).
      run git -C "${DIR}" fetch --depth 1 origin "${REF}"
      run git -C "${DIR}" reset --hard FETCH_HEAD
      [ "${DRY_RUN}" = "1" ] || ok clone "updated existing checkout at ${DIR}"
      ;;
    *)
      die clone "${DIR} is a git repo but its origin is not github.com/${MIRROR_REPO} (${origin:-none}); pass --dir to choose another path" 2
      ;;
  esac
elif [ -e "${DIR}" ]; then
  die clone "${DIR} already exists and is not a ${MIRROR_REPO} checkout; pass --dir to choose another path" 2
else
  run mkdir -p "$(dirname "${DIR}")"
  run git clone --branch "${REF}" "${MIRROR_URL}" "${DIR}"
  [ "${DRY_RUN}" = "1" ] || ok clone "cloned ${MIRROR_REPO}@${REF} into ${DIR}"
fi

# --- 2. Run the mirror's setup.sh ------------------------------------------
# Installs pi + the toolchain, seeds agent/{settings,models}.json from the
# *.example.json templates, and symlinks ~/.pi to the clone. PI_* env passes
# through. The cloned mirror does NOT carry the five first-party extensions
# distributed via their own mirrors (step 4), so nothing double-loads.
info "Running ${DIR}/setup.sh"
if [ "${DRY_RUN}" = "1" ]; then
  info "[dry-run] (cd '${DIR}' && ./setup.sh)"
else
  if ! ( cd "${DIR}" && ./setup.sh ); then
    die setup "setup.sh failed (see its ERROR lines above)"
  fi
fi

# --- 3. Optional: personalize the clone for the recipient's own fork -------
# Runs AFTER setup so the full toolchain is available (personalize itself needs
# only git + sed). Skipped unless --owner/--repo/--gh-login are supplied.
if [ -n "${OWNER}" ] || [ -n "${REPO}" ] || [ -n "${GH_LOGIN}" ]; then
  if [ -x "${DIR}/scripts/personalize.sh" ]; then
    pargs=(--init)
    [ -n "${OWNER}" ]    && pargs+=(--owner "${OWNER}")
    [ -n "${REPO}" ]     && pargs+=(--repo "${REPO}")
    [ -n "${GH_LOGIN}" ] && pargs+=(--gh-login "${GH_LOGIN}")
    info "Personalizing the clone (${OWNER:-?}/${REPO:-?}, login ${GH_LOGIN:-?})"
    run "${DIR}/scripts/personalize.sh" "${pargs[@]}"
  else
    warn personalize "scripts/personalize.sh not found in the clone; skipping personalization"
  fi
fi

# --- 4. Install the first-party extension mirrors via pi install -----------
if [ "${SKIP_EXT}" = "1" ]; then
  skip extensions "--skip-extensions set; not installing the extension mirrors"
else
  # setup.sh installs the vendored pi into ~/.local/bin; make sure it is on PATH
  # for this step even if the recipient's shell rc has not been re-sourced yet.
  export PATH="${HOME}/.local/bin:${PATH}"
  pi_bin=""
  command -v pi >/dev/null 2>&1 && pi_bin="pi"
  if [ -z "${pi_bin}" ] && [ "${DRY_RUN}" != "1" ]; then
    warn extensions "pi is installed but not on PATH yet (open a new shell, or add its bin dir to PATH), then run:"
    for ext in "${EXT_MIRRORS[@]}"; do
      warn extensions "  pi install git:github.com/${MIRROR_OWNER}/${ext}@${EXT_REF}"
    done
  else
    [ -z "${pi_bin}" ] && pi_bin="pi"   # dry-run display only
    ext_failed=0
    for ext in "${EXT_MIRRORS[@]}"; do
      ext_spec="git:github.com/${MIRROR_OWNER}/${ext}@${EXT_REF}"
      info "pi install ${ext_spec}"
      if ! run "${pi_bin}" install "${ext_spec}"; then
        warn extensions "pi install ${ext} failed; retry later: ${pi_bin} install ${ext_spec}"
        ext_failed=$((ext_failed + 1))
      fi
    done
    if [ "${ext_failed}" -eq 0 ]; then
      ok extensions "installed ${#EXT_MIRRORS[@]} first-party extension mirror(s)"
    else
      warn extensions "${ext_failed} extension mirror(s) failed to install"
    fi
  fi
fi

# --- Next steps + summary --------------------------------------------------
echo
info "pi_config install complete."
echo "Next steps:"
echo "  1. Ensure ~/.local/bin is on your PATH (setup.sh warns if not)."
echo "  2. Run: pi"
echo "  3. First run: authenticate with /login"
echo "  4. Your config lives in ${DIR} (symlinked to ~/.pi). Edit"
echo "     ${DIR}/agent/settings.json for your provider/model/theme."
echo

echo "=================================="
if [ "${errors}" -gt 0 ]; then
  echo "FAIL — ${errors} errors, ${warnings} warnings"
  exit 1
fi
echo "PASS — ${errors} errors, ${warnings} warnings"
