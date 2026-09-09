#!/usr/bin/env bash
# A2/P4 fail-closed native-preflight tests (ADR-0156, ADR-0159).
#
# Two kinds of leg:
#   - seam legs drive preflightInstalledRuntime() through the exported test
#     seam with a fake database. They prove the preflight refuses each bad
#     tree/runtime tuple with a stable P4_* code. The seam carries no loader,
#     so their loader_calls=0 is a property of the seam, not an observation
#     about the production initializer.
#   - production legs (Linux ARM64 only, against the real passwd-home
#     installation) drive loadExpertiseNativeRuntime() with a real bun:sqlite
#     connection. They are the only behavioural evidence for exact-once loading,
#     the attempt latch, and SQL-loader denial on the production path.
#
# Usage: scripts/test-p4-native-preflight.sh
#   GUARD_MUTATION_ID=<id>   run only the legs registered for that mutation in
#                            scripts/guard-mutations.json (plus ARM64 production
#                            evidence for the loader mutations)
#   P4_TEST_ROOT=<dir>       sole scratch parent (no fallback); every ancestor
#                            must be root- or self-owned and not group/world
#                            writable
#   PI_BIN=<path>            pi executable (default: the pinned cache copy)
# Exit codes: 0 pass, 1 leg failure, 2 environment/precondition failure.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
version="$(head -n 1 "$repo_root/agent/vendor/pi/VERSION" | tr -d '[:space:]')"
pi_cache="${XDG_CACHE_HOME:-$HOME/.cache}/pi_config/pi-${version}/pi/pi"
pi_bin="${PI_BIN:-}"
if [ -z "$pi_bin" ]; then
  if [ -x "$pi_cache" ]; then pi_bin="$pi_cache"; else pi_bin="$(command -v pi || true)"; fi
fi
fixture="$repo_root/scripts/fixtures/p4-native-preflight/probe-extension.mjs"
p3_driver="$repo_root/scripts/fixtures/p3-expertise-runtime/install-test-driver.py"
p3_installer="$repo_root/scripts/install-expertise-runtime.py"
manifest="$repo_root/agent/vendor/expertise-runtime/linux-arm64-v1.json"
archive="$repo_root/scripts/fixtures/p3-expertise-runtime/sqlite-vec-0.1.9-loadable-linux-aarch64.tar.gz"
registry="$repo_root/scripts/guard-mutations.json"
source_file="$repo_root/agent/extensions/shared/expertise-native-runtime.ts"
errors=0
warnings=0
legs=0
scratch=""
mutation_id="${GUARD_MUTATION_ID:-}"

ok() { legs=$((legs + 1)); printf 'OK    [%s] %s\n' "$1" "$2"; }
fail() { legs=$((legs + 1)); errors=$((errors + 1)); printf 'ERROR [%s] %s\nnot ok 1 - %s\n' "$1" "$2" "$1" >&2; }
skip() { legs=$((legs + 1)); printf 'SKIP  [%s] %s\n' "$1" "$2"; }
env_error() { printf 'ERROR [env] %s\n' "$1" >&2; }
finish() {
  printf '%s\n' '=================================='
  if [ "$errors" -eq 0 ]; then
    printf 'PASS — 0 errors, %d warnings, %d legs\n' "$warnings" "$legs"
    exit 0
  fi
  printf 'FAIL — %d errors, %d warnings, %d legs\n' "$errors" "$warnings" "$legs"
  exit 1
}
# Invoked indirectly by trap.
# shellcheck disable=SC2329
cleanup() { [ -z "$scratch" ] || rm -rf -- "$scratch"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

for tool in python3 jq node id; do
  command -v "$tool" >/dev/null 2>&1 || { env_error "required tool unavailable: $tool"; exit 2; }
done
[ -x "$pi_bin" ] || { env_error "pinned pi executable unavailable"; exit 2; }
[ -f "$fixture" ] || { env_error "P4 fixture extension missing"; exit 2; }
[ -f "$registry" ] || { env_error "guard-mutation registry missing"; exit 2; }
node --check "$fixture" || { env_error "P4 fixture extension has invalid syntax"; exit 2; }

# --- mutation mapping, derived from the registry (never a second hand-kept list)
p4_mutation_ids="$(jq -r --arg suite scripts/test-p4-native-preflight.sh \
  '.mutations[] | select(.suite == $suite) | .id' "$registry")"
enabled_legs=""
if [ -n "$mutation_id" ]; then
  if ! printf '%s\n' "$p4_mutation_ids" | grep -Fxq "$mutation_id"; then
    env_error "GUARD_MUTATION_ID is not registered for this suite: $mutation_id"
    exit 2
  fi
  if git -C "$repo_root" diff --quiet HEAD -- agent/extensions/shared/expertise-native-runtime.ts; then
    env_error "GUARD_MUTATION_ID requires an active mutation of the P4 implementation"
    exit 2
  fi
  enabled_legs="$(jq -r --arg id "$mutation_id" \
    '.mutations[] | select(.id == $id) | .expectFailing[]' "$registry")"
fi
scenario_enabled() {
  [ -z "$mutation_id" ] && return 0
  printf '%s\n' "$enabled_legs" | grep -Fxq "$1"
}
# The three loader guards have no portable behavioural leg: their registered
# expectation is structural. On the ARM64 target the matching production leg
# runs as additional behavioural evidence and must go red too.
production_evidence_for() {
  case "$1" in
    p4-single-loader-call) printf 'production_load\n' ;;
    p4-load-attempt-latch-order) printf 'production_loader_failure_retry\n' ;;
    p4-sql-loader-denial) printf 'production_sql_loader_enabled\nproduction_sql_loader_state\n' ;;
    *) : ;;
  esac
}
production_enabled() {
  [ -z "$mutation_id" ] && return 0
  production_evidence_for "$mutation_id" | grep -Fxq "$1"
}

