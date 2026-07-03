#!/usr/bin/env bash
#
# scan-secrets.sh — repo-agnostic gitleaks secret-scanning wrapper.
#
# Modes (choose exactly one):
#   --working-tree            Scan git-tracked working-tree files.
#   --history [--all-refs]    Scan git history reachable from HEAD (or all refs).
#   --range OLD..NEW          Scan only the commits introduced by the range
#                             OLD..NEW (e.g. an upstream-sync import range).
#   --self-test               Run internal assertions; needs neither gitleaks
#                             nor a git repo. Used as a validate.sh gate.
#
# Options:
#   --repo-dir DIR            Target repository (default: the git toplevel of the
#                             current directory). Makes the script repo-agnostic
#                             so a single installed copy serves every repo.
#   --config PATH             gitleaks config (default: <repo>/.gitleaks.toml when
#                             present; otherwise gitleaks' built-in defaults).
#   --report-path PATH        JSON report path (default: a repo-scoped path under
#                             ~/.cache/scan-secrets/<repo-slug>/).
#
# Exit codes:
#   0 — clean
#   1 — findings detected
#   2 — environment / invocation failure
#
# This script is installed standalone as ~/.local/bin/scan-secrets (a symlink to
# this file), so it defines its output helpers inline rather than sourcing
# scripts/lib/log.sh — it cannot assume the repo tree is on disk relative to the
# invocation. This mirrors the constraint documented for .psmfd/sync-upstream.sh
# (script-output-conventions).

set -euo pipefail
umask 077

# --- Output helpers (inline; standalone-install constraint above) ------------
# The full helper set is kept for convention parity (script-output-conventions);
# skip() is unused in this script but retained as part of the standard block.
ok()    { printf 'OK    [%s] %s\n' "$1" "$2"; }
# shellcheck disable=SC2329  # retained for convention parity; not invoked here
skip()  { printf 'SKIP  [%s] %s\n' "$1" "$2"; }
warn()  { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; }
info()  { printf 'INFO  %s\n' "$*"; }
err()   { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }
detail(){ [ "${VERBOSE:-0}" = "1" ] && printf '      %s\n' "$*" || true; }

mode=""
all_refs=0
report_path=""
repo_dir=""
config_path=""
range_spec=""

usage() {
  cat <<'EOF'
Usage:
  scan-secrets (--working-tree | --history [--all-refs] | --range OLD..NEW)
               [--repo-dir DIR] [--config PATH] [--report-path PATH]
  scan-secrets --self-test

Runs gitleaks with redacted output and maps exit codes into the 0/1/2 script
convention. --working-tree scans git-tracked files only (untracked/ignored
runtime files such as auth.json are intentionally out of scope). --range scans
the commits in OLD..NEW; a null OLD (all-zero SHA, e.g. a first push or
force-push base) falls back to scanning all history reachable from NEW.
EOF
}

# --- Helpers used by both the run path and --self-test -----------------------

# A null git object id: 7-40 zeros (short or full all-zero SHA).
is_null_sha() {
  case "$1" in
    "" ) return 1 ;;
    *[!0]* ) return 1 ;;   # contains a non-zero character
    * )
      # all zeros: accept 7..40 in length
      local n=${#1}
      [ "$n" -ge 7 ] && [ "$n" -le 40 ]
      ;;
  esac
}

# A valid range spec contains a ".." separator with non-empty endpoints.
# (git's two-dot and three-dot forms both satisfy this; gitleaks passes the
# spec to `git log` via --log-opts unchanged.)
validate_range_spec() {
  case "$1" in
    *..*) ;;
    *) return 1 ;;
  esac
  local left="${1%%..*}" right="${1##*..}"
  [ -n "$left" ] && [ -n "$right" ]
}

