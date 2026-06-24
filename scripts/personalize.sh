#!/usr/bin/env bash
#
# personalize.sh — rewrite upstream owner/repo references in this template
#                  for the recipient's fork.
#
# Run after instantiating this repo from the GitHub Template. The script
# rewrites the small R2 surface (5 files, ~12 lines) where the upstream
# identity strings are load-bearing, and records the personalization in
# .template-config for idempotency, --verify, and validate.sh's sentinel
# gate (the latter lands in #144 / sub-issue #129c).
#
# Sweep surface (R2):
#   - LICENSE                          copyright holder
#   - README.md                        license attribution
#   - CODEOWNERS                       @-handle (gh_login axis)
#   - agent/AGENTS.md                  gh api unlock command
#   - docs/distribution-provenance.md  cosign cert-identity-regexp examples
#
# Out of sweep scope (R3 archaeology — left intact intentionally):
#   adrs/, agent/rules/, agent/extensions/*/README.md, agent/skills/,
#   agent/vendor/, notes/, and any *issue* cross-references in the R2
#   files (handled by per-file line-anchored sed programs, not blind
#   file-level substitution).
#
# Why a hardcoded R2 list rather than `git ls-files | sed`:
#   docs/distribution-provenance.md contains BOTH R2 (cosign regex) and R3
#   (issue cross-refs) `TheSemicolon/pi_config` references. A blind sweep
#   would rewrite both. Per-file line-anchored sed programs are correct.
#   The maintenance liability (new R2 sites silently skipped) is caught
#   by --verify (#144 / sub-issue #129c).
#
# Usage:
#   scripts/personalize.sh --init [--owner X --repo Y --gh-login Z] [--dry-run]
#   scripts/personalize.sh --apply [--dry-run]
#   scripts/personalize.sh --help
#
# Configuration precedence (high → low):
#   1. CLI flags                 --owner / --repo / --gh-login
#   2. Environment               PI_TEMPLATE_OWNER / PI_TEMPLATE_REPO / PI_TEMPLATE_GH_LOGIN
#   3. .template-config          KEY=VALUE shell-syntax (read by --apply)
#   4. Interactive prompts       only if stdin is a TTY
#
# Exit codes:
#   0 — sweep applied (or dry-run completed)
#   1 — sweep failed (mutation error, idempotency violation)
#   2 — precondition failure (missing args in non-TTY, not a git repo, missing tools)
#
# Per agent/rules/script-output-conventions.md.

set -euo pipefail

# --- Constants -------------------------------------------------------------

readonly UPSTREAM_OWNER="TheSemicolon"
readonly UPSTREAM_REPO="pi_config"
readonly UPSTREAM_GH_LOGIN="pdavis"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_DIR
readonly CONFIG_FILE="${REPO_DIR}/.template-config"

# --- State -----------------------------------------------------------------

MODE=""              # init | apply
DRY_RUN=false
VERBOSE=false
FORCE=false

OWNER=""
REPO=""
GH_LOGIN=""

# FROM_* are the values the sweep is rewriting *from*. Default is the
# upstream identity; on --init --force after a prior personalization,
# they're set to PRIOR_* so the sweep correctly transitions
# prior-recipient → new-recipient instead of upstream → new-recipient
# (which would silently SKIP everything and corrupt state).
FROM_OWNER=""
FROM_REPO=""
FROM_GH_LOGIN=""

errors=0
warnings=0

# --- Output helpers (per agent/rules/script-output-conventions.md) ---------

ok()     { echo "OK    [$1] $2"; }
skip()   { echo "SKIP  [$1] $2"; }
# shellcheck disable=SC2329  # warn() is part of the standard helper set per
# agent/rules/script-output-conventions.md; subsequent modes (#144 --verify,
# #145 --post-merge) will invoke it.
warn()   { echo "WARN  [$1] $2"; ((warnings++)) || true; }
info()   { echo "INFO  $*"; }
err()    { echo "ERROR [$1] $2" >&2; ((errors++)) || true; }
detail() { if $VERBOSE; then printf '      %s\n' "$*"; fi; }

