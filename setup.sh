#!/usr/bin/env bash
# pi_config setup — installs pi (if missing) and links this repo to ~/.pi
#
# Idempotent: safe to run repeatedly. Re-run after pulling repo updates to
# pick up new pi versions or re-verify the symlink.
#
# Per ADR-0010 (setup.sh install-trust posture and nvm-mandatory node)
# and ADR-0012 (vendored pi as the default install path). The
# dependency-installer surface (§1) is driven by scripts/lib/
# install-helpers.sh; the pi runtime acquisition (§2, default) is
# driven by scripts/lib/fetch-pi-binary.sh (ADR-0009). The legacy
# `npm install -g` path remains available behind PI_USE_VENDORED=0
# as a permanent opt-out (ADR-0012).
#
# Flags / environment variables (see also § "Useful flags" in README):
#   --dry-run                      Print install commands without executing.
#   PI_CONFIG_SKIP_DEPS=1          Umbrella opt-out: skip every install phase
#                                  (§1 + §1b + the active-install branches of
#                                  §2). Preserves historical check-and-warn.
#   PI_CONFIG_SKIP_NVM=1           Skip just the nvm + Node phase (§1).
#                                  Toolchain (§1b) and pi (§2) still install.
#   PI_CONFIG_SKIP_TOOLCHAIN=1     Skip just the developer-toolchain phase
#                                  (§1b: gh, jq, yq, shellcheck, gitleaks,
#                                  markdownlint-cli2, yamllint). nvm/node (§1)
#                                  and pi (§2) unaffected.
#   PI_CONFIG_SET_DEFAULT_NODE=1   Set Node 24 as nvm's default (otherwise
#                                  installed but not made default).
#   PI_USE_VENDORED=0              Opt out of the default vendored pi path
#                                  and install via `npm install -g` (legacy).
#                                  Default is the vendored binary path
#                                  (ADR-0009 / ADR-0012). The npm path is
#                                  preserved indefinitely as the opt-out;
#                                  no removal is scheduled.
#   PI_ALLOW_SUDO_NPM=1            Allow the legacy `npm install -g` path
#                                  to retry with sudo on permission failure.
#                                  Off by default; the active-install path
#                                  uses nvm-managed npm which never needs sudo.
#   PI_ALLOW_SUDO_APT=1            Allow toolchain installs to invoke
#                                  `sudo apt-get install` on Debian/Ubuntu
#                                  (jq, yamllint). Off by default per ADR-0011.
#   PI_ALLOW_SUDO_DNF=1            As PI_ALLOW_SUDO_APT but for Fedora/RHEL
#                                  dnf. Off by default per ADR-0011.
#   PI_UPDATE=1                    Upgrade pi to latest (npm path only).
#   INSTALL_GIT_HOOKS=1            Symlink hooks/secrets-guard.sh into
#                                  .git/hooks/pre-commit AND
#                                  hooks/gh-identity-guard.sh into
#                                  .git/hooks/pre-push.

set -euo pipefail

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)
      sed -nE '/^# /{s/^# ?//;p;};/^$/q' "$0"
      exit 0
      ;;
    *)
      printf 'setup.sh: unknown flag: %s\n' "$1" >&2
      printf 'See: %s --help\n' "$0" >&2
      exit 2
      ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_LINK="${HOME}/.pi"
PI_PKG="@earendil-works/pi-coding-agent"
SETUP_LOCAL_ENV="${REPO_DIR}/setup.local.env"

