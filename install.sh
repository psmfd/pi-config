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
# The fetched release tag's SSH signature is verified BEST-EFFORT before the
# working tree is materialized (ADR-0087): a present-but-invalid signature is
# refused (tampering signal), while a missing verifier (ssh-keygen) or an
# unsigned/old tag only warns — first-install trust is bounded by the fact that
# install.sh itself arrives over an unauthenticated channel (pair with the
# per-release install.sh checksums, #626, for end-to-end first-install assurance).
# update.sh verifies FAIL-CLOSED once installed.
#
# Per ADR-0051 (this installer), ADR-0050 (the verified mirror it consumes),
# ADR-0086 (release-tag default + update.sh), ADR-0087 (release signing).
#
# Usage:
#   bash install.sh [--dir DIR] [--ref REF] [--skip-extensions]
#                   [--owner X --repo Y --gh-login Z] [--dry-run] [-h|--help]
#
# Flags:
#   --dir DIR          Clone target (default: ~/projects/pi-config).
#   --ref REF          Branch or tag to install. Default: the latest vX.Y.Z
#                      release tag of the mirror (resolved at runtime). Pass
#                      --ref main for the bleeding-edge integration branch, or
#                      --ref vX.Y.Z to pin an exact release (ADR-0086).
#   --ext-ref REF      Override ALL extension-mirror pins with one ref (forks /
#                      testing). Default: use the per-extension pins in EXT_MIRRORS.
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
# Optional global override: `--ext-ref vX.Y.Z` pins ALL mirrors to one ref
# (forks / testing). Empty (default) = use the per-extension pins below.
EXT_REF=""
# Per-extension version pins (name@vX.Y.Z). Each mirror versions independently
# (ADR-0058), so a single shared pin cannot represent them (#492, ADR-0075).
# Kept current by scripts/check-ext-ref-drift.sh --fix + the weekly
# pin-drift-check.yml, which open per-extension bump PRs.
EXT_MIRRORS=(
  pi-secrets-guard@v0.2.0
  pi-bash-destructive-guard@v0.2.0
  pi-artifact-handoff@v0.1.1
  pi-web-fetch@v0.1.1
  pi-cache-meter@v0.1.1
  pi-token-meter@v0.2.0
  pi-gh-identity-guard@v0.1.1
  pi-compaction-optimizer@v0.1.1
  pi-expertise-client@v0.3.1
  pi-indexing@v0.1.1
  pi-context-manager@v0.1.2
  pi-auto-router@v0.5.1
)

DIR="${HOME}/projects/pi-config"
REF=""   # empty => resolve the latest release tag after flag parsing (ADR-0086)
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

# --- SemVer helpers (LOCKSTEP with scripts/lib/semver-classify.sh) ----------
# install.sh is standalone (sent as a single file), so it cannot source the
# shared lib; update.sh, which runs from inside the clone, sources it instead.
# Keep these two definitions in sync with that lib's is_semver/ver_gt.
is_semver() { printf '%s' "$1" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; }
# ver_gt <vA> <vB>: return 0 iff A > B (numeric per-field; no `sort -V`, absent/
# broken on BSD — mis-sorts v0.9.0 vs v0.10.0 lexically).
ver_gt() {
  local a="${1#v}" b="${2#v}" rest am an ap bm bn bp
  am="${a%%.*}"; rest="${a#*.}"; an="${rest%%.*}"; ap="${rest#*.}"
  bm="${b%%.*}"; rest="${b#*.}"; bn="${rest%%.*}"; bp="${rest#*.}"
  [ "$am" -ne "$bm" ] && { [ "$am" -gt "$bm" ]; return; }
  [ "$an" -ne "$bn" ] && { [ "$an" -gt "$bn" ]; return; }
  [ "$ap" -gt "$bp" ]
}
# resolve_latest_tag <remote-url>: print the highest vX.Y.Z tag, or fail (rc 1).
# Network-only (`git ls-remote`) — no clone, no gh, no auth; `--refs` drops the
# peeled `^{}` lines.
resolve_latest_tag() {
  local url="$1" best="" t
  while IFS= read -r t; do
    is_semver "$t" || continue
    if [ -z "${best}" ] || ver_gt "$t" "${best}"; then best="$t"; fi
  done < <(git ls-remote --tags --refs "${url}" 'v*' 2>/dev/null | sed -E 's#.*refs/tags/##')
  [ -n "${best}" ] || return 1
  printf '%s\n' "${best}"
}