usage() {
  cat <<'END_USAGE'
personalize.sh — rewrite upstream owner/repo references for a recipient fork

USAGE
  scripts/personalize.sh --init [--owner X --repo Y --gh-login Z] [--dry-run]
  scripts/personalize.sh --apply [--dry-run]
  scripts/personalize.sh --help

MODES
  --init      First-run sweep. Reads owner/repo/gh-login from flags / env /
              interactive prompts (in that precedence). Writes .template-config
              and applies the sweep.
  --apply     Idempotent re-sweep. Reads .template-config; refuses if absent.
              Re-running after a clean apply produces no changes.

MODIFIERS
  --dry-run   Print what would change without writing. Emits unified diffs.
  --force     Allow re-init with values different from .template-config.
              Without --force, --init refuses if .template-config is present.
  --verbose   Per-file detail output (indented 6 spaces).

ENVIRONMENT
  PI_TEMPLATE_OWNER, PI_TEMPLATE_REPO, PI_TEMPLATE_GH_LOGIN
              Used in --init when flags are absent. Useful for unattended /
              CI invocations on non-TTY environments.

EXAMPLES
  # Interactive first-run on a freshly instantiated template:
  scripts/personalize.sh --init

  # Scripted first-run:
  scripts/personalize.sh --init --owner acme --repo widgets --gh-login alice

  # Re-apply after pulling upstream changes:
  scripts/personalize.sh --apply

EXIT CODES
  0 — sweep applied (or dry-run completed)
  1 — sweep failed (mutation error, idempotency violation)
  2 — precondition failure (missing args in non-TTY, not a git repo, missing tools)

NOTES
  --verify mode and validate.sh sentinel-gated integration land in #144.
  --post-merge conflict resolution lands in #145.
  LICENSE whole-file `merge=ours` setup lands in #143.
END_USAGE
}

summary_and_exit() {
  local precondition="${1:-}"
  echo "=================================="
  if (( errors > 0 )); then
    if [[ "$precondition" == "precondition" ]]; then
      echo "FAIL — ${errors} errors, ${warnings} warnings"
      exit 2
    fi
    echo "FAIL — ${errors} errors, ${warnings} warnings"
    exit 1
  fi
  echo "PASS — ${errors} errors, ${warnings} warnings"
  exit 0
}

# --- Portable in-place sed (BSD vs GNU sed -i divergence) ------------------
#
# GNU sed -i 's/.../.../' FILE        works
# BSD sed -i 's/.../.../' FILE        treats 's/.../.../' as the backup-suffix
# BSD sed -i '' 's/.../.../' FILE     works
#
# Sidestep the divergence entirely by writing to a tempfile + rename.

sed_inplace() {
  local script=$1 file=$2 tmp
  tmp=$(mktemp "${file}.personalize.XXXXXX")
  sed "$script" "$file" > "$tmp" && mv -- "$tmp" "$file"
}

# --- Show what would change (dry-run) --------------------------------------

sed_diff() {
  local script=$1 file=$2
  diff -u --label "a/${file#"$REPO_DIR/"}" --label "b/${file#"$REPO_DIR/"}" \
    "$file" <(sed "$script" "$file") || true
}

# --- Per-file sweepers -----------------------------------------------------
#
# Each sweeper prints OK/WARN/SKIP and optionally writes. Driven by the
# resolved OWNER / REPO / GH_LOGIN globals.
#
# Each sweeper is line-anchored: it rewrites only the specific R2 sites,
# leaving R3 archaeology in the same file untouched. This is the load-
# bearing safety property of the sweep.

