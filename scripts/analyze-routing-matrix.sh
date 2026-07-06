#!/usr/bin/env bash
#
# analyze-routing-matrix.sh — per taskType × model routing-cost analysis (#351).
#
# Reads the JSONL log the auto-router extension writes to
# ~/.pi/agent/extensions/auto-router/task-types.jsonl (one line per routed turn:
# the classifier's task-type label joined with the turn's real token usage) and
# reports, per taskType × model, turn counts and average input/output tokens and
# cost. This is the measurement half that seeds the Phase 2 routing matrix
# (#352); it reports and does NOT gate, so it ends with a `TOTAL —` line rather
# than the PASS/FAIL summary block (script-output-conventions § scope note).
# The --self-test mode DOES gate itself and ends with PASS/FAIL.
#
# Usage:
#   ./scripts/analyze-routing-matrix.sh                 default log location
#   ./scripts/analyze-routing-matrix.sh --log <file> [--log <file> ...]
#   ./scripts/analyze-routing-matrix.sh --self-test     run fixture self-test
#   ./scripts/analyze-routing-matrix.sh -h | --help
#
# Cost note: turns whose provider reports no cost (typical for local models)
# average as "n/a", never a fabricated $0 — comparisons stay token-count-based
# unless every joined turn reported cost.
#
# Exit codes: 0 = report emitted (or self-test passed), 1 = no log found /
#             self-test failure, 2 = environment failure (jq missing).
#
# Requires: jq. Per agent/rules/script-output-conventions.md.

set -uo pipefail

ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
info() { printf 'INFO  %s\n' "$*"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }

DEFAULT_LOG="${AUTO_ROUTER_TASK_TYPES_LOG:-${HOME}/.pi/agent/extensions/auto-router/task-types.jsonl}"

LOG_FILES=()
SELF_TEST=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --log)       LOG_FILES+=("${2:?--log requires a file}"); shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    -h|--help)   sed -nE '/^# /{s/^# ?//;p;}; /^$/q' "$0"; exit 0 ;;
    *) err args "unknown argument: $1"; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { err deps "jq not found (required)"; exit 2; }

