#!/usr/bin/env bash
#
# run-cache-ratio.sh — operator runbook for the cache-ratio measurement (#338).
#
# The live measurement CANNOT be automated: provider cache fields come from real
# API calls, and pi runs interactively. This script configures one measurement
# slot and prints the fixed prompt battery to run, then points at the analyzer.
# It records nothing itself — the cache-meter extension does, when
# CACHE_METER_CONFIG is set in the environment pi runs under.
#
# Usage:
#   CACHE_METER_CONFIG=baseline ./scripts/run-cache-ratio.sh        # show the runbook for a slot
#   ./scripts/run-cache-ratio.sh --status                          # show recorded turns per config
#   ./scripts/run-cache-ratio.sh --fresh                           # truncate the log (start over)
#
# Then, in a real pi session started with the same CACHE_METER_CONFIG, run the
# battery below, exit, and repeat per config. Finally:
#   ./scripts/analyze-cache-ratio.sh --log "$LOG" --baseline baseline \
#       --min-ratio 0.5 --max-cfit-delta 5 --max-cost-delta 10
#
# Exit codes: 0 = ok, 2 = environment/usage failure.

set -uo pipefail

ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
info() { printf 'INFO  %s\n' "$*"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }

LOG="${HOME}/.pi/agent/extensions/cache-meter/turns.jsonl"

if ! command -v jq >/dev/null 2>&1; then
  err "jq" "jq not found in PATH (required to inspect the log)"
  exit 2
fi

case "${1:-}" in
  --status)
    if [ ! -f "$LOG" ]; then info "no log yet at $LOG"; exit 0; fi
    info "recorded turns per config ($LOG):"
    jq -r '.config' "$LOG" | sort | uniq -c | awk '{printf "      %-20s %s turns\n", $2, $1}'
    exit 0
    ;;
  --fresh)
    if [ -f "$LOG" ]; then : > "$LOG"; ok "reset" "truncated $LOG"; else info "no log to truncate"; fi
    exit 0
    ;;
  "") : ;;
  *) err "args" "unknown argument: $1 (try --status or --fresh)"; exit 2 ;;
esac

CFG="${CACHE_METER_CONFIG:-}"
if [ -z "$CFG" ]; then
  err "config" "set CACHE_METER_CONFIG to a slot name (baseline|auto-router|context-manager|indexing|all) and re-run"
  exit 2
fi

info "measurement slot: config=$CFG"
info "log: $LOG"
cat <<RUNBOOK

  Start a real pi session with this slot active, e.g.:

    CACHE_METER_CONFIG=$CFG \\
      $( [ "$CFG" = "auto-router" ]      && printf '%s' 'pi --auto' )\
$( [ "$CFG" = "context-manager" ]  && printf '%s' 'pi --prune' )\
$( [ "$CFG" = "indexing" ]         && printf '%s' 'pi --index' )\
$( [ "$CFG" = "all" ]              && printf '%s' 'pi --auto --prune --index' )\
$( [ "$CFG" = "baseline" ]         && printf '%s' 'SKIP_INDEXING=1 pi   (and leave --auto/--prune off)' )

  Hold the MODEL FIXED across all slots (pin one model) except the dedicated
  auto-router run, so model-switch cache resets do not confound the signal.

  Run this fixed prompt battery, identically for every slot (≈10 turns):

    1.  List the .ts files in agent/extensions/context-manager/
    2.  Read agent/extensions/context-manager/policy.ts
    3.  Read agent/extensions/context-manager/state.ts
    4.  Read agent/extensions/shared/signals.ts
    5.  What is PRUNE_AT and which file defines it?
    6.  Read agent/extensions/auto-router/policy.ts
    7.  List the .test.ts files under agent/extensions/
    8.  Read agent/extensions/shared/cost.ts
    9.  Read agent/extensions/indexing/parse.ts
    10. Summarize the three suite extensions in one sentence each.

  Then /exit. Discard turns 1-2 as warmup. Repeat for each config slot.
  Inspect progress any time with:  ./scripts/run-cache-ratio.sh --status

RUNBOOK

ok "ready" "config=$CFG — run the battery above in a pi session, then analyze"
exit 0
