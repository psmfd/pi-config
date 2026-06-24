#!/usr/bin/env bash
#
# analyze-cache-ratio.sh — per-config cache-hit ratio analysis (#338, ADR-0034).
#
# Reads JSONL logs produced by the cache-meter extension
# (~/.pi/agent/extensions/cache-meter/turns.jsonl) and reports, per measurement
# config, the cache-hit ratio and fresh-input/cost deltas vs a baseline. This is
# the analysis half of the prefix-churn gate; the live measurement is run by an
# operator (see scripts/run-cache-ratio.sh), not in CI.
#
# Cache-hit ratio (CHR) = Σ cacheRead / Σ(cacheRead + input), where usage.input
# is fresh (uncached) input only. A config whose cacheRead AND cacheWrite are
# both zero across all turns is treated as "provider does not report cache
# tokens" → SKIP (not a false PASS); the fresh-input (CFIT) delta still applies.
#
# Usage:
#   ./scripts/analyze-cache-ratio.sh --log <file> [--log <file> ...]
#       [--baseline <config>]       baseline config name (default: baseline)
#       [--min-ratio <0..1>]        FAIL a config whose CHR is below this (default: 0 = report only)
#       [--max-cfit-delta <pct>]    FAIL a non-baseline config whose fresh-input grows more than pct% over baseline
#       [--max-cost-delta <pct>]    FAIL a non-baseline config whose cost grows more than pct% over baseline
#   ./scripts/analyze-cache-ratio.sh --self-test     run fixture self-test
#
# Exit codes: 0 = PASS (warnings allowed), 1 = FAIL (threshold violation),
#             2 = environment/usage failure (jq missing, no logs).

set -uo pipefail

ok()    { printf 'OK    [%s] %s\n' "$1" "$2"; }
skip()  { printf 'SKIP  [%s] %s\n' "$1" "$2"; }
info()  { printf 'INFO  %s\n' "$*"; }
err()   { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }

# --- argument parsing ------------------------------------------------------
LOG_FILES=()
BASELINE="baseline"
MIN_RATIO="0"
MAX_CFIT_DELTA=""
MAX_COST_DELTA=""
SELF_TEST=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --log)            LOG_FILES+=("$2"); shift 2 ;;
    --baseline)       BASELINE="$2"; shift 2 ;;
    --min-ratio)      MIN_RATIO="$2"; shift 2 ;;
    --max-cfit-delta) MAX_CFIT_DELTA="$2"; shift 2 ;;
    --max-cost-delta) MAX_COST_DELTA="$2"; shift 2 ;;
    --self-test)      SELF_TEST=1; shift ;;
    -h|--help)        sed -n '2,28p' "$0"; exit 0 ;;
    *) err "args" "unknown argument: $1"; exit 2 ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  err "jq" "jq not found in PATH (required for JSONL analysis)"
  exit 2
fi