# Optional persistent local defaults live in setup.local.env (ignored by git).
# Explicit shell env values supplied by the caller still win because this only
# populates unset variables.
load_local_setting() {
  local key="$1" line value rest

  if [ -n "${!key+x}" ]; then
    return 0
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    # Strip a trailing CR (CRLF files), then leading/trailing whitespace, so
    # an indented or space-padded assignment is not silently ignored.
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      ""|\#*) continue ;;
      export\ *)
        line="${line#export }"
        line="${line#"${line%%[![:space:]]*}"}"
        ;;
    esac

    # Only consider lines that target this key, tolerating whitespace around =.
    case "$line" in
      "$key"=*|"$key"[[:space:]]*=*) : ;;
      *) continue ;;
    esac

    rest="${line#"$key"}"
    rest="${rest#"${rest%%[![:space:]]*}"}"   # drop spaces before =
    value="${rest#=}"
    value="${value#"${value%%[![:space:]]*}"}" # drop spaces after =
    value="${value%"${value##*[![:space:]]}"}" # drop trailing spaces

    case "$value" in
      \"*\"|\'*\') value="${value#?}"; value="${value%?}" ;;
      \"*|*\"|\'*|*\')
        # Targets this key but the quoting is unbalanced — surface it rather
        # than assign a corrupted value. warn() is not defined this early, so
        # emit a convention-shaped WARN directly to stderr.
        printf 'WARN  [local-env] %s in %s has an unbalanced quote; ignoring line\n' \
          "$key" "${SETUP_LOCAL_ENV}" >&2
        continue
        ;;
    esac

    printf -v "$key" '%s' "$value"
    return 0
  done < "${SETUP_LOCAL_ENV}"
}

if [ -f "${SETUP_LOCAL_ENV}" ]; then
  load_local_setting PI_CONFIG_SET_DEFAULT_NODE
  load_local_setting INSTALL_GIT_HOOKS
fi

# Output helpers per agent/rules/script-output-conventions.md.
# 6-char fixed-width label column; bracket-labelled names for per-check
# results; INFO is bare (no bracket); ERROR goes to stderr. Counters drive
# the summary block at the end of the script.
errors=0
warnings=0

ok()    { printf 'OK    [%s] %s\n' "$1" "$2"; }
skip()  { printf 'SKIP  [%s] %s\n' "$1" "$2"; }
warn()  { printf 'WARN  [%s] %s\n' "$1" "$2"; warnings=$((warnings + 1)); }
info()  { printf 'INFO  %s\n' "$*"; }
err()   { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }
# die: hard failure. Prints ERROR, exits 1 immediately (does not reach the
# summary block). Two-arg form mirrors err(); single-arg legacy form is
# routed under the [setup] label for backward compatibility with callers
# below that pass a free-form message.
die()   {
  if [ $# -ge 2 ]; then
    err "$1" "$2"
  else
    err setup "$1"
  fi
  exit 1
}

resolve_path() {
  local path="$1"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$path" <<'PY'
import os
import sys
print(os.path.realpath(os.path.expanduser(sys.argv[1])))
PY
    return
  fi

  if command -v realpath >/dev/null 2>&1; then
    realpath "$path"
    return
  fi

  if command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
    readlink -f "$path"
    return
  fi

  return 1
}

# ---------------------------------------------------------------------------
# 1. Ensure Node.js / npm
#
# Default behavior: install nvm (from the agent/vendor/nvm/ pin) and Node 24.x
# via nvm. The previous check-and-die behavior is preserved when
# PI_CONFIG_SKIP_DEPS=1 is set, for users who manage their own toolchain.
# See ADR-0010.
# ---------------------------------------------------------------------------
info "Checking Node.js / npm"
if [ "${PI_CONFIG_SKIP_DEPS:-0}" = "1" ] || [ "${PI_CONFIG_SKIP_NVM:-0}" = "1" ]; then
  if [ "${PI_CONFIG_SKIP_DEPS:-0}" = "1" ]; then
    skip node "PI_CONFIG_SKIP_DEPS=1 — skipping dependency install; check-and-warn only"
  else
    skip node "PI_CONFIG_SKIP_NVM=1 — skipping nvm/node install; check-and-warn only"
  fi
  if ! command -v node >/dev/null 2>&1; then
    die node "node not found and PI_CONFIG_SKIP_DEPS=1 set; install Node 24.x via nvm and re-run."
  fi
  if ! command -v npm >/dev/null 2>&1; then
    die node "npm not found and PI_CONFIG_SKIP_DEPS=1 set; install npm and re-run."
  fi
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "${node_major}" -lt 20 ]; then
    warn node "node ${node_major}.x detected; pi recommends Node 20+ (24.x via nvm preferred)."
  else
    ok node "node $(node -v), npm $(npm -v)"
  fi
else
  # Active-install path per ADR-0010. Source the helpers, propagate --dry-run,
  # ensure nvm + Node 24.x.
  if [ ! -f "${REPO_DIR}/scripts/lib/install-helpers.sh" ]; then
    die node "install-helpers.sh missing at ${REPO_DIR}/scripts/lib/ — cannot install dependencies. Pass PI_CONFIG_SKIP_DEPS=1 to skip."
  fi
  # shellcheck source=scripts/lib/install-helpers.sh disable=SC1091
  . "${REPO_DIR}/scripts/lib/install-helpers.sh"
  ih_dry_run "${DRY_RUN}" >/dev/null
  if ! ih_ensure_nvm; then
    die node "ih_ensure_nvm failed (see ERROR lines above). Pass PI_CONFIG_SKIP_DEPS=1 to bypass."
  fi
  if ! ih_ensure_node 24; then
    die node "ih_ensure_node 24 failed (see ERROR lines above). Pass PI_CONFIG_SKIP_DEPS=1 to bypass."
  fi
  if [ "${DRY_RUN}" = "0" ] && command -v node >/dev/null 2>&1; then
    ok node "node $(node -v), npm $(npm -v)"
  fi
fi

# ---------------------------------------------------------------------------
# 1b. Ensure developer toolchain (gh, jq, yq, shellcheck, gitleaks,
#     markdownlint-cli2, yamllint)
#
# Per ADR-0011 § Decision Outcome (hybrid vendor + distro) and ADR-0037
# (gitleaks scanner). Vendor pins are sha256-verified from
# agent/vendor/{gh,yq,shellcheck,gitleaks}/CHECKSUMS. Distro
# installs (jq, yamllint) require PI_ALLOW_SUDO_APT=1 / PI_ALLOW_SUDO_DNF=1.
# markdownlint-cli2 installs via the nvm-managed npm from §1 (no sudo).
#
# Failures on individual tools are recorded as warnings, not fatal — a fresh
# host that lacks an unfamiliar distro path should still get gh + yq + the
# static-binary install (shellcheck) working. The summary reports how many
# failed.
# ---------------------------------------------------------------------------
info "Checking developer toolchain (per ADR-0011)"
if [ "${PI_CONFIG_SKIP_DEPS:-0}" = "1" ] || [ "${PI_CONFIG_SKIP_TOOLCHAIN:-0}" = "1" ]; then
  if [ "${PI_CONFIG_SKIP_DEPS:-0}" = "1" ]; then
    skip toolchain "PI_CONFIG_SKIP_DEPS=1 — skipping toolchain install"
  else
    skip toolchain "PI_CONFIG_SKIP_TOOLCHAIN=1 — skipping toolchain install"
  fi
else
  # install-helpers already sourced by §1 if we got here; re-source defensively
  # so the toolchain phase works even if a future contributor reorders or
  # narrows the §1 guard.
  if ! command -v ih_ensure_gh >/dev/null 2>&1; then
    # shellcheck source=scripts/lib/install-helpers.sh disable=SC1091
    . "${REPO_DIR}/scripts/lib/install-helpers.sh"
    ih_dry_run "${DRY_RUN}" >/dev/null
  fi
  toolchain_failed=0
  toolchain_gated=0
  for fn in ih_ensure_gh ih_ensure_yq ih_ensure_shellcheck ih_ensure_gitleaks ih_ensure_jq ih_ensure_yamllint ih_ensure_markdownlint_cli2; do
    set +e
    "$fn"
    rc=$?
    set -e
    case $rc in
      0) : ;;
      2)
        warn toolchain "${fn} blocked by policy gate (rc=2; likely PI_ALLOW_SUDO_APT / PI_ALLOW_SUDO_DNF closed)"
        toolchain_gated=$((toolchain_gated + 1))
        ;;
      *)
        warn toolchain "${fn} failed (rc=$rc; see ERROR/WARN above); continuing with remaining tools"
        toolchain_failed=$((toolchain_failed + 1))
        ;;
    esac
  done
  if [ "$toolchain_failed" -gt 0 ] || [ "$toolchain_gated" -gt 0 ]; then
    if [ "$toolchain_failed" -gt 0 ]; then
      warn toolchain "${toolchain_failed} tool(s) failed to install"
    fi
    if [ "$toolchain_gated" -gt 0 ]; then
      warn toolchain "${toolchain_gated} tool(s) blocked by sudo policy gate"
      warn toolchain "  re-run with PI_ALLOW_SUDO_APT=1 / PI_ALLOW_SUDO_DNF=1 to allow distro installs"
    fi
    warn toolchain "  or set PI_CONFIG_SKIP_TOOLCHAIN=1 to suppress this phase"
  else
    ok toolchain "all seven tools accounted for"
  fi
  # PATH advisory for the vendored binaries.
  # shellcheck disable=SC2088  # literal user-facing ~/.local/bin string
  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) : ;;
    *) warn toolchain "~/.local/bin is not on PATH; add it to your shell rc so the vendored gh/yq/shellcheck are usable." ;;
  esac
  # Install the repo-agnostic secret scanner as ~/.local/bin/scan-secrets so a
  # single copy serves every repo (each supplies its own .gitleaks.toml). The
  # symlink targets the live repo file, so `git pull` updates the tool. ADR-0048.
  if _ih_link_local_bin "${REPO_DIR}/scripts/scan-secrets.sh" scan-secrets; then
    ok toolchain "scan-secrets installed to ~/.local/bin/scan-secrets"
  else
    warn toolchain "failed to install scan-secrets to ~/.local/bin"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Install or update pi
