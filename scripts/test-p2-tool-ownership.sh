#!/usr/bin/env bash
# P2 installed-pi tool-ownership feasibility probe (ADR-0157).
#
# The probe drives the pinned pi generation named in agent/vendor/pi/VERSION.
# The binary is resolved in this order; the first match wins:
#   1. $PI_BIN, when set — explicit operator override;
#   2. the fetch-pi-binary.sh cache at
#      ${XDG_CACHE_HOME:-$HOME/.cache}/pi_config/pi-<VERSION>/pi/pi — this is
#      what .github/workflows/validate.yml populates before validate.sh runs;
#      CI never puts pi on PATH;
#   3. `pi` on PATH (the setup.sh ~/.local/bin symlink).
# Exit 2 means the environment is unavailable. validate.sh reports that as a
# failed required check, not a skip.
#
# Every pi invocation reads stdin from /dev/null: pi in json mode blocks on an
# inherited interactive or pipe stdin, and this probe is never interactive.
#
# bash 3.2 (macOS system bash) is the floor: no mapfile, associative arrays,
# or case-modification expansions are used.
#
# Generation-coupled pins (docs/vendor-updates.md checklist row 8). A pi bump
# re-validates each; a changed contract shape is an ADR-0157 review item:
#   - EXPECTED_HASHLINE_METADATA_SHA256 (re-pin procedure at its definition);
#   - the built-in write result text ("Successfully wrote N bytes to ...");
#   - the built-in bash result shape (single text content block);
#   - pi's startup diagnostic 'Tool "<name>" conflicts with';
#   - hashline's edit result/details shape (anchors text, diff, classification);
#   - RPC new_session semantics (instance retained, generation and shutdown
#     counters advance).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="$ROOT_DIR/agent/vendor/pi/VERSION"
if [[ ! -s "$VERSION_FILE" ]]; then
  printf 'ERROR [env] pinned pi version file missing or empty: %s\n' "$VERSION_FILE" >&2
  exit 2
fi
EXPECTED_PI_VERSION="$(head -n 1 "$VERSION_FILE" | tr -d '[:space:]')"
PI_CACHE_BIN="${XDG_CACHE_HOME:-$HOME/.cache}/pi_config/pi-${EXPECTED_PI_VERSION}/pi/pi"
if [[ -z "${PI_BIN:-}" ]]; then
  if [[ -x "$PI_CACHE_BIN" ]]; then
    PI_BIN="$PI_CACHE_BIN"
  else
    PI_BIN="$(command -v pi || true)"
  fi
fi
FIXTURE="$ROOT_DIR/scripts/fixtures/p2-tool-ownership/ownership-extension.mjs"
COLLISION="$ROOT_DIR/scripts/fixtures/p2-tool-ownership/collision-extension.mjs"
LATE="$ROOT_DIR/scripts/fixtures/p2-tool-ownership/late-registration-extension.mjs"
RPC_CLIENT="$ROOT_DIR/scripts/fixtures/p2-tool-ownership/rpc-lifecycle.mjs"
TOOL_PROVIDER="$ROOT_DIR/scripts/fixtures/p2-tool-ownership/tool-call-provider.mjs"
HASHLINE="$ROOT_DIR/agent/extensions/hashline-edit/index.ts"
# Digest of the hashline `edit` tool's model-visible metadata as reported by
# the enabled snapshot. Lockstep with agent/extensions/hashline-edit: when its
# description, parameters, or promptGuidelines change deliberately, recompute
# with the pipeline below (the drift failure prints the observed value):
#   jq -cS '.tools[] | select(.name == "edit")
#             | {description, parameters, promptGuidelines}' <enabled.jsonl> \
#     | sha256sum | awk '{print $1}'
EXPECTED_HASHLINE_METADATA_SHA256="9184738dffff947234ef3d492321bfa4989063f62dbd905166af6b93f371a7c5"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pi-p2-ownership.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
# An interrupted run must still reach the EXIT trap so the scratch tree and
# any pi children it holds are removed.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
mkdir -p "$SCRATCH/home" "$SCRATCH/cache" "$SCRATCH/tmp"
chmod 700 "$SCRATCH" "$SCRATCH/home" "$SCRATCH/cache" "$SCRATCH/tmp"