run_self_test() {
  local fails=0
  _assert() { # desc, expected(0/1 for pass/fail of the cmd), cmd...
    local desc="$1" want="$2"; shift 2
    if "$@"; then local got=0; else local got=1; fi
    if [ "$got" = "$want" ]; then
      ok "self-test" "$desc"
    else
      err "self-test" "$desc (wanted rc-class $want, got $got)"
      fails=$((fails + 1))
    fi
  }
  _assert "range a..b accepted"            0 validate_range_spec "a..b"
  _assert "range OLD..refs/x accepted"     0 validate_range_spec "deadbeef..refs/upstream/tags/v1.0.0"
  _assert "bare SHA rejected"              1 validate_range_spec "deadbeef"
  _assert "empty left rejected"            1 validate_range_spec "..b"
  _assert "empty right rejected"           1 validate_range_spec "a.."
  _assert "all-zero short SHA is null"     0 is_null_sha "0000000"
  _assert "all-zero 40 SHA is null"        0 is_null_sha "0000000000000000000000000000000000000000"
  _assert "real SHA is not null"           1 is_null_sha "b1d954aa"
  _assert "empty is not null"              1 is_null_sha ""
  printf '==================================\n'
  if [ "$fails" -eq 0 ]; then
    printf 'PASS — 0 errors, 0 warnings\n'; return 0
  fi
  printf 'FAIL — %d errors, 0 warnings\n' "$fails"; return 1
}

# --- Argument parsing --------------------------------------------------------

set_mode() {
  [ -z "$mode" ] || { err "scan-secrets" "choose exactly one mode"; exit 2; }
  mode="$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --working-tree) set_mode working-tree; shift ;;
    --history)      set_mode history; shift ;;
    --range)
      set_mode range
      [ $# -ge 2 ] || { err "scan-secrets" "--range requires an OLD..NEW argument"; exit 2; }
      range_spec="$2"; shift 2 ;;
    --self-test)    set_mode self-test; shift ;;
    --all-refs)     all_refs=1; shift ;;
    --repo-dir)
      [ $# -ge 2 ] || { err "scan-secrets" "--repo-dir requires an argument"; exit 2; }
      repo_dir="$2"; shift 2 ;;
    --config)
      [ $# -ge 2 ] || { err "scan-secrets" "--config requires an argument"; exit 2; }
      config_path="$2"; shift 2 ;;
    --report-path)
      [ $# -ge 2 ] || { err "scan-secrets" "--report-path requires an argument"; exit 2; }
      report_path="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) err "scan-secrets" "unknown option: $1"; usage >&2; exit 2 ;;
  esac
done

if [ -z "$mode" ]; then
  err "scan-secrets" "choose --working-tree, --history, --range, or --self-test"
  usage >&2
  exit 2
fi

# Self-test is hermetic: no repo, no config, no gitleaks needed.
if [ "$mode" = "self-test" ]; then
  run_self_test
  exit $?
fi

if [ "$all_refs" = "1" ] && [ "$mode" != "history" ]; then
  err "scan-secrets" "--all-refs only applies with --history"
  exit 2
fi

if ! command -v gitleaks >/dev/null 2>&1; then
  err "scan-secrets" "gitleaks not found on PATH; run ./setup.sh or ih_ensure_gitleaks"
  exit 2
fi

# --- Resolve target repository (repo-agnostic) -------------------------------
if [ -z "$repo_dir" ]; then
  repo_dir="$(git -C "$(pwd)" rev-parse --show-toplevel 2>/dev/null)" \
    || { err "scan-secrets" "not inside a git working tree; pass --repo-dir DIR"; exit 2; }
fi
[ -d "$repo_dir" ] || { err "scan-secrets" "--repo-dir does not exist: $repo_dir"; exit 2; }
cd "$repo_dir" || { err "scan-secrets" "cannot cd to $repo_dir"; exit 2; }
repo_dir="$(pwd)"   # normalize to absolute

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "scan-secrets" "$repo_dir is not a git working tree"
  exit 2
fi

# --- Resolve config (per-repo .gitleaks.toml stays authoritative) ------------
if [ -z "$config_path" ] && [ -f "$repo_dir/.gitleaks.toml" ]; then
  config_path="$repo_dir/.gitleaks.toml"
fi

# --- Resolve report path (repo-scoped cache) ---------------------------------
if [ -z "$report_path" ]; then
  repo_slug="$(basename "$repo_dir")"
  report_path="$HOME/.cache/scan-secrets/$repo_slug/gitleaks-$(date +%Y%m%d%H%M%S).json"
fi
mkdir -p "$(dirname "$report_path")" || {
  err "scan-secrets" "cannot create report directory for $report_path"
  exit 2
}

common=(--no-banner --redact=100 --report-format=json --report-path "$report_path" --exit-code=99)
if [ -n "$config_path" ]; then
  [ -f "$config_path" ] || { err "scan-secrets" "--config not found: $config_path"; exit 2; }
  common+=(--config "$config_path")
  detail "using config: $config_path"
else
  detail "no .gitleaks.toml found; using gitleaks built-in defaults"
fi

# A full clone is required for any history-walking mode.
require_full_clone() {
  local shallow
  shallow="$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)"
  case "$shallow" in
    false) ;;
    true)  err "scan-secrets" "$1 requires a full clone (not shallow)"; exit 2 ;;
    *)     err "scan-secrets" "cannot determine whether repository is shallow"; exit 2 ;;
  esac
}