# --- Release-signer allowed-signers key (LOCKSTEP with -------------------------
# scripts/lib/release-signers.txt; validate.sh enforces the match). install.sh is
# standalone, so it embeds the pubkey inline. Its PRIVATE half is the
# mirror-production secret RELEASE_SIGNING_SSH_KEY (see ADR-0087).
RELEASE_SIGNER_ALLOWED_SIGNERS='pi-config-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILXgPGZmROYMRhfjy708Ip5bMpvTv8+ufXz2xC0N5kyR pi-config-release'

# verify_release_tag <dir> <ref-or-FETCH_HEAD>: BEST-EFFORT signature check
# (ADR-0087, install-side). Bootstrap paradox: install.sh arrives over an
# unauthenticated channel, so first-install verification is advisory. Posture:
#   - ssh-keygen missing OR tag unsigned  -> WARN + proceed (tooling/bootstrap gap)
#   - present-but-INVALID signature       -> die (active-tampering signal)
#   - valid signature                     -> ok
# Returns 0 to proceed, or calls die() on a tampering signal.
verify_release_tag() {
  local dir="$1" target="$2" signers out rc
  [ "${DRY_RUN}" = "1" ] && return 0
  is_semver "${REF}" || return 0   # branch ref: no release tag to verify
  case "${RELEASE_SIGNER_ALLOWED_SIGNERS}" in
    *REPLACE_WITH_REAL_PUBLIC_KEY*)
      warn verify "release-signer key not yet provisioned (pre-rollout build); skipping signature check"; return 0 ;;
  esac
  if ! command -v ssh-keygen >/dev/null 2>&1; then
    warn verify "ssh-keygen not found; cannot verify ${REF} signature — proceeding (install openssh-client for verification)"; return 0
  fi
  signers="$(mktemp "${TMPDIR:-/tmp}/pi-config-allowed-signers.XXXXXX")" || { warn verify "could not create temp signers file; skipping verification"; return 0; }
  printf '%s\n' "${RELEASE_SIGNER_ALLOWED_SIGNERS}" > "${signers}"; chmod 600 "${signers}"
  # Capture rc via `|| rc=$?` so a failing verify does not trip `set -e`.
  out="$(git -C "${dir}" -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="${signers}" verify-tag "${target}" 2>&1)" && rc=0 || rc=$?
  if [ "${rc}" -eq 0 ]; then
    rm -f "${signers}"; ok verify "release ${REF} signature verified"; return 0
  fi
  rm -f "${signers}"
  # Distinguish "unsigned" (bootstrap/old release -> warn) from a bad/wrong
  # signature (tampering -> refuse). git/ssh emit "no signature" for the former.
  case "${out}" in
    *"no signature"*|*"No signature"*|*"does not have"*)
      warn verify "${REF} is unsigned (pre-signing release?); proceeding best-effort at install time"; return 0 ;;
    *)
      die verify "signature verification FAILED for ${REF} (present but invalid/wrong-signer — possible tampering); refusing" 1 ;;
  esac
}

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

# --- 0. Resolve the default ref to the latest release tag ------------------
# Default (no --ref): install the latest vX.Y.Z release tag — a coherent,
# reviewed snapshot whose EXT_MIRRORS pins match the config (ADR-0086). Fail
# closed if it cannot be resolved rather than silently falling back to `main`.
if [ -z "${REF}" ]; then
  REF="$(resolve_latest_tag "${MIRROR_URL}" || true)"
  if [ -z "${REF}" ]; then
    die ref "could not resolve the latest release tag of ${MIRROR_REPO} (offline, or no tags?); pass --ref <tag|main> explicitly" 2
  fi
  info "Resolved default ref to latest release tag: ${REF}"
