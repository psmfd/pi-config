#!/usr/bin/env bash
#
# update.sh — on-demand updater for an installed pi_config checkout.
#
# Run this from inside your pi_config clone (the one install.sh created and
# ~/.pi is symlinked to):
#
#   ./update.sh                 update to the latest release tag
#   ./update.sh --check         report installed vs latest; change nothing
#   ./update.sh --ref v1.17.0   roll back / pin to a specific tag (or a branch)
#
# It is a thin TRAMPOLINE: it resolves the target ref, runs two fail-closed
# safety guards, git-updates the clone, then re-execs the *freshly-updated*
# install.sh in that clone. That re-exec is deliberate — the updated install.sh
# carries the new EXT_MIRRORS extension pins and re-runs setup.sh + `pi install`,
# so update.sh never duplicates that logic and never ships stale pins. Re-execing
# a DIFFERENT file after `git reset --hard` also sidesteps the self-modifying-
# script hazard (bash must not keep executing a file git just rewrote).
#
# Per ADR-0086 (this updater), ADR-0051 (install.sh), ADR-0075 (extension pins).
#
# Safety guards:
#   * Anti-downgrade — refuses a SemVer-lower target unless you pass --ref
#     explicitly (that IS the rollback path). Fails closed on an unparseable
#     target version. A compromised mirror cannot silently move you backward.
#   * Dirty-tree — refuses if tracked files have local edits (which reset --hard
#     would discard); pass --force to override. Gitignored live config
#     (agent/settings.json, agent/models.json) is never touched by reset --hard.
#
# Usage:
#   update.sh [--ref REF] [--check] [--force] [--skip-extensions]
#             [--dry-run] [-h|--help]
#
# Flags:
#   --ref REF          Update to REF (release tag, branch, or older tag for
#                      rollback) instead of the latest release tag. An explicit
#                      --ref is what authorizes a downgrade.
#   --check            Print installed vs latest release + the release URL, then
#                      exit. Local, structural compare only — mutates nothing.
#   --force            Proceed even if tracked files have local modifications
#                      (they will be discarded by reset --hard).
#   --skip-extensions  Forwarded to install.sh: do not reinstall the extension
#                      mirrors.
#   --dry-run          Print intended actions without changing anything. NOTE:
#                      dry-run skips the fetch/reset, so the install.sh it execs
#                      is the CURRENT (not yet updated) copy.
#   -h | --help        Print this header and exit.
#
# Environment: PI_* variables pass through to install.sh -> setup.sh unchanged.
#
# Exit codes:
#   0 — up to date, --check completed, --dry-run completed, or handed off to
#       install.sh via exec
#   1 — an error occurred
#   2 — precondition failure (not a pi-config checkout, missing git, bad flag)
#
# Per agent/rules/script-output-conventions.md.

set -euo pipefail

# Uses bash arrays / BASH_SOURCE — refuse to run under a non-bash shell.
[ -n "${BASH_VERSION:-}" ] || { printf 'ERROR [update] run with bash: bash update.sh\n' >&2; exit 2; }

MIRROR_OWNER="psmfd"
MIRROR_REPO="${MIRROR_OWNER}/pi-config"

# --- Output helpers (script-output-conventions; standalone, no shared lib) ---
errors=0
warnings=0
ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
skip() { printf 'SKIP  [%s] %s\n' "$1" "$2"; }
warn() { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; warnings=$((warnings + 1)); }
info() { printf 'INFO  %s\n' "$*"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }
die()  { err "${1:-update}" "${2:-fatal}"; exit "${3:-1}"; }
run()  { if [ "$DRY_RUN" = "1" ]; then info "[dry-run] $*"; else "$@"; fi; }

# is_semver <s>: true iff s is exactly vX.Y.Z (guards remote-controlled strings).
is_semver() { printf '%s' "$1" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; }