#
# Two paths:
#   - Default (PI_USE_VENDORED unset or any value other than '0'):
#     source scripts/lib/fetch-pi-binary.sh (ADR-0009), fetch the
#     pinned binary from agent/vendor/pi/, sha256-verify, and symlink
#     it into ~/.local/bin/pi (creating the dir if missing). The user
#     is responsible for having ~/.local/bin on PATH; we warn if not.
#   - PI_USE_VENDORED=0: `npm install -g @earendil-works/pi-coding-agent`
#     (legacy). Preserved indefinitely as the opt-out per ADR-0012;
#     no removal scheduled.
#
# Both paths honor --dry-run and PI_CONFIG_SKIP_DEPS=1.
# ---------------------------------------------------------------------------
info "Checking pi installation"
if [ "${PI_USE_VENDORED:-1}" != "0" ]; then
  # Vendored path (ADR-0009 + ADR-0010 § Pi acquisition).
  if [ "${PI_CONFIG_SKIP_DEPS:-0}" = "1" ]; then
    warn pi "vendored pi path (default) and PI_CONFIG_SKIP_DEPS=1 are both active; PI_CONFIG_SKIP_DEPS wins."
    warn pi "Skipping vendored pi fetch; checking PATH only."
    if command -v pi >/dev/null 2>&1; then
      ok pi "pi already on PATH ($(pi --version 2>&1 | head -n1))"
    else
      warn pi "pi not on PATH and PI_CONFIG_SKIP_DEPS=1 set; install manually or unset PI_CONFIG_SKIP_DEPS."
    fi
  else
    if [ ! -f "${REPO_DIR}/scripts/lib/fetch-pi-binary.sh" ]; then
      die pi "fetch-pi-binary.sh missing at ${REPO_DIR}/scripts/lib/ — cannot use default vendored path. Set PI_USE_VENDORED=0 to fall back to npm."
    fi
    # shellcheck source=scripts/lib/fetch-pi-binary.sh disable=SC1091
    . "${REPO_DIR}/scripts/lib/fetch-pi-binary.sh"
    info "fetching pinned pi binary per ADR-0009 (default since ADR-0012; set PI_USE_VENDORED=0 to opt out)"
    local_bin="${HOME}/.local/bin"
    pi_link="${local_bin}/pi"
    if [ "${DRY_RUN}" = "1" ]; then
      info "[dry-run] fetch_pi_binary  # would download + sha256-verify per agent/vendor/pi/CHECKSUMS"
      info "[dry-run] mkdir -p ${local_bin}"
      info "[dry-run] ln -sf <vendored-pi-path> ${pi_link}"
    else
      if ! pi_path="$(fetch_pi_binary)"; then
        die pi "fetch_pi_binary failed (see ERROR lines above)."
      fi
      if [ -z "$pi_path" ] || [ ! -x "$pi_path" ]; then
        die pi "fetch_pi_binary returned an unexpected path: $pi_path"
      fi
      mkdir -p "${local_bin}"
      if [ -L "${pi_link}" ] && [ "$(resolve_path "${pi_link}")" = "$pi_path" ]; then
        # shellcheck disable=SC2088  # literal user-facing path, not for shell expansion
        ok pi "~/.local/bin/pi already symlinked to vendored binary"
      else
        # Detect pre-existing entry and back it up rather than silently clobber
        # (parallel to §3's pattern for ~/.pi and §5's pattern for pre-commit).
        if [ -e "${pi_link}" ] || [ -L "${pi_link}" ]; then
          backup="${pi_link}.preinstall.$(date +%s)"
          mv "${pi_link}" "${backup}"
          warn pi "existing ${pi_link} backed up to ${backup}"
        fi
        ln -s "$pi_path" "${pi_link}"
        ok pi "symlinked ${pi_link} -> $pi_path"
      fi
      ok pi "pi (vendored) installed: $("$pi_path" --version 2>&1 | head -n1)"
      case ":${PATH}:" in
        *":${local_bin}:"*) : ;;
        *) warn pi "${local_bin} is not on PATH; add it to your shell rc to use the vendored pi." ;;
      esac
    fi
  fi