sweep_license() {
  local f="${REPO_DIR}/LICENSE"
  local name="license"
  if [[ ! -f "$f" ]]; then
    err "$name" "missing: $f"
    return
  fi
  # Anchor: copyright line. Rewrites the first whole-word ${FROM_OWNER}
  # following "Copyright (c) <year> ".
  local script="/^Copyright (c) [0-9]\\{4\\} ${FROM_OWNER}/ s/${FROM_OWNER}/${OWNER}/"
  if ! grep -q "Copyright (c) [0-9]\\{4\\} ${FROM_OWNER}\\b" "$f"; then
    skip "$name" "no ${FROM_OWNER} copyright line found (already personalized?)"
    return
  fi
  if $DRY_RUN; then
    info "would rewrite LICENSE copyright holder ${FROM_OWNER} → ${OWNER}"
    detail "$(sed_diff "$script" "$f")"
    return
  fi
  sed_inplace "$script" "$f"
  ok "$name" "rewrote copyright holder ${FROM_OWNER} → ${OWNER}"
}

sweep_readme() {
  local f="${REPO_DIR}/README.md"
  local name="readme"
  if [[ ! -f "$f" ]]; then
    err "$name" "missing: $f"
    return
  fi
  # Anchor: license attribution prose. Same pattern as LICENSE.
  local script="/Copyright (c) [0-9]\\{4\\} ${FROM_OWNER}/ s/${FROM_OWNER}/${OWNER}/"
  if ! grep -q "Copyright (c) [0-9]\\{4\\} ${FROM_OWNER}\\b" "$f"; then
    skip "$name" "no ${FROM_OWNER} copyright attribution found (already personalized?)"
    return
  fi
  if $DRY_RUN; then
    info "would rewrite README.md license attribution ${FROM_OWNER} → ${OWNER}"
    detail "$(sed_diff "$script" "$f")"
    return
  fi
  sed_inplace "$script" "$f"
  ok "$name" "rewrote license attribution ${FROM_OWNER} → ${OWNER}"
}

sweep_codeowners() {
  local f="${REPO_DIR}/CODEOWNERS"
  local name="codeowners"
  if [[ ! -f "$f" ]]; then
    err "$name" "missing: $f"
    return
  fi
  # Anchor: @<gh_login> token (whole-word). Rewrite from FROM_GH_LOGIN.
  local script="s/@${FROM_GH_LOGIN}\\b/@${GH_LOGIN}/g"
  local count
  count=$(grep -c "@${FROM_GH_LOGIN}\\b" "$f" 2>/dev/null || true)
  if [[ "$count" == "0" ]]; then
    skip "$name" "no @${FROM_GH_LOGIN} references found (already personalized?)"
    return
  fi
  if $DRY_RUN; then
    info "would rewrite CODEOWNERS (${count} @-handle line(s)) @${FROM_GH_LOGIN} → @${GH_LOGIN}"
    detail "$(sed_diff "$script" "$f")"
    return
  fi
  sed_inplace "$script" "$f"
  ok "$name" "rewrote ${count} @-handle line(s) @${FROM_GH_LOGIN} → @${GH_LOGIN}"
}

sweep_agents_md() {
  local f="${REPO_DIR}/agent/AGENTS.md"
  local name="agents-md"
  if [[ ! -f "$f" ]]; then
    err "$name" "missing: $f"
    return
  fi
  # Anchor: only lines containing "branches/main/protection/enforce_admins"
  # — the gh api unlock command.
  local script="/branches\\/main\\/protection\\/enforce_admins/ s/${FROM_OWNER}\\/${FROM_REPO}/${OWNER}\\/${REPO}/g"
  if ! grep -q "branches/main/protection/enforce_admins.*${FROM_OWNER}/${FROM_REPO}" "$f"; then
    skip "$name" "no enforce_admins gh api line with ${FROM_OWNER}/${FROM_REPO} found (already personalized?)"
    return
  fi
  if $DRY_RUN; then
    info "would rewrite agent/AGENTS.md gh api unlock line ${FROM_OWNER}/${FROM_REPO} → ${OWNER}/${REPO}"
    detail "$(sed_diff "$script" "$f")"
    return
  fi
  sed_inplace "$script" "$f"
  ok "$name" "rewrote gh api unlock line ${FROM_OWNER}/${FROM_REPO} → ${OWNER}/${REPO}"
}

