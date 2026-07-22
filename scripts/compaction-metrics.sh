#!/usr/bin/env bash
#
# compaction-metrics.sh — report per-compaction cost/strategy from the
# compaction-optimizer events ledger (#838, ADR-0117).
#
# Reads the append-only JSONL the compaction-optimizer extension writes to
# ~/.pi/agent/extensions/compaction-optimizer/events.jsonl (one record per
# COMMITTED compaction) and renders a per-compaction table plus a per-path
# rollup. Reports; it does NOT gate — so it ends with a `TOTAL —` line rather
# than the PASS/FAIL summary block (script-output-conventions § scope note).
#
# Cost-basis semantics (ADR-0117):
#   zero     — deterministic builder, no model call; counterfactual column
#              shows what pi's default summarizer WOULD have cost.
#   derived  — pi's built-in summarizer ran; cost reconstructed from
#              tokensBefore × input rate + estimated summary tokens × output
#              rate. UPPER BOUND — blind to the provider prefix-cache split.
#   reported — a compaction-optimizer-initiated summarizer call with real
#              provider usage (#839).
#
# Usage:
#   compaction-metrics.sh                 # table + per-path rollup, all events
#   compaction-metrics.sh --session <id>  # one session only
#   compaction-metrics.sh --tail <n>      # limit the table to the last n rows
#   compaction-metrics.sh --by-policy     # rollup by policy x path (A/B view)
#   compaction-metrics.sh --rollup-only   # skip the per-compaction table
#   compaction-metrics.sh --self-test     # fixture self-test (no ~/.pi needed)
#   compaction-metrics.sh -h | --help
#
# Post-compaction cache effects (CHR recovery) are NOT derivable from this
# ledger alone — join events.jsonl `ts` against cache-meter turns.jsonl by
# wall-clock proximity (single-live-session assumption); see the extension
# README § Metrics.
#
# Exit codes:
#   0 — report emitted (or --self-test passed)
#   1 — self-test failure
#   2 — environment failure (missing jq, or the events file is unreadable)
#
# Requires: jq. Per agent/rules/script-output-conventions.md.

set -euo pipefail

ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
info() { printf 'INFO  %s\n' "$*"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }

EVENTS_FILE="${COMPACTION_EVENTS_FILE:-${HOME}/.pi/agent/extensions/compaction-optimizer/events.jsonl}"

MODE="report"; SESSION=""; TAIL=0; GROUP_BY="path"; TABLE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --session)     SESSION="${2:?--session requires an id}"; shift 2 ;;
    --tail)        TAIL="${2:?--tail requires a count}"; shift 2 ;;
    --by-policy)   GROUP_BY="policy-path"; shift ;;
    --rollup-only) TABLE=0; shift ;;
    --self-test)   MODE="selftest"; shift ;;
    -h|--help)     sed -nE '/^# /{s/^# ?//;p;}; /^$/q' "$0"; exit 0 ;;
    *) err args "unknown flag: $1"; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { err deps "jq not found (required)"; exit 2; }

# Per-compaction table. Reads raw lines and skips any that don't parse
# (`fromjson? // empty`) so a corrupt/partial trailing line never aborts the
# report. Prints via jq to keep bash off the math.
render_table() { # render_table <file>
  jq -Rrn --arg session "$SESSION" --argjson tail "$TAIL" '
    def money(v): if v == null then "n/a" else "$" + (v*1000000|round/1000000|tostring) end;
    [inputs | fromjson? // empty
      | select($session == "" or .sessionId == $session)]
    | (if $tail > 0 then .[-$tail:] else . end)
    | .[]
    | "INFO  \(.ts) \(.sessionId) path=\(.path) basis=\(.costBasis)"
      + (if .rung != null then " rung=\(.rung)" else "" end)
      + (if .reason != null then " reason=\(.reason)" else "" end)
      + " tokensBefore=\(.tokensBefore)"
      + (if .summaryTokens != null then " summaryTokens=\(.summaryTokens)" else "" end)
      + " cost=\(money(.costUSD))"
      + (if .counterfactualDefaultCostUSD != null then " default-would-cost=\(money(.counterfactualDefaultCostUSD))" else "" end)
      + " latencyMs=\(.latencyMs)"
  ' "$1"
}