fi

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
      verify_release_tag "${DIR}" FETCH_HEAD   # best-effort (ADR-0087)
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
  # --no-checkout so the tag signature is verified BEFORE any working tree is
  # materialized (ADR-0087). Best-effort at install time (bootstrap paradox).
  run git clone --no-checkout --branch "${REF}" "${MIRROR_URL}" "${DIR}"
  verify_release_tag "${DIR}" "${REF}"
  run git -C "${DIR}" checkout "${REF}"
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

  # `pi install` shells out to `npm install --omit=dev` for each extension
  # (ADR-0042), so node/npm must be on PATH too. In a non-interactive shell the
  # rc that loads nvm has not run — the same nvm-not-on-PATH class as #388/#483 —
  # so every `pi install` aborts after cloning, before registering the extension
  # in settings.json, and the box silently ships with no extensions (#557).
  # setup.sh already installed node via nvm; load it here if npm is absent. This
  # is inline (not a scripts/lib source) because install.sh is standalone.
  if ! command -v npm >/dev/null 2>&1 && [ "${DRY_RUN}" != "1" ]; then
    nvm_sh="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
    if [ -s "${nvm_sh}" ]; then
      # nvm.sh is third-party and not nounset-clean; relax -e/-u around it only.
      set +eu
      # shellcheck disable=SC1090
      . "${nvm_sh}" >/dev/null 2>&1
      nvm use node >/dev/null 2>&1
      set -eu
    fi
    command -v npm >/dev/null 2>&1 || warn extensions \
      "npm is not on PATH (node via nvm is not loaded); every 'pi install' below will fail its npm step. Load node — e.g. '. \"\${NVM_DIR:-\$HOME/.nvm}/nvm.sh\" && nvm use node' — then re-run install.sh, or re-run in a shell where node is on PATH."
  fi

  pi_bin=""
  command -v pi >/dev/null 2>&1 && pi_bin="pi"
  if [ -z "${pi_bin}" ] && [ "${DRY_RUN}" != "1" ]; then
    warn extensions "pi is installed but not on PATH yet (open a new shell, or add its bin dir to PATH), then run:"
    for entry in "${EXT_MIRRORS[@]}"; do
      # Same defensive guard as the install loop below: without it a version-less
      # entry prints a bogus `name@name` install target instead of a clear warning.
      case "${entry}" in
        *@*) : ;;
        *) warn extensions "malformed EXT_MIRRORS entry (no @version), skipping: ${entry}"; continue ;;
      esac
      ext="${entry%@*}"; ref="${EXT_REF:-${entry##*@}}"
      warn extensions "  pi install git:github.com/${MIRROR_OWNER}/${ext}@${ref}"
    done
  else
    [ -z "${pi_bin}" ] && pi_bin="pi"   # dry-run display only
    ext_failed=0
    for entry in "${EXT_MIRRORS[@]}"; do
      # Defensive: a malformed entry (no @version) is a validate.sh error, but
      # fail it loudly here too rather than emit a bogus `name@name` install target.
      case "${entry}" in
        *@*) : ;;
        *) warn extensions "malformed EXT_MIRRORS entry (no @version), skipping: ${entry}"; ext_failed=$((ext_failed + 1)); continue ;;
      esac
      ext="${entry%@*}"; ref="${EXT_REF:-${entry##*@}}"
      ext_spec="git:github.com/${MIRROR_OWNER}/${ext}@${ref}"
      info "pi install ${ext_spec}"
      if ! run "${pi_bin}" install "${ext_spec}"; then
        warn extensions "pi install ${ext} failed; retry later: ${pi_bin} install ${ext_spec}"
        ext_failed=$((ext_failed + 1))
      fi
    done
    ext_total="${#EXT_MIRRORS[@]}"
    if [ "${ext_failed}" -eq 0 ]; then
      ok extensions "installed ${ext_total} first-party extension mirror(s)"
    elif [ "${ext_failed}" -ge "${ext_total}" ]; then
      # A total failure means the box has NO first-party extensions — do not let
      # the summary report PASS. Commonly npm/node not on PATH (see the WARN
      # above and #557).
      err extensions "all ${ext_total} extension mirror(s) failed to install — the install is not usable (commonly npm/node not on PATH; see #557)"
    else
      warn extensions "${ext_failed} of ${ext_total} extension mirror(s) failed to install"
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