else
  # PI_USE_VENDORED=0 — legacy npm install path, preserved as the opt-out
  # per ADR-0012. No removal is scheduled; this branch is supported
  # indefinitely for environments that prefer npm-managed installs (e.g.
  # corporate networks that proxy npmjs.org but block github.com release
  # assets, or users who want pip-style auto-updates via `npm update`).
  info "PI_USE_VENDORED=0 — using legacy npm install path (vendored is default; see ADR-0012)"
  if [ "${PI_CONFIG_SKIP_DEPS:-0}" = "1" ]; then
    warn pi "PI_USE_VENDORED=0 and PI_CONFIG_SKIP_DEPS=1 are both set; PI_CONFIG_SKIP_DEPS wins."
    warn pi "Skipping npm install -g ${PI_PKG}; checking PATH only."
    if command -v pi >/dev/null 2>&1; then
      ok pi "pi already on PATH ($(pi --version 2>&1 | head -n1))"
    else
      warn pi "pi not on PATH and PI_CONFIG_SKIP_DEPS=1 set; install manually or unset PI_CONFIG_SKIP_DEPS."
    fi
  elif command -v pi >/dev/null 2>&1; then
    current="$(pi --version 2>&1 | head -n1 || echo unknown)"
    ok pi "pi already installed (${current})"
    if [ "${PI_UPDATE:-0}" = "1" ]; then
      info "PI_UPDATE=1 set — upgrading pi"
      if [ "${DRY_RUN}" = "1" ]; then
        info "[dry-run] npm install -g ${PI_PKG}"
      else
        npm install -g "${PI_PKG}"
        ok pi "pi upgraded to $(pi --version 2>&1 | head -n1)"
      fi
    fi
  else
    info "Installing pi via: npm install -g ${PI_PKG}"
    if [ "${DRY_RUN}" = "1" ]; then
      if [ "${PI_ALLOW_SUDO_NPM:-0}" = "1" ]; then
        info "[dry-run] npm install -g ${PI_PKG}  # (sudo fallback enabled via PI_ALLOW_SUDO_NPM=1)"
      else
        info "[dry-run] npm install -g ${PI_PKG}"
      fi
    else
      if ! npm install -g "${PI_PKG}"; then
        if [ "${PI_ALLOW_SUDO_NPM:-0}" = "1" ]; then
          warn pi "Global install failed (likely permissions)."
          warn pi "Retrying with sudo (PI_ALLOW_SUDO_NPM=1). Cancel with Ctrl+C if undesired."
          sudo npm install -g "${PI_PKG}"
        else
          die pi "npm install -g ${PI_PKG} failed (likely permissions). Re-run with PI_ALLOW_SUDO_NPM=1 to allow sudo, or use the nvm-managed npm from the active-install path, or (recommended) unset PI_USE_VENDORED (or set it to 1) to use the default vendored binary path (ADR-0009 / ADR-0012)."
        fi
      fi
      ok pi "pi installed: $(pi --version 2>&1 | head -n1)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 2c. Seed operator runtime config from templates (ADR-0049)