# Aggregate one-or-more JSONL logs into taskType × model rows + a TOTAL line.
# Skips lines that don't parse (`fromjson? // empty`) so a corrupt/partial
# trailing line never aborts the report. jq owns all float math.
render_matrix() { # render_matrix <header-line> <file...>
  local header="$1"; shift
  info "$header"
  jq -Rrn '
    def money(seen; c): if seen then "$" + (c*10000|round/10000|tostring) else "n/a" end;
    # #352: matrix-forced picks must stay distinguishable from organic
    # classifier choices; records written before #352 lack the field and
    # default to "classifier" (they predate any matrix influence).
    def sourceof: if (.source | type) == "string" and .source != "" then .source else "classifier" end;
    def sourcetag: if sourceof == "classifier" then "" else " [" + sourceof + "]" end;
    [inputs | fromjson? // empty]
    | (group_by([.taskType // "unknown", .model // "unknown", sourceof]) | map({
        taskType: (.[0].taskType // "unknown"),
        model: (.[0].model // "unknown"),
        srctag: (.[0] | sourcetag),
        turns: length,
        avgInput: ((map(.input // 0) | add) / length | round),
        avgOutput: ((map(.output // 0) | add) / length | round),
        avgCacheRead: ((map(.cacheRead // 0) | add) / length | round),
        avgCost: ((map(.costTotal // 0) | add) / length),
        costSeen: (any(.[]; .costTotal != null))
      }) | sort_by(.taskType, .model, .srctag)) as $rows
    | (($rows | map(.turns) | add) // 0) as $gturns
    | ($rows | map(.taskType) | unique | length) as $gtypes
    | ($rows[] | "INFO  \(.taskType) × \(.model)\(.srctag): turns=\(.turns) avgInput=\(.avgInput) avgCacheRead=\(.avgCacheRead) avgOutput=\(.avgOutput) avgCost=\(money(.costSeen; .avgCost))"),
      "==================================",
      "TOTAL — \($gturns) routed turn(s) across \($gtypes) task type(s)"
  ' "$@"
}

if [ "$SELF_TEST" = "1" ]; then
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/routing-matrix-st.XXXXXX")"
  f="$tmp/task-types.jsonl"
  {
    printf '%s\n' '{"ts":"2026-07-05T00:00:01Z","turn":1,"taskType":"code-edit","model":"claude-sonnet-5","provider":"anthropic","input":1000,"cacheRead":4000,"cacheWrite":0,"output":500,"costTotal":0.02}'
    printf '%s\n' '{"ts":"2026-07-05T00:00:02Z","turn":2,"taskType":"code-edit","model":"claude-sonnet-5","provider":"anthropic","input":2000,"cacheRead":6000,"cacheWrite":0,"output":700,"costTotal":0.04}'
    printf '%s\n' '{"ts":"2026-07-05T00:00:03Z","turn":3,"taskType":"simple-qa","model":"coding-workhorse","provider":"omlx","input":300,"cacheRead":0,"cacheWrite":0,"output":150,"costTotal":null}'
    printf '%s\n' '{bad partial line'
    printf '%s\n' '{"ts":"2026-07-05T00:00:04Z","turn":4,"taskType":"unknown","model":"gpt-5-mini","provider":"github-copilot","input":100,"cacheRead":0,"cacheWrite":0,"output":50,"costTotal":0.001}'
    printf '%s\n' '{"ts":"2026-07-06T00:00:05Z","turn":5,"taskType":"code-edit","model":"coding-workhorse","provider":"omlx","input":400,"cacheRead":0,"cacheWrite":0,"output":200,"costTotal":null,"source":"matrix","policy":"untagged"}'
  } > "$f"
  out="$(render_matrix "self-test" "$f")"
  fails=0
  printf '%s' "$out" | grep -q 'code-edit × coding-workhorse \[matrix\]: turns=1' \
    && ok self-test "matrix-sourced turn is a distinct row (#352)" || { err self-test "matrix source row missing"; fails=1; }
  if printf '%s' "$out" | grep -q 'claude-sonnet-5 \['; then
    err self-test "classifier default tagged"; fails=1
  else
    ok self-test "source-less records render without a source tag (classifier default)"
  fi
  printf '%s' "$out" | grep -q 'code-edit × claude-sonnet-5: turns=2 avgInput=1500 avgCacheRead=5000 avgOutput=600 avgCost=\$0.03' \
    && ok self-test "taskType×model row averages input/output/cost" || { err self-test "code-edit row wrong"; fails=1; }
  printf '%s' "$out" | grep -q 'simple-qa × coding-workhorse: turns=1 .* avgCost=n/a' \
    && ok self-test "cost-less local turn averages as n/a, not \$0" || { err self-test "local n/a row wrong"; fails=1; }
  printf '%s' "$out" | grep -q 'unknown × gpt-5-mini: turns=1' \
    && ok self-test "unknown task type is a visible row" || { err self-test "unknown row wrong"; fails=1; }
  printf '%s' "$out" | grep -q 'TOTAL — 5 routed turn(s) across 3 task type(s)' \
    && ok self-test "grand total skips the corrupt line" || { err self-test "grand total wrong"; fails=1; }
  rm -rf "$tmp"
  echo "=================================="
  if [ "$fails" -eq 0 ]; then echo "PASS — 0 errors, 0 warnings"; exit 0; fi
  echo "FAIL — ${fails} errors, 0 warnings"; exit 1
fi

if [ "${#LOG_FILES[@]}" -eq 0 ]; then
  LOG_FILES=("$DEFAULT_LOG")
fi
for f in "${LOG_FILES[@]}"; do
  [ -f "$f" ] || { err log "log not found: $f (is auto-router enabled and routing?)"; exit 1; }
done

render_matrix "routing matrix across ${#LOG_FILES[@]} log(s)" "${LOG_FILES[@]}"
exit 0