sweep_docs_provenance() {
  local f="${REPO_DIR}/docs/distribution-provenance.md"
  local name="docs-provenance"
  if [[ ! -f "$f" ]]; then
    err "$name" "missing: $f"
    return
  fi
  # Anchor: only lines containing "certificate-identity-regexp" — the
  # cosign verification command examples. Issue cross-references in the
  # same file (https://.../issues/N) are R3 archaeology and excluded by
  # this line anchor.
  local script="/certificate-identity-regexp/ s/${FROM_OWNER}\\/${FROM_REPO}/${OWNER}\\/${REPO}/g"
  local count
  count=$(grep -c "certificate-identity-regexp.*${FROM_OWNER}/${FROM_REPO}" "$f" 2>/dev/null || true)
  if [[ "$count" == "0" ]]; then
    skip "$name" "no cosign cert-identity-regexp lines with ${FROM_OWNER}/${FROM_REPO} found (already personalized?)"
    return
  fi
  if $DRY_RUN; then
    info "would rewrite docs/distribution-provenance.md cosign lines (${count}) ${FROM_OWNER}/${FROM_REPO} → ${OWNER}/${REPO}"
    detail "$(sed_diff "$script" "$f")"
    return
  fi
  sed_inplace "$script" "$f"
  ok "$name" "rewrote ${count} cosign cert-identity line(s) ${FROM_OWNER}/${FROM_REPO} → ${OWNER}/${REPO}"
}

run_sweep() {
  sweep_license
  sweep_readme
  sweep_codeowners
  sweep_agents_md
  sweep_docs_provenance
}

# --- Config file I/O -------------------------------------------------------

write_template_config() {
  $DRY_RUN && { info "would write ${CONFIG_FILE}"; return 0; }
  cat > "$CONFIG_FILE" <<EOF
# Written by scripts/personalize.sh — committed so validate.sh can
# distinguish upstream from personalized forks. Do not edit by hand;
# re-run scripts/personalize.sh --init --force to change values.
OWNER=${OWNER}
REPO=${REPO}
GH_LOGIN=${GH_LOGIN}
SWEPT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  ok "config" "wrote .template-config (OWNER=${OWNER} REPO=${REPO} GH_LOGIN=${GH_LOGIN})"
}

read_template_config() {
  local prior_owner="" prior_repo="" prior_gh_login=""
  if [[ -f "$CONFIG_FILE" ]]; then
    prior_owner=$(awk -F= '$1=="OWNER"{print $2}' "$CONFIG_FILE")
    prior_repo=$(awk -F= '$1=="REPO"{print $2}' "$CONFIG_FILE")
    prior_gh_login=$(awk -F= '$1=="GH_LOGIN"{print $2}' "$CONFIG_FILE")
  fi
  PRIOR_OWNER="$prior_owner"
  PRIOR_REPO="$prior_repo"
  PRIOR_GH_LOGIN="$prior_gh_login"
}

# --- Identifier validation -------------------------------------------------
#
# GitHub owner/login: alphanumerics, single hyphens, max 39 chars. Repo
# name: alphanumerics, hyphen, underscore, dot, max 100 chars. Defense-
# in-depth against sed-delimiter injection (forward slash, ampersand,
# backslash) and paste whitespace.

validate_identifier() {
  local kind=$1 value=$2 pattern=$3
  if [[ -z "$value" ]]; then
    err "args" "$kind is empty"
    return 1
  fi
  if [[ ! "$value" =~ $pattern ]]; then
    err "args" "$kind '$value' contains invalid characters; expected $pattern"
    return 1
  fi
  return 0
}

validate_inputs() {
  local rc=0
  validate_identifier "owner"    "$OWNER"    '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$' || rc=1
  validate_identifier "repo"     "$REPO"     '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' || rc=1
  validate_identifier "gh-login" "$GH_LOGIN" '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$' || rc=1
  return $rc
}

# --- Arg parsing -----------------------------------------------------------