#
# agent/settings.json and agent/models.json are operator-owned and gitignored;
# the repo tracks generic *.example templates instead. On first install (or any
# time the live file is absent) we seed it from its template so a fresh checkout
# has a working config without inheriting anyone's personal provider/model/theme
# choices. An existing live file is never overwritten — operator config wins.
# ---------------------------------------------------------------------------
info "Seeding operator runtime config from templates (per ADR-0049)"
for cfg in settings models; do
  live="${REPO_DIR}/agent/${cfg}.json"
  tmpl="${REPO_DIR}/agent/${cfg}.example.json"
  if [ -f "${live}" ]; then
    ok config "agent/${cfg}.json present; leaving operator config untouched"
  elif [ ! -f "${tmpl}" ]; then
    warn config "template ${tmpl} missing; cannot seed agent/${cfg}.json"
  elif [ "${DRY_RUN}" = "1" ]; then
    info "[dry-run] cp ${tmpl} ${live}"
  else
    cp "${tmpl}" "${live}"
    ok config "seeded agent/${cfg}.json from ${cfg}.example.json"
  fi
done

# ---------------------------------------------------------------------------
# 3. Link ~/.pi -> this repo
# ---------------------------------------------------------------------------
info "Linking ${PI_LINK} -> ${REPO_DIR}"