rc=0
case "$mode" in
  working-tree)
    if ! command -v python3 >/dev/null 2>&1; then
      err "scan-secrets" "--working-tree requires python3 to copy tracked files safely"
      exit 2
    fi
    tmp_scan_dir="$(mktemp -d "${TMPDIR:-/tmp}/scan-secrets-tracked.XXXXXXXX")" \
      || { err "scan-secrets" "mktemp failed"; exit 2; }
    tracked_root="$tmp_scan_dir/tracked"
    mkdir -p "$tracked_root" || { err "scan-secrets" "cannot create tracked-file scan dir"; exit 2; }
    tracked_list="$tmp_scan_dir/tracked-files.z"
    git ls-files -z > "$tracked_list" || { err "scan-secrets" "git ls-files failed"; exit 2; }
    python3 - "$tracked_root" "$tracked_list" <<'PY'
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1])
tracked_list = pathlib.Path(sys.argv[2])
data = tracked_list.read_bytes().split(b"\0")
for raw in data:
    if not raw:
        continue
    rel = raw.decode("utf-8", "surrogateescape")
    src = pathlib.Path(rel)
    if src.is_symlink():
        continue
    if not src.is_file():
        continue
    dst = root / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
PY
    info "scan-secrets: gitleaks dir <git-tracked-files>"
    set +e
    gitleaks dir "${common[@]}" "$tracked_root"
    rc=$?
    set -e
    rm -rf "$tmp_scan_dir"
    ;;
  history)
    require_full_clone --history
    if [ "$all_refs" = "1" ]; then
      info "scan-secrets: gitleaks git --log-opts=--all ."
      set +e; gitleaks git "${common[@]}" --log-opts="--all" .; rc=$?; set -e
    else
      info "scan-secrets: gitleaks git ."
      set +e; gitleaks git "${common[@]}" .; rc=$?; set -e
    fi
    ;;
  range)
    validate_range_spec "$range_spec" \
      || { err "scan-secrets" "--range argument must be OLD..NEW (got: $range_spec)"; exit 2; }
    require_full_clone --range
    old="${range_spec%%..*}"
    new="${range_spec##*..}"
    if is_null_sha "$old"; then
      warn "scan-secrets" "null OLD endpoint; scanning all history reachable from $new"
      log_opts="$new"
    else
      log_opts="$range_spec"
    fi
    info "scan-secrets: gitleaks git --log-opts=$log_opts ."
    set +e; gitleaks git "${common[@]}" --log-opts="$log_opts" .; rc=$?; set -e
    ;;
  *)
    err "scan-secrets" "internal invalid mode: $mode"; exit 2 ;;
esac

if [ -f "$report_path" ]; then
  chmod 600 "$report_path" 2>/dev/null || true
fi

case "$rc" in
  0)  ok "scan-secrets" "no findings (report: $report_path)"; exit 0 ;;
  99) err "scan-secrets" "findings detected (redacted report: $report_path)"; exit 1 ;;
  *)  err "scan-secrets" "gitleaks failed with rc=$rc (report: $report_path)"; exit 2 ;;
esac