# Rollup by path (default) or policy x path (--by-policy). Averages rounded to
# whole tokens/ms; money to micro-dollars.
render_rollup() { # render_rollup <header> <file>
  local header="$1"; shift
  info "$header"
  jq -Rrn --arg session "$SESSION" --arg groupBy "$GROUP_BY" '
    def policyof: if (.policy | type) == "string" and .policy != "" then .policy else "untagged" end;
    def keyof: if $groupBy == "policy-path" then (policyof + " / " + .path) else .path end;
    def money(v): "$" + (v*1000000|round/1000000|tostring);
    [inputs | fromjson? // empty
      | select($session == "" or .sessionId == $session)]
    | (group_by(keyof) | map({
        name: (.[0] | keyof),
        n: length,
        avgTokensBefore: ((map(.tokensBefore // 0) | add) / length | round),
        sumCost: (map(.costUSD // 0) | add),
        sumCounterfactual: (map(.counterfactualDefaultCostUSD // 0) | add),
        avgLatencyMs: ((map(.latencyMs // 0) | add) / length | round)
      }) | sort_by(-.n)) as $m
    | (($m | map(.n) | add) // 0) as $gn
    | (($m | map(.sumCost) | add) // 0) as $gc
    | (($m | map(.sumCounterfactual) | add) // 0) as $gcf
    | ($m[] | "INFO  \(.name): n=\(.n) avgTokensBefore=\(.avgTokensBefore) cost=\(money(.sumCost)) default-would-cost=\(money(.sumCounterfactual)) avgLatencyMs=\(.avgLatencyMs)"),
      "==================================",
      "TOTAL — \($gn) compaction(s), spent \(money($gc)), default-path counterfactual \(money($gcf))"
  ' "$@"
}

self_test() {
  local dir f fails=0 out
  dir="$(mktemp -d "${TMPDIR:-/tmp}/compaction-metrics-st.XXXXXX")"
  f="$dir/events.jsonl"
  cat > "$f" <<'EOF'
{"ts":"2026-07-21T00:00:00Z","sessionId":"s1","policy":"untagged","mode":"deterministic","path":"deterministic","rung":"full","tokensBefore":100000,"summaryTokens":4000,"latencyMs":12,"costBasis":"zero","costUSD":0,"counterfactualDefaultCostUSD":0.12,"components":{"summaryTokensEst":4000,"inputPerMTok":1,"outputPerMTok":5}}
{"ts":"2026-07-21T01:00:00Z","sessionId":"s1","policy":"untagged","mode":"hybrid","path":"fallthrough","reason":"tool-call-ratio-low","tokensBefore":80000,"summaryTokens":2000,"latencyMs":45000,"costBasis":"derived","costUSD":0.09}
{"ts":"2026-07-21T02:00:00Z","sessionId":"s2","policy":"compact-b","mode":"deterministic","path":"deterministic","rung":"full","tokensBefore":50000,"summaryTokens":1000,"latencyMs":8,"costBasis":"zero","costUSD":0,"counterfactualDefaultCostUSD":0.055}
not json
EOF
  out="$(render_table "$f")"
  printf '%s\n' "$out" | grep -q 'path=deterministic' && ok self-test "table renders deterministic row" || { err self-test "missing deterministic row"; fails=1; }
  [ "$(printf '%s\n' "$out" | grep -c '^INFO')" = "3" ] && ok self-test "corrupt trailing line skipped (3 rows)" || { err self-test "expected 3 rows"; fails=1; }
  out="$(render_rollup "self-test rollup" "$f")"
  printf '%s\n' "$out" | grep -q 'deterministic: n=2' && ok self-test "rollup groups by path" || { err self-test "rollup grouping wrong"; fails=1; }
  printf '%s\n' "$out" | grep -q 'TOTAL — 3 compaction(s), spent \$0.09, default-path counterfactual \$0.175' && ok self-test "totals aggregate cost + counterfactual" || { err self-test "totals wrong: $(printf '%s' "$out" | tail -1)"; fails=1; }
  SESSION="s2"
  out="$(render_rollup "self-test session filter" "$f")"
  printf '%s\n' "$out" | grep -q 'TOTAL — 1 compaction(s)' && ok self-test "--session filters" || { err self-test "session filter wrong"; fails=1; }
  SESSION=""
  GROUP_BY="policy-path"
  out="$(render_rollup "self-test policy" "$f")"
  printf '%s\n' "$out" | grep -q 'compact-b / deterministic: n=1' && ok self-test "policy x path cross-tab" || { err self-test "policy cross-tab wrong"; fails=1; }
  GROUP_BY="path"
  rm -rf "$dir"
  echo "=================================="
  if [ "$fails" -eq 0 ]; then echo "PASS — 0 errors, 0 warnings"; return 0; fi
  echo "FAIL — ${fails} errors, 0 warnings"; return 1
}

if [ "$MODE" = "selftest" ]; then
  self_test
  exit $?
fi

[ -f "$EVENTS_FILE" ] || { err events "no events ledger at $EVENTS_FILE (no committed compactions recorded yet, or events.enabled=false)"; exit 2; }

if [ "$TABLE" = "1" ]; then
  info "per-compaction events — $EVENTS_FILE"
  render_table "$EVENTS_FILE"
  echo
fi
render_rollup "rollup ($GROUP_BY)" "$EVENTS_FILE"