if [ -L "${PI_LINK}" ]; then
  current_target="$(resolve_path "${PI_LINK}")" || die pi-symlink "could not resolve ${PI_LINK}; install python3 or coreutils realpath"
  if [ "${current_target}" = "${REPO_DIR}" ]; then
    ok pi-symlink "symlink already points at this repo"
  else
    warn pi-symlink "symlink points elsewhere: ${current_target}"
    if [ "${DRY_RUN}" = "1" ]; then
      info "[dry-run] rm ${PI_LINK}"
      info "[dry-run] ln -s ${REPO_DIR} ${PI_LINK}"
    else
      warn pi-symlink "removing and re-linking"
      rm "${PI_LINK}"
      ln -s "${REPO_DIR}" "${PI_LINK}"
      ok pi-symlink "relinked"
    fi
  fi
elif [ -e "${PI_LINK}" ]; then
  # Real directory exists — migrate runtime data into the repo, then swap.
  info "${PI_LINK} exists as a real directory; migrating runtime data"
  if [ "${DRY_RUN}" = "1" ]; then
    info "[dry-run] mkdir -p ${REPO_DIR}/agent"
    for item in auth.json bin sessions; do
      src="${PI_LINK}/agent/${item}"
      dst="${REPO_DIR}/agent/${item}"
      if [ -e "${src}" ] && [ ! -e "${dst}" ]; then
        info "[dry-run] mv ${src} ${dst}"
      fi
    done
    info "[dry-run] (settings.json compare + backup if differs)"
    info "[dry-run] (models.json compare + backup if differs)"
    info "[dry-run] mv ${PI_LINK} ${HOME}/.pi.preinstall.<ts>"
    info "[dry-run] ln -s ${REPO_DIR} ${PI_LINK}"
  else
    mkdir -p "${REPO_DIR}/agent"
    for item in auth.json bin sessions; do
      src="${PI_LINK}/agent/${item}"
      dst="${REPO_DIR}/agent/${item}"
      if [ -e "${src}" ] && [ ! -e "${dst}" ]; then
        mv "${src}" "${dst}"
        ok pi-symlink "moved agent/${item} into repo"
      elif [ -e "${src}" ] && [ -e "${dst}" ]; then
        warn pi-symlink "agent/${item} exists in both; leaving ${src} in place"
      fi
    done
    # If the existing ~/.pi/agent/settings.json differs from the repo's, back it up.
    if [ -f "${PI_LINK}/agent/settings.json" ] && \
       ! cmp -s "${PI_LINK}/agent/settings.json" "${REPO_DIR}/agent/settings.json" 2>/dev/null; then
      backup="${PI_LINK}/agent/settings.json.preinstall.$(date +%s)"
      mv "${PI_LINK}/agent/settings.json" "${backup}"
      warn pi-symlink "existing settings.json differed from repo's; backed up to ${backup}"
    fi
    # Same for models.json. The repo ships a framework-shaped models.json
    # (see ADR-0026); preserve any pre-existing operator overrides.
    if [ -f "${PI_LINK}/agent/models.json" ] && \
       ! cmp -s "${PI_LINK}/agent/models.json" "${REPO_DIR}/agent/models.json" 2>/dev/null; then
      backup="${PI_LINK}/agent/models.json.preinstall.$(date +%s)"
      mv "${PI_LINK}/agent/models.json" "${backup}"
      warn pi-symlink "existing models.json differed from repo's; backed up to ${backup}"
    fi
    # Move any unexpected leftovers aside before removing.
    leftover_backup="${HOME}/.pi.preinstall.$(date +%s)"
    mv "${PI_LINK}" "${leftover_backup}"
    warn pi-symlink "moved previous ${PI_LINK} to ${leftover_backup} (review/remove later)"
    ln -s "${REPO_DIR}" "${PI_LINK}"
    ok pi-symlink "linked"
  fi