parse_args() {
  while (( $# )); do
    case "$1" in
      --init)        MODE="init"; shift ;;
      --apply)       MODE="apply"; shift ;;
      --owner)       OWNER="${2:?--owner requires a value}"; shift 2 ;;
      --repo)        REPO="${2:?--repo requires a value}"; shift 2 ;;
      --gh-login)    GH_LOGIN="${2:?--gh-login requires a value}"; shift 2 ;;
      --dry-run)     DRY_RUN=true; shift ;;
      --force)       FORCE=true; shift ;;
      --verbose|-v)  VERBOSE=true; shift ;;
      --help|-h)     usage; exit 0 ;;
      *)             err "args" "unknown flag: $1"; usage >&2; exit 2 ;;
    esac
  done

  if [[ -z "$MODE" ]]; then
    err "args" "one of --init or --apply is required"
    usage >&2
    exit 2
  fi
}

# --- Input resolution ------------------------------------------------------

resolve_inputs_for_init() {
  # Precedence: flags > env > prior config > interactive
  OWNER=${OWNER:-${PI_TEMPLATE_OWNER:-${PRIOR_OWNER:-}}}
  REPO=${REPO:-${PI_TEMPLATE_REPO:-${PRIOR_REPO:-}}}
  GH_LOGIN=${GH_LOGIN:-${PI_TEMPLATE_GH_LOGIN:-${PRIOR_GH_LOGIN:-}}}

  if [[ -z "$OWNER" || -z "$REPO" || -z "$GH_LOGIN" ]]; then
    if [[ -t 0 ]]; then
      [[ -z "$OWNER" ]]    && read -r -p "Recipient owner (GitHub org/user): " OWNER
      [[ -z "$REPO" ]]     && read -r -p "Recipient repo name: " REPO
      [[ -z "$GH_LOGIN" ]] && read -r -p "Recipient gh login (CODEOWNERS @-handle, no @): " GH_LOGIN
    else
      err "args" "--owner, --repo, and --gh-login are required when stdin is not a TTY"
      summary_and_exit precondition
    fi
  fi

  # Reject empty after resolution.
  if [[ -z "$OWNER" || -z "$REPO" || -z "$GH_LOGIN" ]]; then
    err "args" "owner / repo / gh-login resolved to empty; aborting"
    summary_and_exit precondition
  fi

  # Reject sweeping to the upstream values (no-op masquerading as success).
  if [[ "$OWNER" == "$UPSTREAM_OWNER" && "$REPO" == "$UPSTREAM_REPO" && "$GH_LOGIN" == "$UPSTREAM_GH_LOGIN" ]]; then
    err "args" "owner/repo/gh-login match upstream identity; nothing to do"
    info "if you intended to test the script, use placeholder values like --owner test --repo test --gh-login test"
    summary_and_exit precondition
  fi

  # Validate identifier shapes (defense-in-depth against sed-delimiter
  # injection, paste whitespace, accidentally-typed slashes).
  if ! validate_inputs; then
    summary_and_exit precondition
  fi
}

resolve_inputs_for_apply() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    err "config" ".template-config not found; run 'scripts/personalize.sh --init' first"
    summary_and_exit precondition
  fi
  OWNER="$PRIOR_OWNER"
  REPO="$PRIOR_REPO"
  GH_LOGIN="$PRIOR_GH_LOGIN"
  if [[ -z "$OWNER" || -z "$REPO" || -z "$GH_LOGIN" ]]; then
    err "config" ".template-config is malformed (missing OWNER, REPO, or GH_LOGIN)"
    summary_and_exit precondition
  fi
  if [[ "$OWNER" == "$UPSTREAM_OWNER" && "$REPO" == "$UPSTREAM_REPO" ]]; then
    skip "apply" "config records upstream identity; nothing to do (run --init to personalize)"
    summary_and_exit
  fi
  # --apply re-sweeps from upstream literals to the recorded recipient values.
  # (--apply only makes sense as a re-run after upstream pull — files may
  # contain upstream literals on conflict-resolved lines. --post-merge in
  # #145 will narrow this further.)
  FROM_OWNER="$UPSTREAM_OWNER"
  FROM_REPO="$UPSTREAM_REPO"
  FROM_GH_LOGIN="$UPSTREAM_GH_LOGIN"
}