# --- scratch parent: every ancestor must satisfy the module's trusted-ancestor
# rule (root- or self-owned, no group/world write bit, no symlink), otherwise
# each seam leg would refuse with P4_PATH_WRITABLE for an environmental reason.
if stat -c '%u' / >/dev/null 2>&1; then
  stat_uid() { stat -c '%u' "$1"; }
  stat_mode() { stat -c '%a' "$1"; }
else
  stat_uid() { stat -f '%u' "$1"; }
  stat_mode() { stat -f '%OLp' "$1"; }
fi
my_uid="$(id -u)"
ancestor_problem=""
ancestors_trusted() {
  local path="$1" current="/" component owner mode
  ancestor_problem=""
  local rel="${path#/}"
  while :; do
    if [ -L "$current" ]; then ancestor_problem="$current is a symlink"; return 1; fi
    owner="$(stat_uid "$current" 2>/dev/null)" || { ancestor_problem="cannot stat $current"; return 1; }
    mode="$(stat_mode "$current" 2>/dev/null)" || { ancestor_problem="cannot stat $current"; return 1; }
    if [ "$owner" != "0" ] && [ "$owner" != "$my_uid" ]; then
      ancestor_problem="$current is owned by uid $owner"; return 1
    fi
    if [ $((8#$mode & 8#022)) -ne 0 ]; then
      ancestor_problem="$current is group/world writable (mode $mode)"; return 1
    fi
    [ -n "$rel" ] || return 0
    component="${rel%%/*}"
    if [ "$component" = "$rel" ]; then rel=""; else rel="${rel#*/}"; fi
    if [ "$current" = "/" ]; then current="/$component"; else current="$current/$component"; fi
  done
}
if [ -n "${P4_TEST_ROOT:-}" ]; then
  candidates="$P4_TEST_ROOT"
else
  candidates=""
  [ -z "${XDG_CACHE_HOME:-}" ] || candidates="$XDG_CACHE_HOME/pi_config"
  candidates="$candidates
$HOME/.cache/pi_config
$HOME/.local/share/agent-expertise"
fi
test_tmp=""
rejected=""
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  # Intermediates are created under umask 077 so nothing this script makes is
  # group/world writable; pre-existing ancestors keep whatever mode they have.
  (umask 077 && mkdir -p "$candidate/p4-tests") 2>/dev/null || { rejected="$rejected
  - $candidate: cannot create p4-tests"; continue; }
  physical="$(cd "$candidate/p4-tests" 2>/dev/null && pwd -P)" || { rejected="$rejected
  - $candidate: p4-tests is not enterable"; continue; }
  if ancestors_trusted "$physical"; then test_tmp="$physical"; break; fi
  rejected="$rejected
  - $candidate: $ancestor_problem"
done <<EOF
$candidates
EOF
if [ -z "$test_tmp" ]; then
  env_error "no trusted scratch parent; set P4_TEST_ROOT to a directory whose ancestors are root- or self-owned and not group/world writable:$rejected"
  exit 2
fi
chmod 700 "$test_tmp" || { env_error "cannot secure test scratch parent"; exit 2; }
scratch="$(mktemp -d "$test_tmp/pi-config-p4.XXXXXXXX")" || { env_error "mktemp failed"; exit 2; }
scratch="$(cd "$scratch" && pwd -P)" || { env_error "scratch is not enterable"; exit 2; }
chmod 700 "$scratch"
home="$scratch/home"
mkdir -m 700 "$home"
printf 'test-only\n' >"$home/.p3-runtime-test-root"
chmod 600 "$home/.p3-runtime-test-root"
base_root="$home/base-runtime"
archive_copy="$home/runtime.tar.gz"
cp "$archive" "$archive_copy"
chmod 600 "$archive_copy"
HOME="$home" python3 "$p3_driver" --implementation "$p3_installer" \
  --manifest "$manifest" --archive "$archive_copy" --root "$base_root" \
  --test-platform linux-arm64 >"$scratch/p3-install.out" 2>&1 || {
    cat "$scratch/p3-install.out" >&2
    env_error "could not install the exact P3 fixture generation"
    exit 2
  }

probe() {
  local scenario="$1" expected_code="$2" expected_calls="$3"
  local out="$scratch/$scenario.json" status=0
  (
    cd "$scratch"
    env -i HOME="$home" PATH="/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
      USER="$(id -un)" LOGNAME="$(id -un)" PI_CODING_AGENT_DIR="$scratch/agent-$scenario" \
      PI_OFFLINE=1 P4_BASE_ROOT="$base_root" P4_SCENARIO_ROOT="$home/scenarios/$scenario" \
      P4_TRUSTED_HOME="$home" P4_PROBE_OUT="$out" \
      "$pi_bin" --mode json --no-session -e "$fixture" "/p4-probe $scenario"
  ) </dev/null >"$scratch/$scenario.stdout" 2>"$scratch/$scenario.stderr" || status=$?
  if [ "$status" -ne 0 ]; then
    sed -n '1,20p' "$scratch/$scenario.stderr" >&2
    fail "$scenario" "installed pi probe exited $status"
  elif [ ! -s "$out" ]; then
    fail "$scenario" "probe wrote no result"
  elif jq -e --arg code "$expected_code" --argjson calls "$expected_calls" \
      '.code == $code and .calls == $calls and
       (if $calls == 0 then (.paths | length) == 0 else (.paths | length) == $calls end)' \
      "$out" >/dev/null; then
    ok "$scenario" "guard=$expected_code loader_calls=$expected_calls"
  else
    cat "$out" >&2
    fail "$scenario" "expected guard=$expected_code loader_calls=$expected_calls"
  fi
}
run_scenario() {
  scenario_enabled "$1" || return 0
  probe "$@"
}

# --- portable policy pins
policy_pi="$(grep -o 'compatibility: Object.freeze({ pi: "[^"]*"' "$source_file" | sed 's/.*pi: "//; s/"$//')"
if [ -n "$policy_pi" ] && [ "$policy_pi" = "$version" ]; then
  ok policy_pi_version "code-owned policy pins pi $version, matching agent/vendor/pi/VERSION"
else
  fail policy_pi_version "code-owned policy pins pi '${policy_pi:-?}' but agent/vendor/pi/VERSION is $version; remeasure the P4 policy"
fi

# --- structural legs: the registered expectation for the two loader guards
# that have no portable behavioural leg (see production_evidence_for).
loader_calls="$(grep -cF 'database.loadExtension(verified.artifactPath);' "$source_file" || true)"
if [ "$loader_calls" -eq 1 ] \
  && grep -Fq 'if (attemptedLoads.has(database)) fail("P4_ALREADY_INITIALIZED");' "$source_file" \
  && grep -Fq 'attemptedLoads.add(database);' "$source_file"; then
  ok production_cardinality_structure "one production call site and per-connection attempt latch are present"
else
  fail production_cardinality_structure "production initializer lacks the single-call attempt latch"
fi

latch_line="$(grep -nF 'attemptedLoads.add(database);' "$source_file" | cut -d: -f1)"
load_line="$(grep -nF 'try { database.loadExtension(verified.artifactPath); }' "$source_file" | cut -d: -f1)"
if [ -n "$latch_line" ] && [ -n "$load_line" ] && [ "$latch_line" -lt "$load_line" ]; then
  ok production_latch_order_structure "attempt is latched before the only production loader call"
else
  fail production_latch_order_structure "loader call can occur before the per-connection attempt latch"
fi

# --- seam legs
run_scenario writable_ancestor P4_PATH_WRITABLE 0
run_scenario valid_spy ok 1
run_scenario wrong_mode P4_ARTIFACT_MODE 0
run_scenario wrong_type P4_ARTIFACT_TYPE 0
run_scenario symlink_artifact P4_ARTIFACT_SYMLINK 0
run_scenario hard_link P4_ARTIFACT_LINKS 0
run_scenario digest_mismatch P4_ARTIFACT_DIGEST 0
run_scenario wrong_class P4_ELF_CLASS 0
run_scenario wrong_endian P4_ELF_ENDIAN 0
run_scenario wrong_osabi P4_ELF_OSABI 0
run_scenario wrong_abi_version P4_ELF_ABI_VERSION 0
run_scenario wrong_machine P4_ELF_MACHINE 0
run_scenario truncated_elf P4_ELF_TRUNCATED 0
run_scenario unexpected_dependency P4_ELF_NEEDED 0
run_scenario wrong_symbol_version P4_ELF_VERSION_POLICY 0
run_scenario dynamic_outside_load P4_ELF_DYNAMIC_MAPPING 0
run_scenario missing_gnu_stack P4_ELF_GNU_STACK 0
run_scenario duplicate_gnu_stack P4_ELF_GNU_STACK 0
run_scenario executable_gnu_stack P4_ELF_EXEC_STACK 0
run_scenario version_need_overlap P4_ELF_VERSION_OVERLAP 0
run_scenario version_need_misaligned P4_ELF_VERSION_ALIGNMENT 0
run_scenario version_aux_misaligned P4_ELF_VERSION_ALIGNMENT 0
run_scenario version_need_unterminated P4_ELF_VERSION_TERMINATION 0
run_scenario version_aux_unterminated P4_ELF_VERSION_TERMINATION 0
run_scenario wrong_manifest_compatibility P4_MANIFEST_COMPATIBILITY 0
run_scenario wrong_runtime_bun P4_RUNTIME_BUN 0
run_scenario wrong_runtime_arch P4_RUNTIME_ARCH 0
run_scenario wrong_runtime_glibc P4_RUNTIME_LIBC 0
run_scenario wrong_runtime_pi_digest P4_RUNTIME_PI_DIGEST 0
run_scenario wrong_runtime_sqlite P4_RUNTIME_SQLITE 0
run_scenario wrong_owner_ancestor P4_PATH_OWNER 0
run_scenario extra_inventory P4_GENERATION_INVENTORY 0
run_scenario symlink_root P4_ROOT_SYMLINK 0
run_scenario loader_failure P4_LOAD_FAILED 1
run_scenario final_recheck P4_ARTIFACT_FINAL_RECHECK 0
run_scenario sql_loader_enabled P4_SQL_LOADER_ENABLED 0
run_scenario sql_loader_state P4_SQL_LOADER_STATE 0

# --- production legs: real passwd-home installation, real bun:sqlite, ARM64 only.
production_legs='production_load ok 1
production_loader_failure_retry ok 1
production_sql_loader_enabled P4_SQL_LOADER_ENABLED 0
production_sql_loader_state P4_SQL_LOADER_STATE 0'
production_root=""
case "$(uname -s)-$(uname -m)" in
  Linux-aarch64|Linux-arm64)
    passwd_home="$(getent passwd "$my_uid" | cut -d: -f6)"
    production_root="$passwd_home/.local/share/agent-expertise/runtime"
    ;;
esac
production_state="ready"
if [ -z "$production_root" ]; then
  production_state="exact Linux ARM64 load runs only on the candidate target"
elif [ ! -d "$production_root" ]; then
  # Never install from a validator: that writes to the real home and may
  # download. Install explicitly with scripts/install-expertise-runtime.sh.
  production_state="runtime not installed at $production_root; run scripts/install-expertise-runtime.sh"
elif ! "$repo_root/scripts/install-expertise-runtime.sh" >"$scratch/production-revalidate.out" 2>&1; then
  # Rerunning the installer on an installed generation only revalidates it.
  cat "$scratch/production-revalidate.out" >&2
  production_state="failed"
fi
while read -r leg expected_code expected_calls; do
  production_enabled "$leg" || continue
  case "$production_state" in
    ready) probe "$leg" "$expected_code" "$expected_calls" ;;
    failed) fail "$leg" "installed production generation could not be revalidated" ;;
    *) skip "$leg" "$production_state" ;;
  esac
done <<EOF
$production_legs
EOF

finish