else
  if [ "${DRY_RUN}" = "1" ]; then
    info "[dry-run] ln -s ${REPO_DIR} ${PI_LINK}"
  else
    ln -s "${REPO_DIR}" "${PI_LINK}"
    ok pi-symlink "linked"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Sanity check discovery
# ---------------------------------------------------------------------------
info "Verifying pi-discoverable resources"

if [ "${DRY_RUN}" = "1" ] && [ ! -e "${PI_LINK}" ]; then
  # In dry-run mode the symlink wasn't actually created, so the discovery
  # checks would find nothing and (under set -euo pipefail) the find
  # pipelines themselves would abort the script. Skip the section
  # cleanly so the summary block still emits.
  skip discovery "DRY_RUN=1 and ${PI_LINK} not present; skipping discovery checks"
else
  skill_count="$(find "${PI_LINK}/agent/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${skill_count}" -gt 0 ]; then
    ok skills "${skill_count} skill(s) under ~/.pi/agent/skills"
  else
    warn skills "no SKILL.md files found under ~/.pi/agent/skills"
  fi

  agent_count="$(find "${PI_LINK}/agent/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${agent_count}" -gt 0 ]; then
    ok agents "${agent_count} agent wrapper(s) under ~/.pi/agent/agents"
  else
    warn agents "no agent wrappers found under ~/.pi/agent/agents (subagent extension will report 'none')"
  fi

  prompt_count="$(find "${PI_LINK}/agent/prompts" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${prompt_count}" -gt 0 ]; then
    ok prompts "${prompt_count} prompt template(s) under ~/.pi/agent/prompts (slash commands)"
  fi

  rule_count="$(find "${PI_LINK}/agent/rules" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${rule_count}" -gt 0 ]; then
    ok rules "${rule_count} rule(s) under ~/.pi/agent/rules (referenced from AGENTS.md)"
  fi

  ext_count="$(find "${PI_LINK}/agent/extensions" -mindepth 2 -maxdepth 2 -name 'index.ts' 2>/dev/null | wc -l | tr -d ' ')"
  ext_count_flat="$(find "${PI_LINK}/agent/extensions" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')"
  ext_total=$((ext_count + ext_count_flat))
  if [ "${ext_total}" -gt 0 ]; then
    ok extensions "${ext_total} extension(s) under ~/.pi/agent/extensions"
  fi

  if [ -f "${PI_LINK}/agent/AGENTS.md" ]; then
    # shellcheck disable=SC2088  # literal user-facing path, not for shell expansion
    ok agents-md "~/.pi/agent/AGENTS.md present (orchestration playbook in context)"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Optional: install the secrets-guard git pre-commit hook AND the