# --- Flags -----------------------------------------------------------------
REF=""
REF_EXPLICIT=0
CHECK=0
FORCE=0
SKIP_EXT=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)             REF="${2:?--ref requires a value}"; REF_EXPLICIT=1; shift 2 ;;
    --check)           CHECK=1; shift ;;
    --force)           FORCE=1; shift ;;
    --skip-extensions) SKIP_EXT=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    -h|--help)         sed -nE '/^# /{s/^# ?//;p;};/^$/q' "$0"; exit 0 ;;
    *)                 die args "unknown flag: $1" 2 ;;
  esac
done

command -v git >/dev/null 2>&1 || die deps "git not found in PATH; install git first" 2

# --- Resolve and validate the checkout -------------------------------------
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -d "${DIR}/.git" ] || die checkout "${DIR} is not a git checkout; run update.sh from inside your pi_config clone" 2

origin="$(git -C "${DIR}" remote get-url origin 2>/dev/null || echo '')"
# Host- AND end-anchored: only a real github.com/<MIRROR_REPO> checkout matches
# (not a lookalike like .../pi-config-evil, nor another host's matching path).
case "${origin}" in
  *github.com[:/]"${MIRROR_REPO}"|*github.com[:/]"${MIRROR_REPO}".git) : ;;
  *) die checkout "${DIR} origin is not github.com/${MIRROR_REPO} (${origin:-none}); run update.sh from inside your pi_config clone" 2 ;;
esac

# update.sh runs from inside the clone, so it CAN source the shared semver lib
# for ver_gt (numeric, BSD-safe — never `sort -V`). install.sh, being standalone,
# carries its own inline copy instead.
# shellcheck source=scripts/lib/semver-classify.sh
. "${DIR}/scripts/lib/semver-classify.sh"

# resolve_latest_tag <remote-url>: print the highest vX.Y.Z tag, or fail.
# Network-only (`git ls-remote`) — no clone, no gh, no auth. `--refs` drops the
# peeled `^{}` lines so no dedup is needed.
resolve_latest_tag() {
  local url="$1" best="" t
  while IFS= read -r t; do
    is_semver "$t" || continue
    if [ -z "${best}" ] || ver_gt "$t" "${best}"; then best="$t"; fi
  done < <(git ls-remote --tags --refs "${url}" 'v*' 2>/dev/null | sed -E 's#.*refs/tags/##')
  [ -n "${best}" ] || return 1
  printf '%s\n' "${best}"
}

# Installed version: an exact-tag checkout gives a clean vX.Y.Z; otherwise report
# that we are tracking a branch (install --ref main, or a dev clone).
installed="$(git -C "${DIR}" describe --tags --exact-match 2>/dev/null || echo '')"
installed_disp="${installed:-untagged (tracking a branch)}"

# Latest available release tag (best-effort; may be empty if offline).
latest="$(resolve_latest_tag "${origin}" || echo '')"

# --- --check: report only, mutate nothing ----------------------------------
if [ "${CHECK}" = "1" ]; then
  info "Installed: ${installed_disp}"
  if [ -z "${latest}" ]; then
    warn check "could not resolve the latest release tag (offline, or no tags on ${MIRROR_REPO}?)"
  else
    info "Latest:    ${latest}"
    info "Release:   https://github.com/${MIRROR_REPO}/releases/tag/${latest}"
    if [ -n "${installed}" ] && [ "${installed}" = "${latest}" ]; then
      ok check "already on the latest release (${latest})"
    elif [ -n "${installed}" ] && ver_gt "${installed}" "${latest}"; then
      info "Installed (${installed}) is newer than the latest published tag (${latest})."
    else
      info "Update available: ${installed_disp} -> ${latest}. Run: ./update.sh"
    fi
  fi
  echo "=================================="
  echo "PASS — ${errors} errors, ${warnings} warnings"
  exit 0
fi

# --- Resolve the target ref ------------------------------------------------
# Explicit --ref wins (and authorizes a downgrade / branch). Otherwise the
# latest release tag; fail closed if it cannot be resolved (per ADR-0086 —
# do not silently fall back to `main`).
if [ -z "${REF}" ]; then
  [ -n "${latest}" ] || die resolve "could not resolve the latest release tag (offline, or no tags?); pass --ref <tag|main> explicitly" 1
  REF="${latest}"
  info "Target: latest release tag ${REF}"