# --- Pre-flight ------------------------------------------------------------

preflight_env() {
  command -v git >/dev/null 2>&1 \
    || { err "deps" "git not found in PATH"; summary_and_exit precondition; }
  command -v sed >/dev/null 2>&1 \
    || { err "deps" "sed not found in PATH"; summary_and_exit precondition; }
  git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || { err "deps" "$REPO_DIR is not a git repository"; summary_and_exit precondition; }
}

preflight_init_existing_config() {
  # --init refuses if .template-config already exists with non-upstream values
  # unless --force is set. Called BEFORE resolve_inputs_for_init so we don't
  # prompt the user for values and then refuse the run.
  if [[ -f "$CONFIG_FILE" ]] && ! $FORCE; then
    if [[ -n "$PRIOR_OWNER" && "$PRIOR_OWNER" != "$UPSTREAM_OWNER" ]]; then
      err "config" ".template-config already records a personalization for ${PRIOR_OWNER}/${PRIOR_REPO}"
      info "pass --force to overwrite, or run --apply to re-sweep with the recorded values"
      summary_and_exit precondition
    fi
  fi
}

# Resolve the FROM_* sweep source. On a fresh first run, FROM_* is the
# upstream identity. On --init --force after a prior personalization,
# FROM_* is the prior recipient identity (so the sweep correctly transitions
# prior → new instead of upstream → new — which would silently SKIP).
resolve_from_identity() {
  if [[ "$MODE" == "init" ]] && $FORCE && [[ -n "$PRIOR_OWNER" && "$PRIOR_OWNER" != "$UPSTREAM_OWNER" ]]; then
    FROM_OWNER="$PRIOR_OWNER"
    FROM_REPO="$PRIOR_REPO"
    FROM_GH_LOGIN="$PRIOR_GH_LOGIN"
    info "--force: re-personalizing from prior ${FROM_OWNER}/${FROM_REPO} (login: ${FROM_GH_LOGIN})"
  elif [[ -z "$FROM_OWNER" ]]; then
    FROM_OWNER="$UPSTREAM_OWNER"
    FROM_REPO="$UPSTREAM_REPO"
    FROM_GH_LOGIN="$UPSTREAM_GH_LOGIN"
  fi
}

# --- Mode dispatchers ------------------------------------------------------

do_init() {
  preflight_env
  preflight_init_existing_config
  resolve_inputs_for_init
  resolve_from_identity
  info "personalize.sh --init$($DRY_RUN && echo ' (dry-run)') ${FROM_OWNER}/${FROM_REPO} → ${OWNER}/${REPO} (login: ${GH_LOGIN})"
  run_sweep
  write_template_config
  if ! $DRY_RUN; then
    info "next steps:"
    info "  1. review the diff: git diff"
    info "  2. set the upstream remote: git remote add upstream https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}.git"
    info "  3. apply branch protection — see the welcome issue opened by template-cleanup.yml,"
    info "     or follow the recipient runbook landing in #147 (README 'Distribution paths')."
  fi
  summary_and_exit
}

do_apply() {
  preflight_env
  resolve_inputs_for_apply
  resolve_from_identity
  info "personalize.sh --apply$($DRY_RUN && echo ' (dry-run)') ${FROM_OWNER}/${FROM_REPO} → ${OWNER}/${REPO} (login: ${GH_LOGIN})"
  run_sweep
  summary_and_exit
}

# --- Main ------------------------------------------------------------------

main() {
  parse_args "$@"
  read_template_config
  case "$MODE" in
    init)  do_init ;;
    apply) do_apply ;;
    *)     err "args" "internal: unhandled mode '$MODE'"; exit 2 ;;
  esac
}

main "$@"