# --- aggregation -----------------------------------------------------------
# Emit "turns sumInput sumCacheRead sumCacheWrite sumCost" for one config across
# all log files. jq does the float/int arithmetic; bash never touches floats.
aggregate_config() {
  config="$1"; shift
  jq -rs --arg cfg "$config" '
    map(select(.config == $cfg)) |
    {
      turns:         length,
      sumInput:      (map(.input // 0)      | add // 0),
      sumCacheRead:  (map(.cacheRead // 0)  | add // 0),
      sumCacheWrite: (map(.cacheWrite // 0) | add // 0),
      sumCost:       (map(.costTotal // 0)  | add // 0)
    } | "\(.turns) \(.sumInput) \(.sumCacheRead) \(.sumCacheWrite) \(.sumCost)"
  ' "$@"
}

# Distinct config names across all logs, in first-seen order.
list_configs() {
  jq -r '.config' "$@" | awk '!seen[$0]++'
}

# CHR = cacheRead / (cacheRead + input). Prints "none" when the provider
# reported no cache activity at all (cacheRead == 0 AND cacheWrite == 0) — a
# real cold cache writes on turn 1, so all-zero means "not reported" — or when
# there are no input-side tokens to ratio. Args: cacheRead input cacheWrite.
compute_chr() {
  jq -rn --argjson cr "$1" --argjson in "$2" --argjson cw "$3" '
    if ($cr == 0 and $cw == 0) or ($cr + $in) == 0 then "none"
    else (($cr / ($cr + $in)) * 1000 | floor) / 1000 | tostring end'
}

# Percentage delta of $1 vs baseline $2 (one decimal); "n/a" if baseline is 0.
pct_delta() {
  jq -rn --argjson v "$1" --argjson base "$2" \
    'if $base == 0 then "n/a" else ((($v - $base) / $base) * 1000 | round) / 10 | tostring end'
}

# jq numeric comparison: prints "1" if true else "0".
ge() { jq -rn --argjson a "$1" --argjson b "$2" 'if $a >= $b then "1" else "0" end'; }
gt() { jq -rn --argjson a "$1" --argjson b "$2" 'if $a >  $b then "1" else "0" end'; }

# --- main analysis (reused by --self-test) ---------------------------------
# Args: baseline min_ratio max_cfit max_cost  <logfiles...>
run_analysis() {
  a_baseline="$1"; a_min_ratio="$2"; a_max_cfit="$3"; a_max_cost="$4"; shift 4
  errors=0
  warns=0

  if [ "$#" -eq 0 ]; then
    err "input" "no log files provided"
    return 2
  fi
  for f in "$@"; do
    if [ ! -f "$f" ]; then err "input" "log file not found: $f"; return 2; fi
  done

  configs="$(list_configs "$@")"
  if [ -z "$configs" ]; then
    err "input" "no records found in the provided log(s)"
    return 2
  fi

  # Baseline aggregates (for delta comparisons).
  base_agg="$(aggregate_config "$a_baseline" "$@")"
  base_input="$(printf '%s' "$base_agg" | awk '{print $2}')"
  base_cost="$(printf '%s' "$base_agg" | awk '{print $5}')"

  info "baseline=$a_baseline min-ratio=$a_min_ratio max-cfit-delta=${a_max_cfit:-unset} max-cost-delta=${a_max_cost:-unset}"
  printf 'INFO  %-18s %6s %12s %12s %8s %12s\n' "config" "turns" "fresh-input" "cache-read" "CHR" "cost-total"

  while IFS= read -r cfg; do
    [ -n "$cfg" ] || continue
    agg="$(aggregate_config "$cfg" "$@")"
    turns="$(printf '%s' "$agg" | awk '{print $1}')"
    s_input="$(printf '%s' "$agg" | awk '{print $2}')"
    s_cread="$(printf '%s' "$agg" | awk '{print $3}')"
    s_cwrite="$(printf '%s' "$agg" | awk '{print $4}')"
    s_cost="$(printf '%s' "$agg" | awk '{print $5}')"

    chr="$(compute_chr "$s_cread" "$s_input" "$s_cwrite")"
    chr_disp="$chr"; [ "$chr" = "none" ] && chr_disp="n/a"
    printf 'INFO  %-18s %6s %12s %12s %8s %12s\n' "$cfg" "$turns" "$s_input" "$s_cread" "$chr_disp" "$s_cost"

    # CHR gate.
    if [ "$chr" = "none" ]; then
      skip "chr/$cfg" "no cacheable tokens observed (provider did not report cacheRead/cacheWrite — e.g. github-copilot #1073)"
    elif [ "$(gt "$a_min_ratio" 0)" = "1" ]; then
      if [ "$(ge "$chr" "$a_min_ratio")" = "1" ]; then
        ok "chr/$cfg" "ratio=$chr >= min=$a_min_ratio"
      else
        err "chr/$cfg" "ratio=$chr < min=$a_min_ratio"
        errors=$((errors + 1))
      fi
    else
      ok "chr/$cfg" "ratio=$chr (informational; no --min-ratio gate)"
    fi

    # Fresh-input (CFIT) regression vs baseline.
    if [ -n "$a_max_cfit" ] && [ "$cfg" != "$a_baseline" ]; then
      d="$(pct_delta "$s_input" "$base_input")"
      if [ "$d" = "n/a" ]; then
        skip "cfit/$cfg" "baseline fresh-input is 0; delta not computable"
      elif [ "$(gt "$d" "$a_max_cfit")" = "1" ]; then
        err "cfit/$cfg" "fresh-input delta=+${d}% > max=${a_max_cfit}%"
        errors=$((errors + 1))
      else
        ok "cfit/$cfg" "fresh-input delta=${d}% <= max=${a_max_cfit}%"
      fi
    fi

    # Cost regression vs baseline.
    if [ -n "$a_max_cost" ] && [ "$cfg" != "$a_baseline" ]; then
      d="$(pct_delta "$s_cost" "$base_cost")"
      if [ "$d" = "n/a" ]; then
        skip "cost/$cfg" "baseline cost is 0; delta not computable"
      elif [ "$(gt "$d" "$a_max_cost")" = "1" ]; then
        err "cost/$cfg" "cost delta=+${d}% > max=${a_max_cost}%"
        errors=$((errors + 1))
      else
        ok "cost/$cfg" "cost delta=${d}% <= max=${a_max_cost}%"
      fi
    fi
  done <<EOF
$configs
EOF

  printf '==================================\n'
  if [ "$errors" -eq 0 ]; then
    printf 'PASS — %d errors, %d warnings\n' "$errors" "$warns"
    return 0
  fi
  printf 'FAIL — %d errors, %d warnings\n' "$errors" "$warns"
  return 1
}

# --- self-test -------------------------------------------------------------
self_test() {
  tdir="$(mktemp -d "${TMPDIR:-/tmp}/cache-ratio-selftest.XXXXXX")"
  log="$tdir/turns.jsonl"
  st_fail=0
  st_check() { # desc expected_rc actual_rc
    if [ "$2" -eq "$3" ]; then ok "self-test" "$1"; else err "self-test" "$1 (expected rc=$2, got rc=$3)"; st_fail=$((st_fail + 1)); fi
  }

  # baseline: hot cache (high cacheRead, low fresh input) -> high CHR
  {
    printf '%s\n' '{"config":"baseline","turn":1,"input":2000,"cacheRead":0,"cacheWrite":2000,"costTotal":0.02}'
    printf '%s\n' '{"config":"baseline","turn":2,"input":200,"cacheRead":3800,"cacheWrite":0,"costTotal":0.01}'
    printf '%s\n' '{"config":"baseline","turn":3,"input":200,"cacheRead":3800,"cacheWrite":0,"costTotal":0.01}'
    # churned: cache collapses, fresh input balloons -> low CHR
    printf '%s\n' '{"config":"churned","turn":1,"input":2000,"cacheRead":0,"cacheWrite":2000,"costTotal":0.02}'
    printf '%s\n' '{"config":"churned","turn":2,"input":4000,"cacheRead":0,"cacheWrite":2000,"costTotal":0.05}'
    printf '%s\n' '{"config":"churned","turn":3,"input":4000,"cacheRead":0,"cacheWrite":2000,"costTotal":0.05}'
    # nocache: provider reports neither cacheRead nor cacheWrite -> SKIP
    printf '%s\n' '{"config":"nocache","turn":1,"input":3000,"cacheRead":0,"cacheWrite":0,"costTotal":0.03}'
    printf '%s\n' '{"config":"nocache","turn":2,"input":3000,"cacheRead":0,"cacheWrite":0,"costTotal":0.03}'
  } > "$log"

  info "self-test: fixture at $log"

  # 1. With a 0.5 min-ratio: baseline passes, churned fails -> overall FAIL (rc 1).
  out="$(run_analysis baseline 0.5 "" "" "$log" 2>&1)"; rc=$?
  st_check "min-ratio gate fails the churned config (rc=1)" 1 "$rc"
  printf '%s' "$out" | grep -q 'ERROR \[chr/churned\]' || { err "self-test" "expected ERROR [chr/churned]"; st_fail=$((st_fail + 1)); }
  printf '%s' "$out" | grep -q 'OK    \[chr/baseline\]' || { err "self-test" "expected OK [chr/baseline]"; st_fail=$((st_fail + 1)); }
  printf '%s' "$out" | grep -q 'SKIP  \[chr/nocache\]' || { err "self-test" "expected SKIP [chr/nocache]"; st_fail=$((st_fail + 1)); }

  # 2. Without a min-ratio gate: informational only -> overall PASS (rc 0).
  out="$(run_analysis baseline 0 "" "" "$log" 2>&1)"; rc=$?
  st_check "no min-ratio gate yields PASS (rc=0)" 0 "$rc"

  # 3. CFIT regression: churned fresh-input >> baseline -> FAIL with a 50% cap.
  out="$(run_analysis baseline 0 50 "" "$log" 2>&1)"; rc=$?
  st_check "cfit-delta gate fails the churned config (rc=1)" 1 "$rc"
  printf '%s' "$out" | grep -q 'ERROR \[cfit/churned\]' || { err "self-test" "expected ERROR [cfit/churned]"; st_fail=$((st_fail + 1)); }

  # 4. Missing log file -> environment failure (rc 2).
  run_analysis baseline 0 "" "" "$tdir/does-not-exist.jsonl" >/dev/null 2>&1; rc=$?
  st_check "missing log yields environment failure (rc=2)" 2 "$rc"

  rm -rf "$tdir"
  printf '==================================\n'
  if [ "$st_fail" -eq 0 ]; then
    printf 'PASS — 0 errors, 0 warnings\n'
    return 0
  fi
  printf 'FAIL — %d errors, 0 warnings\n' "$st_fail"
  return 1
}

if [ "$SELF_TEST" -eq 1 ]; then
  self_test
  exit $?
fi

if [ "${#LOG_FILES[@]}" -eq 0 ]; then
  err "args" "no --log provided (try --help)"
  exit 2
fi

run_analysis "$BASELINE" "$MIN_RATIO" "$MAX_CFIT_DELTA" "$MAX_COST_DELTA" "${LOG_FILES[@]}"
exit $?