else
  info "Target: --ref ${REF}"
fi

# --- Anti-downgrade guard --------------------------------------------------
# Only meaningful when BOTH the installed and target refs are parseable versions
# (a branch target like `main` is an explicit --ref choice and is not compared).
if [ -n "${installed}" ] && is_semver "${REF}"; then
  if [ "${installed}" = "${REF}" ] && [ "${FORCE}" != "1" ]; then
    ok update "already on ${REF} — nothing to do (pass --force to re-run the install)"
    echo "=================================="
    echo "PASS — ${errors} errors, ${warnings} warnings"
    exit 0
  fi
  if ver_gt "${installed}" "${REF}"; then
    # A downgrade is only allowed when the user explicitly asked for this ref
    # (that IS the rollback path). The auto-latest path refusing here means the
    # mirror's latest tag is older than what is installed — refuse fail-closed.
    if [ "${REF_EXPLICIT}" != "1" ]; then
      die downgrade "the latest release tag ${REF} is OLDER than the installed ${installed}; refusing (a mirror must not move you backward). To roll back deliberately, pass --ref ${REF}" 1
    fi
    warn downgrade "rolling back from ${installed} to the explicitly-requested ${REF}"
  fi
fi

# --- Dirty-tree guard ------------------------------------------------------
# `git diff --quiet HEAD --` / `--cached HEAD --` isolate TRACKED modifications
# (what reset --hard would discard). `status --porcelain` would over-report
# untracked/gitignored files that reset --hard never touches.
if [ "${FORCE}" != "1" ] && [ "${DRY_RUN}" != "1" ]; then
  if ! git -C "${DIR}" diff --quiet HEAD -- 2>/dev/null \
     || ! git -C "${DIR}" diff --quiet --cached HEAD -- 2>/dev/null; then
    die dirty "local changes to tracked files in ${DIR} would be discarded by update; commit, stash, or pass --force" 1
  fi
fi

# --- Fetch + reset ---------------------------------------------------------
# A full (non-shallow) history is needed for the OLD..NEW changelog and clean
# rollback; unshallow first if the initial install left a shallow clone.
OLD_SHA="$(git -C "${DIR}" rev-parse HEAD 2>/dev/null || echo '')"
if [ "$(git -C "${DIR}" rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
  run git -C "${DIR}" fetch --unshallow origin || warn fetch "could not unshallow; changelog range may be unavailable"
fi
run git -C "${DIR}" fetch origin "${REF}"
run git -C "${DIR}" reset --hard FETCH_HEAD
[ "${DRY_RUN}" = "1" ] || ok update "updated ${DIR} to ${REF}"

# --- Changelog surfacing (best-effort; never fatal) ------------------------
if is_semver "${REF}"; then
  info "Release notes: https://github.com/${MIRROR_REPO}/releases/tag/${REF}"
fi
if [ "${DRY_RUN}" != "1" ] && [ -n "${OLD_SHA}" ]; then
  if changelog="$(git -C "${DIR}" log --oneline "${OLD_SHA}..HEAD" 2>/dev/null)" && [ -n "${changelog}" ]; then
    info "Changes since ${installed_disp}:"
    printf '%s\n' "${changelog}"
  fi
fi

# --- Hand off to the freshly-updated install.sh ----------------------------
# exec (not call): the updated install.sh applies the new EXT_MIRRORS pins,
# re-runs setup.sh (idempotent), and reinstalls extensions. Nothing runs after
# this line — that is the self-modification safety property.
[ -x "${DIR}/install.sh" ] || die handoff "${DIR}/install.sh is missing or not executable after update" 1
exec_args=(--dir "${DIR}" --ref "${REF}")
[ "${SKIP_EXT}" = "1" ] && exec_args+=(--skip-extensions)
[ "${DRY_RUN}" = "1" ] && exec_args+=(--dry-run)
info "Handing off to install.sh ${exec_args[*]}"
exec "${DIR}/install.sh" "${exec_args[@]}"