errors=0
warnings=0

# Output follows agent/rules/script-output-conventions.md: OK to stdout,
# WARN/ERROR to stderr, a fixed [p2] check label, [env] for preconditions.
pass() { printf 'OK    [p2] %s\n' "$1"; }
fail() { printf 'ERROR [p2] %s\n' "$1" >&2; errors=$((errors + 1)); }
warn() { printf 'WARN  [p2] %s\n' "$1" >&2; warnings=$((warnings + 1)); }
env_error() { printf 'ERROR [env] %s\n' "$1" >&2; }

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    env_error "required command not found: $1"
    exit 2
  fi
}

require_command jq
require_command node
NODE_BIN="$(command -v node)"
# The fixtures are the only JavaScript under scripts/ and sit outside the
# TypeScript lint/typecheck gates; a syntax error must surface here, not as
# an opaque pi startup failure.
for fixture_file in "$ROOT_DIR"/scripts/fixtures/p2-tool-ownership/*.mjs; do
  if ! "$NODE_BIN" --check "$fixture_file" 2>"$SCRATCH/node-check.err"; then
    fail "fixture syntax check failed: $fixture_file"
    sed -n '1,10p' "$SCRATCH/node-check.err" >&2
  fi
done

# sha256 of stdin, portable across sha256sum/shasum/openssl (macOS has no
# sha256sum; same fallback order as scripts/validate-subagent-drift.sh).
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r | awk '{print $1}'
  else
    return 1
  fi
}
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1 &&
   ! command -v openssl >/dev/null 2>&1; then
  env_error "required command not found: sha256sum (or shasum / openssl)"
  exit 2
fi
SAFE_PATH="/usr/local/bin:/usr/bin:/bin"
RUN_USER="$(id -un)"

clean_env() {
  env -i \
    HOME="$SCRATCH/home" \
    PATH="$SAFE_PATH" \
    TMPDIR="$SCRATCH/tmp" \
    XDG_CACHE_HOME="$SCRATCH/cache" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    SHELL=/bin/bash \
    USER="$RUN_USER" \
    LOGNAME="$RUN_USER" \
    "$@"
}

if [[ -z "$PI_BIN" || ! -x "$PI_BIN" ]]; then
  env_error "installed pi executable not found (PI_BIN unset, $PI_CACHE_BIN absent, no pi on PATH)"
  env_error "  hint: run ./setup.sh (or ./scripts/lib/fetch-pi-binary.sh) to populate the pi $EXPECTED_PI_VERSION cache"
  env_error "  per agent/rules/extension-type-check-and-lint.md, environment unavailability is a validation error, not a skip"
  exit 2
fi

if ! actual_pi_version="$(clean_env "$PI_BIN" --version 2>/dev/null </dev/null | head -n 1)"; then
  env_error "pi at $PI_BIN failed to report its version"
  exit 2
fi
expected_cli_version="${EXPECTED_PI_VERSION#v}"
expected_cli_version="${expected_cli_version%%-*}"
# Canonical path of $1. Prefers readlink -f (probed, as validate.sh does);
# otherwise follows symlinks by hand, since macOS before 12.3 has no -f.
resolve_path() {
  local target="$1" link
  if command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
    readlink -f "$target"
    return
  fi
  warn "readlink -f unavailable; following symlinks by hand for $target"
  local hops=0
  while [[ -L "$target" ]]; do
    hops=$((hops + 1))
    if [[ "$hops" -gt 40 ]]; then
      return 1
    fi
    link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;
      *) target="$(dirname "$target")/$link" ;;
    esac
  done
  (cd "$(dirname "$target")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$target")")
}
if ! resolved_pi_bin="$(resolve_path "$PI_BIN")"; then
  env_error "could not resolve $PI_BIN (symlink chain longer than 40 hops)"
  exit 2
fi
if [[ "$actual_pi_version" != "$expected_cli_version" ]] ||
   [[ "$resolved_pi_bin" != *"/pi-${EXPECTED_PI_VERSION}/"* ]]; then
  env_error "pi at $resolved_pi_bin reports '$actual_pi_version' and is not the pinned $EXPECTED_PI_VERSION generation"
  env_error "  remedy: run ./scripts/lib/fetch-pi-binary.sh to populate the pinned cache, or set PI_BIN to the pinned binary"
  env_error "  npm-installed upstream builds (PI_USE_VENDORED=0) are not the pinned generation and are not accepted"
  exit 2
fi
pass "installed pi matches $EXPECTED_PI_VERSION"

# run_snapshot <overrides> <boundary> <skip-confinement> <hashline> <out> <label> <cwd> <collision-tool> [pi args...]
#   overrides        PI_P2_ENABLE_OVERRIDES (1 registers the fixture write/bash owners)
#   boundary         PI_EXPERTISE_MUTATION_BOUNDARY (0 is the ADR-0135 off-switch)
#   skip-confinement SKIP_BASH_CONFINEMENT (1 is the generic bypass)
#   hashline         PI_HASHLINE_EDIT (0 restores the built-in edit)
#   out              JSONL file the fixture's /p2-snapshot command appends to
#   label            per-run agent dir and stdout/stderr file stem
#   cwd              working directory for pi ("" = the scratch root)
#   collision-tool   P2_COLLISION_TOOL for the collision fixture ("" = none);
#                    passed through env -i explicitly, which would drop it
# Remaining args go to pi before the snapshot command (-e paths, --approve).
run_snapshot() {
  local overrides_flag="$1" boundary_flag="$2" skip_confinement_flag="$3" hashline_flag="$4"
  local output="$5" label="$6" cwd="${7:-$SCRATCH}" collision_tool_name="${8:-}"
  shift 8
  : >"$output"
  (
    cd "$cwd"
    clean_env \
      PI_CODING_AGENT_DIR="$SCRATCH/agent-$label" \
      PI_OFFLINE=1 \
      PI_P2_ENABLE_OVERRIDES="$overrides_flag" \
      PI_EXPERTISE_MUTATION_BOUNDARY="$boundary_flag" \
      PI_HASHLINE_EDIT="$hashline_flag" \
      SKIP_BASH_CONFINEMENT="$skip_confinement_flag" \
      P2_COLLISION_TOOL="$collision_tool_name" \
      P2_PROBE_OUT="$output" \
      "$PI_BIN" --mode json --no-session "$@" "/p2-snapshot $label"
  ) </dev/null >"$SCRATCH/$label.stdout" 2>"$SCRATCH/$label.stderr"
}

# Snapshot files are JSONL. Every assertion slurps the file and requires
# exactly one record: jq -e would otherwise report only the last record, so a
# later ready record could mask an earlier non-ready one.
assert_ready() {
  local output="$1"
  jq -e -s --arg fixture "$FIXTURE" --arg hashline "$HASHLINE" '
    length == 1 and (.[0]
      | .sessionReady and .sessionGeneration > 0 and
        .boundaryEnabled and (.confinementBypassed | not) and
        (.tools as $tools
         | ([ $tools[] | select(.name == "write" and .active and .sourceInfo.path == $fixture) ] | length) == 1
           and ([ $tools[] | select(.name == "edit" and .active and .sourceInfo.path == $hashline) ] | length) == 1
           and ([ $tools[] | select(.name == "bash" and .active and .sourceInfo.path == $fixture) ] | length) == 1))
  ' "$output" >/dev/null
}

# assert_tool_source <snapshot> <tool> builtin|<absolute extension path>
# Positive assertion of one effective owner. A missing or empty snapshot
# never satisfies it.
assert_tool_source() {
  local output="$1" tool="$2" expected="$3"
  [[ -s "$output" ]] || return 1
  if [[ "$expected" == builtin ]]; then
    jq -e -s --arg tool "$tool" \
      'length == 1 and any(.[0].tools[]; .name == $tool and .sourceInfo.source == "builtin")' \
      "$output" >/dev/null
  else
    jq -e -s --arg tool "$tool" --arg path "$expected" \
      'length == 1 and any(.[0].tools[]; .name == $tool and .sourceInfo.path == $path)' \
      "$output" >/dev/null
  fi
}

# assert_refused <snapshot> <pass message> <fail prefix> [<tool> <owner>]...
# A negative leg must prove that a snapshot exists, that readiness was
# withheld, AND that each named tool resolved to the expected owner. A bare
# "not ready" is not evidence: jq -e also exits non-zero on an empty file, so
# a pi that never ran would otherwise pass every off-switch proof.
assert_refused() {
  local output="$1" pass_message="$2" fail_prefix="$3"
  shift 3
  if [[ ! -s "$output" ]]; then
    fail "$fail_prefix: no snapshot was recorded"
    return
  fi
  if assert_ready "$output"; then
    fail "$fail_prefix: protected readiness was retained"
    return
  fi
  while (( $# >= 2 )); do
    if ! assert_tool_source "$output" "$1" "$2"; then
      fail "$fail_prefix: $1 owner is not $2"
      return
    fi
    shift 2
  done
  pass "$pass_message"
}

# run_or_fail <label> <stderr file> <command...>
# A non-zero pi exit becomes a fail line plus the stderr head, instead of an
# abort under set -e that would drop the summary and could surface as exit 2.
run_or_fail() {
  local label="$1" stderr_file="$2"
  shift 2
  if ! "$@"; then
    fail "$label exited non-zero"
    sed -n '1,20p' "$stderr_file" >&2
  fi
}

# shellcheck disable=SC2329  # invoked indirectly through run_or_fail
run_tool_call() {
  local tool="$1" arguments="$2" label="$3"
  local events="$SCRATCH/$label.events.jsonl"
  local marker="$SCRATCH/$label.marker"
  : >"$events"
  : >"$marker"
  (
    cd "$SCRATCH"
    clean_env \
      PI_CODING_AGENT_DIR="$SCRATCH/agent-$label" \
      PI_OFFLINE=1 \
      PI_P2_ENABLE_OVERRIDES=1 \
      PI_EXPERTISE_MUTATION_BOUNDARY=1 \
      PI_HASHLINE_EDIT=1 \
      SKIP_BASH_CONFINEMENT=0 \
      P2_EXECUTION_MARKER="$marker" \
      P2_TOOL_CALL="$tool" \
      P2_TOOL_ARGUMENTS="$arguments" \
      "$PI_BIN" --mode json --no-session \
        --provider p2-faux --model p2-tool-call \
        -e "$HASHLINE" -e "$FIXTURE" -e "$TOOL_PROVIDER" \
        "run the deterministic $tool fixture"
  ) </dev/null >"$events" 2>"$SCRATCH/$label.stderr"
}

baseline="$SCRATCH/baseline.jsonl"
run_or_fail "baseline snapshot run" "$SCRATCH/baseline.stderr" \
  run_snapshot 0 1 0 1 "$baseline" baseline "" "" -e "$HASHLINE" -e "$FIXTURE"
assert_refused "$baseline" \
  "red-first proof rejects builtin write/bash ownership" \
  "red-first proof" \
  write builtin bash builtin edit "$HASHLINE"

enabled="$SCRATCH/enabled.jsonl"
run_or_fail "enabled snapshot run" "$SCRATCH/enabled.stderr" \
  run_snapshot 1 1 0 1 "$enabled" enabled "" "" -e "$HASHLINE" -e "$FIXTURE"
if assert_ready "$enabled"; then
  pass "startup proves exact write/edit/bash owners"
else
  fail "startup ownership probe did not establish all three owners"
fi

# Only write and bash straddle an ownership change between the two runs;
# edit is hashline in both, so its contract evidence is the digest pin below.
for tool in write bash; do
  baseline_contract="$SCRATCH/baseline-$tool-contract.json"
  enabled_contract="$SCRATCH/enabled-$tool-contract.json"
  jq -S --arg tool "$tool" '.tools[] | select(.name == $tool) | {description, parameters, promptGuidelines}' \
    "$baseline" >"$baseline_contract" || fail "jq could not read the baseline snapshot for $tool"
  jq -S --arg tool "$tool" '.tools[] | select(.name == $tool) | {description, parameters, promptGuidelines}' \
    "$enabled" >"$enabled_contract" || fail "jq could not read the enabled snapshot for $tool"
  # jq emits nothing (exit 0) when the tool is absent, so two empty files would
  # compare equal; require both extractions and the fixture ownership first.
  if [[ ! -s "$baseline_contract" || ! -s "$enabled_contract" ]]; then
    fail "$tool metadata contract could not be extracted from both snapshots"
  elif ! assert_tool_source "$enabled" "$tool" "$FIXTURE"; then
    fail "$tool is not fixture-owned in the enabled snapshot; contract compare is meaningless"
  elif cmp -s "$baseline_contract" "$enabled_contract"; then
    pass "$tool effective owner preserves pinned metadata contract"
  else
    fail "$tool effective owner changed its pinned metadata contract"
  fi
done

hashline_metadata_sha256="$(jq -cS \
  '.tools[] | select(.name == "edit") | {description, parameters, promptGuidelines}' \
  "$enabled" | sha256_hex)"
if [[ "$hashline_metadata_sha256" == "$EXPECTED_HASHLINE_METADATA_SHA256" ]]; then
  pass "hashline edit metadata matches its explicit pinned digest"
else
  fail "hashline edit metadata digest drifted: $hashline_metadata_sha256 (if the hashline-edit change is intended, re-pin EXPECTED_HASHLINE_METADATA_SHA256 per the comment above its definition)"
fi

# The two fixture-gated switches below prove that the fixture declines to
# register its write/bash owners (builtins remain); only PI_HASHLINE_EDIT=0 is
# enforced by an installed component. See ADR-0157 and the P2 closure note.
boundary_off="$SCRATCH/boundary-off.jsonl"
run_or_fail "boundary-off snapshot run" "$SCRATCH/boundary-off.stderr" \
  run_snapshot 1 0 0 1 "$boundary_off" boundary-off "" "" -e "$HASHLINE" -e "$FIXTURE"
assert_refused "$boundary_off" \
  "PI_EXPERTISE_MUTATION_BOUNDARY=0 invalidates readiness" \
  "boundary off-switch" \
  write builtin bash builtin edit "$HASHLINE"

hashline_off="$SCRATCH/hashline-off.jsonl"
run_or_fail "hashline-off snapshot run" "$SCRATCH/hashline-off.stderr" \
  run_snapshot 1 1 0 0 "$hashline_off" hashline-off "" "" -e "$HASHLINE" -e "$FIXTURE"
assert_refused "$hashline_off" \
  "PI_HASHLINE_EDIT=0 invalidates readiness" \
  "hashline off-switch" \
  write "$FIXTURE" bash "$FIXTURE" edit builtin

bypass="$SCRATCH/confinement-bypass.jsonl"
run_or_fail "confinement-bypass snapshot run" "$SCRATCH/confinement-bypass.stderr" \
  run_snapshot 1 1 1 1 "$bypass" confinement-bypass "" "" -e "$HASHLINE" -e "$FIXTURE"
assert_refused "$bypass" \
  "SKIP_BASH_CONFINEMENT=1 invalidates readiness" \
  "generic confinement bypass" \
  write builtin bash builtin edit "$HASHLINE"

for collision_tool in write edit bash; do
  collision_late="$SCRATCH/collision-$collision_tool-late.jsonl"
  if run_snapshot 1 1 0 1 "$collision_late" "collision-$collision_tool-late" \
    "" "$collision_tool" -e "$HASHLINE" -e "$FIXTURE" -e "$COLLISION"; then
    fail "later same-name $collision_tool collision was accepted"
  elif grep -Fq "Tool \"$collision_tool\" conflicts with" \
    "$SCRATCH/collision-$collision_tool-late.stderr"; then
    pass "later same-name $collision_tool collision fails startup closed"
  else
    fail "later $collision_tool collision lacked the pinned conflict diagnostic"
  fi

  collision_early="$SCRATCH/collision-$collision_tool-early.jsonl"
  if [[ "$collision_tool" == "edit" ]]; then
    early_extensions=(-e "$COLLISION" -e "$HASHLINE" -e "$FIXTURE")
  else
    early_extensions=(-e "$HASHLINE" -e "$COLLISION" -e "$FIXTURE")
  fi
  if run_snapshot 1 1 0 1 "$collision_early" "collision-$collision_tool-early" \
    "" "$collision_tool" "${early_extensions[@]}"; then
    fail "earlier same-name $collision_tool collision was accepted"
  elif grep -Fq "Tool \"$collision_tool\" conflicts with" \
    "$SCRATCH/collision-$collision_tool-early.stderr"; then
    pass "$collision_tool collision refusal is independent of extension order"
  else
    fail "earlier $collision_tool collision lacked the pinned conflict diagnostic"
  fi
done

# Trusted-project collision: the competing extension is auto-discovered from
# the project's .pi/extensions/ (a .js there loads without any -e flag), and
# --approve ("Trust project-local files for this run", pinned pi --help)
# stands in for the interactive trust prompt so the run stays non-interactive.
project_collision="$SCRATCH/project-collision"
mkdir -p "$project_collision/.pi/extensions"
cp "$COLLISION" "$project_collision/.pi/extensions/collision-extension.js"
for collision_tool in write edit bash; do
  if run_snapshot 1 1 0 1 "$SCRATCH/project-$collision_tool.jsonl" \
    "project-$collision_tool" "$project_collision" "$collision_tool" \
    --approve -e "$HASHLINE" -e "$FIXTURE"; then
    fail "trusted project same-name $collision_tool collision was accepted"
  elif grep -Fq "Tool \"$collision_tool\" conflicts with" \
    "$SCRATCH/project-$collision_tool.stderr"; then
    pass "trusted project $collision_tool collision fails startup closed"
  else
    fail "project $collision_tool collision lacked the pinned conflict diagnostic"
  fi
done

# run_rpc_scenario <scenario> <label> <overrides> <hashline> [extension...]
# Drives pi over RPC with the client's named prompt sequence; snapshots land
# in $SCRATCH/<label>.jsonl.
# shellcheck disable=SC2329  # invoked indirectly through run_or_fail
run_rpc_scenario() {
  local scenario="$1" label="$2" overrides_flag="$3" hashline_flag="$4"
  shift 4
  (
    cd "$SCRATCH"
    clean_env \
      PI_CODING_AGENT_DIR="$SCRATCH/agent-$label" \
      PI_OFFLINE=1 \
      PI_P2_ENABLE_OVERRIDES="$overrides_flag" \
      PI_EXPERTISE_MUTATION_BOUNDARY=1 \
      PI_HASHLINE_EDIT="$hashline_flag" \
      SKIP_BASH_CONFINEMENT=0 \
      P2_PROBE_OUT="$SCRATCH/$label.jsonl" \
      "$NODE_BIN" "$RPC_CLIENT" --scenario "$scenario" "$PI_BIN" "$@"
  ) </dev/null >"$SCRATCH/$label.stdout" 2>"$SCRATCH/$label.stderr"
}

lifecycle="$SCRATCH/lifecycle.jsonl"
: >"$lifecycle"
run_or_fail "RPC lifecycle client" "$SCRATCH/lifecycle.stderr" \
  run_rpc_scenario lifecycle lifecycle 1 1 "$HASHLINE" "$FIXTURE"

for reason in startup reload new-session active-restored; do
  snapshot="$SCRATCH/lifecycle-$reason.json"
  jq -c --arg reason "$reason" 'select(.reason == $reason)' "$lifecycle" >"$snapshot" || fail "jq could not extract snapshot"
  if [[ -s "$snapshot" ]] && assert_ready "$snapshot"; then
    pass "$reason lifecycle snapshot re-establishes readiness"
  else
    fail "$reason lifecycle snapshot is absent or not ready"
  fi
done

startup_instance="$(jq -r 'select(.reason == "startup") | .instanceId' "$lifecycle" || true)"
reload_instance="$(jq -r 'select(.reason == "reload") | .instanceId' "$lifecycle" || true)"
new_session_instance="$(jq -r 'select(.reason == "new-session") | .instanceId' "$lifecycle" || true)"
startup_session="$(jq -r 'select(.reason == "startup") | .sessionId' "$lifecycle" || true)"
reload_session="$(jq -r 'select(.reason == "reload") | .sessionId' "$lifecycle" || true)"
new_session="$(jq -r 'select(.reason == "new-session") | .sessionId' "$lifecycle" || true)"
reload_generation="$(jq -r 'select(.reason == "reload") | .sessionGeneration' "$lifecycle" || true)"
new_session_generation="$(jq -r 'select(.reason == "new-session") | .sessionGeneration' "$lifecycle" || true)"
reload_shutdowns="$(jq -r 'select(.reason == "reload") | .shutdownCount' "$lifecycle" || true)"
new_session_shutdowns="$(jq -r 'select(.reason == "new-session") | .shutdownCount' "$lifecycle" || true)"
new_session_start_reason="$(jq -r 'select(.reason == "new-session") | .lastStartReason' "$lifecycle" || true)"
if [[ "$startup_instance" != "$reload_instance" && "$startup_session" == "$reload_session" ]]; then
  pass "reload rebuilt the extension runtime for the same session"
else
  fail "reload generation/session identity did not change as expected"
fi
# Pinned runtime behaviour: RPC new_session keeps the extension instance and
# fires session_shutdown then session_start, so both counters must advance on
# the same instance. A runtime that re-instantiated instead would report
# shutdownCount=0 and must fail here so the probe is revisited, not assumed.
if [[ "$reload_session" != "$new_session" &&
      "$new_session_start_reason" == "new" &&
      "$reload_instance" == "$new_session_instance" &&
      "$new_session_generation" -gt "$reload_generation" &&
      "$new_session_shutdowns" -gt "$reload_shutdowns" ]]; then
  pass "session replacement invalidates and freshly re-establishes readiness"
else
  fail "session replacement evidence mismatch: instance $reload_instance -> $new_session_instance, generation $reload_generation -> $new_session_generation, shutdowns $reload_shutdowns -> $new_session_shutdowns"
fi

inactive="$SCRATCH/lifecycle-write-inactive.json"
jq -c 'select(.reason == "write-inactive")' "$lifecycle" >"$inactive" || fail "jq could not extract inactive"
if assert_ready "$inactive"; then
  fail "inactive write tool retained readiness"
elif jq -e '.tools[] | select(.name == "write" and (.active | not))' "$inactive" >/dev/null; then
  pass "active-tool removal invalidates readiness"
else
  fail "active-tool probe did not record write as inactive"
fi

# Post-load same-name registration (ADR-0157: "a later registration can
# replace a protected executor" is an A2 stop condition). Measured on the
# pinned generation: registerTool from a handler is a silent no-op against an
# extension-owned tool and a silent replacement of a built-in-owned tool.
# Leg A proves the protected owners survive; leg B proves that a takeover of
# an absent (built-in) owner is visible in sourceInfo and refuses readiness.
late_protected="$SCRATCH/late-protected.jsonl"
: >"$late_protected"
run_or_fail "RPC late-registration client (protected owners)" "$SCRATCH/late-protected.stderr" \
  run_rpc_scenario late late-protected 1 1 "$HASHLINE" "$FIXTURE" "$LATE"
for tool in write edit bash; do
  snapshot="$SCRATCH/late-protected-$tool.json"
  jq -c --arg reason "late-$tool" 'select(.reason == $reason)' "$late_protected" >"$snapshot" || fail "jq could not extract snapshot"
  if [[ -s "$snapshot" ]] && assert_ready "$snapshot"; then
    pass "post-load $tool registration cannot replace the protected owner"
  else
    fail "post-load $tool registration replaced the protected owner or snapshot missing (A2 stop condition)"
  fi
done

late_absent="$SCRATCH/late-absent.jsonl"
: >"$late_absent"
run_or_fail "RPC late-registration client (absent owners)" "$SCRATCH/late-absent.stderr" \
  run_rpc_scenario late late-absent 0 0 "$HASHLINE" "$FIXTURE" "$LATE"
snapshot="$SCRATCH/late-absent-startup.json"
jq -c 'select(.reason == "late-startup")' "$late_absent" >"$snapshot" || fail "jq could not extract snapshot"
assert_refused "$snapshot" \
  "absent-owner baseline leaves write/edit/bash built-in and refuses readiness" \
  "absent-owner baseline" \
  write builtin edit builtin bash builtin
for tool in write edit bash; do
  snapshot="$SCRATCH/late-absent-$tool.json"
  jq -c --arg reason "late-$tool" 'select(.reason == $reason)' "$late_absent" >"$snapshot" || fail "jq could not extract snapshot"
  assert_refused "$snapshot" \
    "post-load $tool takeover of a built-in owner is visible in sourceInfo and refuses readiness" \
    "post-load $tool takeover" \
    "$tool" "$LATE"
done

write_args="$(jq -cn '{path:"write-canary.txt",content:"p2-write-content"}')"
run_or_fail "write tool-call run" "$SCRATCH/tool-write.stderr" \
  run_tool_call write "$write_args" tool-write
if [[ "$(cat "$SCRATCH/write-canary.txt")" == "p2-write-content" ]] &&
   grep -Fxq 'write:mkdir' "$SCRATCH/tool-write.marker" &&
   grep -Fxq 'write:writeFile' "$SCRATCH/tool-write.marker" &&
   jq -e 'select(.type == "tool_execution_end" and .toolName == "write" and
     .isError == false and .result == {content:[{type:"text",text:"Successfully wrote 16 bytes to write-canary.txt"}]})' \
     "$SCRATCH/tool-write.events.jsonl" >/dev/null; then
  pass "real write tool call preserves result contract and disk effect"
else
  fail "real write tool call contract or disk effect failed"
fi

bash_args="$(jq -cn --arg command \
  "printf 'p2-bash-file' > bash-canary.txt; printf 'p2-bash-output'" \
  '{command:$command}')"
run_or_fail "bash tool-call run" "$SCRATCH/tool-bash.stderr" \
  run_tool_call bash "$bash_args" tool-bash
if [[ "$(cat "$SCRATCH/bash-canary.txt")" == "p2-bash-file" ]] &&
   [[ "$(cat "$SCRATCH/tool-bash.marker")" == "bash:exec" ]] &&
   jq -e 'select(.type == "tool_execution_end" and .toolName == "bash" and
     .isError == false and .result == {content:[{type:"text",text:"p2-bash-output"}]})' \
     "$SCRATCH/tool-bash.events.jsonl" >/dev/null; then
  pass "real bash tool call preserves result contract and disk effect"
else
  fail "real bash tool call contract or disk effect failed"
fi

printf 'alpha\n' >"$SCRATCH/edit-canary.txt"
edit_args="$(jq -cn '{path:"edit-canary.txt",edits:[{op:"replace_text",oldText:"alpha",newText:"beta"}]}')"
run_or_fail "edit tool-call run" "$SCRATCH/tool-edit.stderr" \
  run_tool_call edit "$edit_args" tool-edit
if [[ "$(cat "$SCRATCH/edit-canary.txt")" == "beta" ]] &&
   jq -e --arg content $'--- Anchors 1-1 ---\n1#MM:beta' \
     --arg diff $'-1    alpha\n+1#MM:beta' \
     'select(.type == "tool_execution_end" and .toolName == "edit" and
       .isError == false and .result == {
         content:[{type:"text",text:$content}],
         details:{diff:$diff,firstChangedLine:1,classification:"applied",warnings:[]}
       })' "$SCRATCH/tool-edit.events.jsonl" >/dev/null; then
  pass "real hashline edit call preserves result shape and disk effect"
else
  fail "real hashline edit call contract or disk effect failed"
fi

printf '%s\n' '=================================='
if [[ "$errors" -eq 0 ]]; then
  printf 'PASS — %d errors, %d warnings\n' "$errors" "$warnings"
  exit 0
fi
printf 'FAIL — %d errors, %d warnings\n' "$errors" "$warnings"
exit 1