#    gh-identity-guard git pre-push hook into THIS repo.
# ---------------------------------------------------------------------------
if [ "${INSTALL_GIT_HOOKS:-0}" = "1" ]; then
  info "INSTALL_GIT_HOOKS=1 — installing git hooks in ${REPO_DIR}"
  HOOK_SRC="${REPO_DIR}/hooks/secrets-guard.sh"
  HOOK_DST="${REPO_DIR}/.git/hooks/pre-commit"
  if [ ! -f "${HOOK_SRC}" ]; then
    warn git-hook "hook source ${HOOK_SRC} missing; skipping"
  elif [ ! -d "${REPO_DIR}/.git" ]; then
    warn git-hook "${REPO_DIR}/.git not present; not a git checkout, skipping"
  else
    if [ -L "${HOOK_DST}" ] && [ "$(resolve_path "${HOOK_DST}")" = "${HOOK_SRC}" ]; then
      ok git-hook "pre-commit hook already linked"
    elif [ "${DRY_RUN}" = "1" ]; then
      if [ -e "${HOOK_DST}" ]; then
        info "[dry-run] mv ${HOOK_DST} ${HOOK_DST}.preinstall.<ts>"
      fi
      info "[dry-run] ln -s ${HOOK_SRC} ${HOOK_DST}"
    elif [ -e "${HOOK_DST}" ]; then
      backup="${HOOK_DST}.preinstall.$(date +%s)"
      mv "${HOOK_DST}" "${backup}"
      warn git-hook "existing pre-commit backed up to ${backup}"
      ln -s "${HOOK_SRC}" "${HOOK_DST}"
      ok git-hook "pre-commit hook linked"
    else
      ln -s "${HOOK_SRC}" "${HOOK_DST}"
      ok git-hook "pre-commit hook linked"
    fi
  fi

  # gh-identity-guard pre-push (companion to the pi extension, per ADR-0022)
  PP_SRC="${REPO_DIR}/hooks/gh-identity-guard.sh"
  PP_DST="${REPO_DIR}/.git/hooks/pre-push"
  if [ ! -f "${PP_SRC}" ]; then
    warn git-hook "hook source ${PP_SRC} missing; skipping pre-push"
  elif [ ! -d "${REPO_DIR}/.git" ]; then
    : # already warned above
  else
    if [ -L "${PP_DST}" ] && [ "$(resolve_path "${PP_DST}")" = "${PP_SRC}" ]; then
      ok git-hook "pre-push hook already linked"
    elif [ "${DRY_RUN}" = "1" ]; then
      if [ -e "${PP_DST}" ]; then
        info "[dry-run] mv ${PP_DST} ${PP_DST}.preinstall.<ts>"
      fi
      info "[dry-run] ln -s ${PP_SRC} ${PP_DST}"
    elif [ -e "${PP_DST}" ]; then
      pp_backup="${PP_DST}.preinstall.$(date +%s)"
      mv "${PP_DST}" "${pp_backup}"
      warn git-hook "existing pre-push backed up to ${pp_backup}"
      ln -s "${PP_SRC}" "${PP_DST}"
      ok git-hook "pre-push hook linked"
    else
      ln -s "${PP_SRC}" "${PP_DST}"
      ok git-hook "pre-push hook linked"
    fi
  fi
else
  skip git-hook "INSTALL_GIT_HOOKS not set; pre-commit + pre-push hooks not installed (set =1 to opt in)"
fi

# Next-steps footer is printed BEFORE the summary block so that the
# PASS/FAIL summary remains the terminal output of the script (the rule's
# expected contract for CI parsers and for the smoke-test summary-line grep).
echo
info "pi_config setup complete."
echo "Next steps:"
echo "  1. Run: pi"
echo "  2. If first run, authenticate:  /login"
echo "  3. List skills:                 type '/skill:' and tab-complete"
echo
echo "Re-run this script anytime. Set PI_UPDATE=1 to upgrade pi to latest."

# ---------------------------------------------------------------------------
# Summary block per agent/rules/script-output-conventions.md.
# Reached only on the success path; die() exits with errors=1 before getting
# here, which is appropriate since hard failures abort the install mid-flight
# rather than continuing into the next-steps footer.
# ---------------------------------------------------------------------------
echo
echo "=================================="
if [ "$errors" -gt 0 ]; then
  echo "FAIL — $errors errors, $warnings warnings"
  exit 1
fi
echo "PASS — $errors errors, $warnings warnings"
