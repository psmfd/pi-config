#!/usr/bin/env bash
#
# compaction-metrics.sh — report per-compaction cost/strategy from the
# compaction-optimizer events ledger (#838, ADR-0151).
#
# Reads the append-only JSONL the compaction-optimizer extension writes to
# ~/.pi/agent/extensions/compaction-optimizer/events.jsonl (one record per
# COMMITTED compaction) and renders a per-compaction table plus a per-path
# rollup. Rollups partition reported spend from derived upper bounds; they
# never combine unlike cost bases into one spend total. Reports; it does NOT
# gate — so it ends with a `TOTAL —` line rather than the PASS/FAIL summary
# block (script-output-conventions § scope note).
#
# Cost-basis semantics (ADR-0151; supersedes ADR-0117):
#   zero     — deterministic builder, no model call; counterfactual column
#              shows what pi's default summarizer WOULD have cost.
#   reported — committed CompactionEntry carried provider-reported usage and
#              pi's usage-based cost (built-in pi path since #840 landed).
#   derived  — backward-compatible fallback when committed usage/cost is
#              unavailable; reconstructed upper bound from tokensBefore,
#              rates, and estimated summary tokens.
# Unknown bases, invalid money, malformed records, and incomplete appends are
# excluded and surfaced as anomalies; affected totals say `totals-incomplete`.
# Control characters are neutralized, and ledgers above 64 MiB are refused.
#
# Usage:
#   compaction-metrics.sh                 # table + basis-separated path rollup
#   compaction-metrics.sh --session <id>  # one session only
#   compaction-metrics.sh --tail <n>      # limit the table to the last n rows
#   compaction-metrics.sh --by-policy     # policy x path, costs basis-separated
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
#   2 — environment/argument failure (missing jq, unreadable/oversized ledger)
#
# Requires: jq. Per agent/rules/script-output-conventions.md.

set -euo pipefail

ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
info() { printf 'INFO  %s\n' "$*"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }

EVENTS_FILE="${COMPACTION_EVENTS_FILE:-${HOME}/.pi/agent/extensions/compaction-optimizer/events.jsonl}"

MODE="report"; SESSION=""; TAIL=0; GROUP_BY="path"; TABLE=1
MAX_LEDGER_BYTES=67108864
while [ $# -gt 0 ]; do
  case "$1" in
    --session)
      [ $# -ge 2 ] && [ -n "$2" ] || { err args "--session requires an id"; exit 2; }
      SESSION="$2"; shift 2
      ;;
    --tail)
      [ $# -ge 2 ] && [ -n "$2" ] || { err args "--tail requires a count"; exit 2; }
      TAIL="$2"
      case "$TAIL" in ''|*[!0-9]*) err args "--tail requires a non-negative integer"; exit 2 ;; esac
      [ "$TAIL" -le 100000 ] || { err args "--tail must not exceed 100000"; exit 2; }
      shift 2
      ;;
    --by-policy)   GROUP_BY="policy-path"; shift ;;
    --rollup-only) TABLE=0; shift ;;
    --self-test)   MODE="selftest"; shift ;;
    -h|--help)     sed -nE '/^# /{s/^# ?//;p;}; /^$/q' "$0"; exit 0 ;;
    *) err args "unknown flag: $1"; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { err deps "jq not found (required)"; exit 2; }

# Per-compaction table. Invalid JSON, non-record JSON values, malformed money,
# and terminal-control characters are made visible rather than silently changing
# totals or forging report lines.
file_ends_with_newline() { # file_ends_with_newline <file>
  [ ! -s "$1" ] || [ "$(tail -c 1 "$1" | od -An -t u1 | tr -d '[:space:]')" = "10" ]
}

render_table() { # render_table <file>
  local file="$1" ends_newline=false
  if file_ends_with_newline "$file"; then ends_newline=true; fi
  jq -Rrn --arg session "$SESSION" --argjson tail "$TAIL" --argjson endsNewline "$ends_newline" '
    def validnumber:
      type == "number" and (isnan | not) and (isinfinite | not) and . >= 0;
    def validcount: validnumber and floor == . and . <= 9007199254740991;
    def validmoney: validnumber;
    def optionalstring(v): v == null or (v | type) == "string";
    def optionalcount(v): v == null or (v | validcount);
    def validmode: . == "deterministic" or . == "hybrid" or . == "llm-only-with-dump";
    def validpath: . == "deterministic" or . == "fallthrough" or . == "llm-only" or . == "ladder-exhausted";
    def money(v):
      if (v | validmoney) then "$" + (v*1000000|round/1000000|tostring) else "n/a" end;
    def visible(v): (v | tostring | gsub("[[:cntrl:]]"; "?"));
    def basisof:
      (.costBasis // null) as $basis
      | if ($basis == "zero" or $basis == "reported" or $basis == "derived")
        then $basis else "unknown" end;
    def validrecord:
      if type != "object" then false
      else ((.ts | type) == "string" and .ts != ""
        and (.sessionId | type) == "string" and .sessionId != ""
        and (.policy | type) == "string" and .policy != ""
        and (.mode | validmode) and (.path | validpath)
        and ((.mode == "deterministic" and (.path == "deterministic" or .path == "fallthrough"))
          or (.mode == "hybrid" and (.path == "deterministic" or .path == "fallthrough" or .path == "ladder-exhausted"))
          or (.mode == "llm-only-with-dump" and .path == "llm-only"))
        and (.tokensBefore | validcount) and (.latencyMs | validcount)
        and optionalstring(.reason) and optionalstring(.rung)
        and optionalstring(.model) and optionalstring(.provider)
        and optionalcount(.summaryTokens))
      end;
    [inputs | . as $raw | try {ok: true, value: ($raw | fromjson)} catch {ok: false}] as $parsed
    | ($parsed | length) as $lineCount
    | ([$parsed | to_entries[] | select(.value.ok | not)
        | select(.key == ($lineCount - 1) and ($endsNewline | not))] | length) as $trailingPartial
    | ([$parsed | to_entries[] | select(.value.ok | not)
        | select(.key != ($lineCount - 1) or $endsNewline)] | length) as $parseErrors
    | ([$parsed[] | select(.ok) | .value | select(validrecord | not)] | length) as $invalidRecords
    | [$parsed[] | select(.ok) | .value | select(validrecord)
        | select($session == "" or .sessionId == $session)] as $rows
    | ($rows | if $tail > 0 then .[-$tail:] else . end | .[]
       | "INFO  \(visible(.ts)) \(visible(.sessionId)) path=\(visible(.path)) basis=\(basisof)"
         + (if .rung != null then " rung=\(visible(.rung))" else "" end)
         + (if .reason != null then " reason=\(visible(.reason))" else "" end)
         + " tokensBefore=\(visible(.tokensBefore))"
         + (if .summaryTokens != null then " summaryTokens=\(visible(.summaryTokens))" else "" end)
         + " cost=\(money(.costUSD))"
         + (if .counterfactualDefaultCostUSD != null then " default-would-cost=\(money(.counterfactualDefaultCostUSD))" else "" end)
         + " latencyMs=\(visible(.latencyMs))"),
      (if ($invalidRecords + $parseErrors + $trailingPartial) > 0
       then "WARN  omitted-records invalid-record=\($invalidRecords) parse-error=\($parseErrors) trailing-partial=\($trailingPartial)"
       else empty end)
  ' "$file"
}

# Rollup by path (default) or policy x path (--by-policy). Monetary columns are
# partitioned by cost basis. Omitted records and excluded money are counted, and
# affected totals are marked incomplete.
render_rollup() { # render_rollup <header> <file>
  local header="$1"; shift
  local file="$1" ends_newline=false
  if file_ends_with_newline "$file"; then ends_newline=true; fi
  info "$header"
  jq -Rrn --arg session "$SESSION" --arg groupBy "$GROUP_BY" --argjson endsNewline "$ends_newline" '
    def validnumber:
      type == "number" and (isnan | not) and (isinfinite | not) and . >= 0;
    def validcount: validnumber and floor == . and . <= 9007199254740991;
    def validmoney: validnumber;
    def optionalstring(v): v == null or (v | type) == "string";
    def optionalcount(v): v == null or (v | validcount);
    def validmode: . == "deterministic" or . == "hybrid" or . == "llm-only-with-dump";
    def validpath: . == "deterministic" or . == "fallthrough" or . == "llm-only" or . == "ladder-exhausted";
    def money(v):
      if (v | validmoney) then "$" + (v*1000000|round/1000000|tostring) else "n/a" end;
    def visible(v): (v | tostring | gsub("[[:cntrl:]]"; "?"));
    def policyof: if (.policy | type) == "string" and .policy != "" then .policy else "untagged" end;
    def keyof: if $groupBy == "policy-path" then (visible(policyof) + " / " + visible(.path)) else visible(.path) end;
    def basisof:
      (.costBasis // null) as $basis
      | if ($basis == "zero" or $basis == "reported" or $basis == "derived")
        then $basis else "unknown" end;
    def validcost: .costUSD | validmoney;
    def validbasispath:
      (basisof == "zero" and .path == "deterministic")
      or ((basisof == "reported" or basisof == "derived") and .path != "deterministic");
    def validreported:
      basisof != "reported" or
      ((.usage | type) == "object"
        and (.usage.input | validcount) and (.usage.output | validcount)
        and (.usage.cacheRead | validcount) and (.usage.cacheWrite | validcount)
        and (.usage.totalTokens | validcount));
    def validrecord:
      if type != "object" then false
      else ((.ts | type) == "string" and .ts != ""
        and (.sessionId | type) == "string" and .sessionId != ""
        and (.policy | type) == "string" and .policy != ""
        and (.mode | validmode) and (.path | validpath)
        and ((.mode == "deterministic" and (.path == "deterministic" or .path == "fallthrough"))
          or (.mode == "hybrid" and (.path == "deterministic" or .path == "fallthrough" or .path == "ladder-exhausted"))
          or (.mode == "llm-only-with-dump" and .path == "llm-only"))
        and (.tokensBefore | validcount) and (.latencyMs | validcount)
        and optionalstring(.reason) and optionalstring(.rung)
        and optionalstring(.model) and optionalstring(.provider)
        and optionalcount(.summaryTokens))
      end;
    [inputs | . as $raw | try {ok: true, value: ($raw | fromjson)} catch {ok: false}] as $parsed
    | ($parsed | length) as $lineCount
    | ([$parsed | to_entries[] | select(.value.ok | not)
        | select(.key == ($lineCount - 1) and ($endsNewline | not))] | length) as $trailingPartial
    | ([$parsed | to_entries[] | select(.value.ok | not)
        | select(.key != ($lineCount - 1) or $endsNewline)] | length) as $parseErrors
    | ([$parsed[] | select(.ok) | .value | select(validrecord | not)] | length) as $invalidRecords
    | [$parsed[] | select(.ok) | .value | select(validrecord)
        | select($session == "" or .sessionId == $session)] as $rows
    | ($rows | group_by(keyof) | map({
        name: (.[0] | keyof),
        n: length,
        avgTokensBefore: ((map(.tokensBefore) | add) / length | round),
        reportedCost: ([.[] | select(basisof == "reported" and validbasispath and validreported and validcost) | .costUSD] | add // 0),
        derivedCost: ([.[] | select(basisof == "derived" and validbasispath and validcost) | .costUSD] | add // 0),
        unknownCost: ([.[] | select((basisof == "reported" or basisof == "derived") and validbasispath and validreported and (validcost | not))] | length),
        unknownBasis: ([.[] | select(basisof == "unknown")] | length),
        basisPathMismatch: ([.[] | select(basisof != "unknown" and (validbasispath | not))] | length),
        invalidReported: ([.[] | select(basisof == "reported" and validbasispath and (validreported | not))] | length),
        invalidZeroCost: ([.[] | select(basisof == "zero" and validbasispath and ((validcost | not) or .costUSD != 0))] | length),
        sumCounterfactual: ([.[] | select(basisof == "zero" and validbasispath and validcost and .costUSD == 0 and (.counterfactualDefaultCostUSD | validmoney)) | .counterfactualDefaultCostUSD] | add // 0),
        unknownCounterfactual: ([.[] | select(basisof == "zero" and validbasispath and validcost and .costUSD == 0 and ((.counterfactualDefaultCostUSD | validmoney) | not))] | length),
        inconsistentCounterfactual: ([.[] | select(basisof != "zero" and .counterfactualDefaultCostUSD != null)] | length),
        avgLatencyMs: ((map(.latencyMs) | add) / length | round)
      }) | sort_by(-.n)) as $m
    | (($m | map(.n) | add) // 0) as $gn
    | (($m | map(.reportedCost) | add) // 0) as $gr
    | (($m | map(.derivedCost) | add) // 0) as $gd
    | (($m | map(.unknownCost) | add) // 0) as $gu
    | (($m | map(.unknownBasis) | add) // 0) as $gub
    | (($m | map(.basisPathMismatch) | add) // 0) as $gbpm
    | (($m | map(.invalidReported) | add) // 0) as $gir
    | (($m | map(.invalidZeroCost) | add) // 0) as $giz
    | (($m | map(.sumCounterfactual) | add) // 0) as $gcf
    | (($m | map(.unknownCounterfactual) | add) // 0) as $guc
    | (($m | map(.inconsistentCounterfactual) | add) // 0) as $gic
    | ($invalidRecords + $parseErrors + $trailingPartial + $gu + $gub + $gbpm + $gir + $giz + $guc + $gic) as $incomplete
    | ($m[]
       | "INFO  \(.name): n=\(.n) avgTokensBefore=\(.avgTokensBefore) spent=\(money(.reportedCost)) derived-upper-bound=\(money(.derivedCost)) default-would-cost=\(money(.sumCounterfactual)) avgLatencyMs=\(.avgLatencyMs)"
         + (if .unknownCost > 0 then " unknown-cost=\(.unknownCost)" else "" end)
         + (if .unknownBasis > 0 then " unknown-basis=\(.unknownBasis)" else "" end)
         + (if .basisPathMismatch > 0 then " basis-path-mismatch=\(.basisPathMismatch)" else "" end)
         + (if .invalidReported > 0 then " invalid-reported=\(.invalidReported)" else "" end)
         + (if .invalidZeroCost > 0 then " invalid-zero-cost=\(.invalidZeroCost)" else "" end)
         + (if .unknownCounterfactual > 0 then " unknown-counterfactual=\(.unknownCounterfactual)" else "" end)
         + (if .inconsistentCounterfactual > 0 then " basis-inconsistent-counterfactual=\(.inconsistentCounterfactual)" else "" end)),
      "==================================",
      "TOTAL — \($gn) compaction(s), spent \(money($gr)) [reported basis only], derived-upper-bound \(money($gd)) [not counted as spent], default-path counterfactual \(money($gcf))"
        + (if $gu > 0 then ", unknown-cost=\($gu)" else "" end)
        + (if $gub > 0 then ", unknown-basis=\($gub)" else "" end)
        + (if $gbpm > 0 then ", basis-path-mismatch=\($gbpm)" else "" end)
        + (if $gir > 0 then ", invalid-reported=\($gir)" else "" end)
        + (if $giz > 0 then ", invalid-zero-cost=\($giz)" else "" end)
        + (if $guc > 0 then ", unknown-counterfactual=\($guc)" else "" end)
        + (if $gic > 0 then ", basis-inconsistent-counterfactual=\($gic)" else "" end)
        + (if $invalidRecords > 0 then ", invalid-record=\($invalidRecords)" else "" end)
        + (if $parseErrors > 0 then ", parse-error=\($parseErrors)" else "" end)
        + (if $trailingPartial > 0 then ", trailing-partial=\($trailingPartial)" else "" end)
        + (if $incomplete > 0 then ", totals-incomplete" else "" end)
  ' "$file"
}

self_test() {
  local dir f complete fails=0 out rc
  dir="$(mktemp -d "${TMPDIR:-/tmp}/compaction-metrics-st.XXXXXX")"
  f="$dir/events.jsonl"
  cat > "$f" <<'EOF'
{"ts":"2026-07-21T00:00:00Z","sessionId":"s1","policy":"untagged","mode":"deterministic","path":"deterministic","rung":"full","tokensBefore":100000,"summaryTokens":4000,"latencyMs":12,"costBasis":"zero","costUSD":0,"counterfactualDefaultCostUSD":0.12,"components":{"summaryTokensEst":4000,"inputPerMTok":1,"outputPerMTok":5}}
{"ts":"2026-07-21T01:00:00Z","sessionId":"s1","policy":"untagged","mode":"hybrid","path":"fallthrough","reason":"tool-call-ratio-low","tokensBefore":80000,"summaryTokens":2000,"latencyMs":45000,"costBasis":"derived","costUSD":0.09}
{"ts":"2026-07-21T01:30:00Z","sessionId":"s1","policy":"untagged","mode":"hybrid","path":"fallthrough","reason":"too-many-tokens","tokensBefore":90000,"summaryTokens":1500,"latencyMs":40000,"costBasis":"reported","costUSD":0.03,"counterfactualDefaultCostUSD":0.5,"usage":{"input":40000,"output":1500,"cacheRead":45000,"cacheWrite":0,"totalTokens":86500}}
{"ts":"2026-07-21T01:35:00Z","sessionId":"s1","policy":"untagged","mode":"hybrid","path":"fallthrough","tokensBefore":85000,"latencyMs":41000,"costBasis":"reported","costUSD":null,"usage":{"input":40000,"output":1500,"cacheRead":45000,"cacheWrite":0,"totalTokens":86500}}
{"ts":"2026-07-21T01:40:00Z","sessionId":"s1","policy":"untagged","mode":"hybrid","path":"fallthrough","tokensBefore":82000,"latencyMs":42000,"costBasis":"reported","costUSD":"0.05","usage":{"input":40000,"output":1500,"cacheRead":45000,"cacheWrite":0,"totalTokens":86500}}
{"ts":"2026-07-21T01:45:00Z","sessionId":"s1","policy":"untagged","mode":"hybrid","path":"fallthrough","tokensBefore":81000,"latencyMs":43000,"costBasis":"derived","costUSD":-0.01}
{"ts":"2026-07-21T01:50:00Z","sessionId":"s1","policy":"untagged","mode":"hybrid","path":"fallthrough","reason":"control\nTOTAL — forged","tokensBefore":80000,"latencyMs":44000,"costUSD":0.02}
bad json
{"ts":"2026-07-21T02:00:00Z","sessionId":"s2","policy":"compact-b","mode":"deterministic","path":"deterministic","rung":"full","tokensBefore":50000,"summaryTokens":1000,"latencyMs":8,"costBasis":"zero","costUSD":0,"counterfactualDefaultCostUSD":0.055}
{"ts":"2026-07-21T02:05:00Z","sessionId":"s2","policy":"compact-b","mode":"deterministic","path":"deterministic","tokensBefore":51000,"latencyMs":9,"costBasis":"zero","costUSD":0.01,"counterfactualDefaultCostUSD":0.06}
{"ts":"2026-07-21T02:10:00Z","sessionId":"s3","policy":"compact-c","mode":"deterministic","path":"deterministic","tokensBefore":52000,"latencyMs":10,"costBasis":"zero","costUSD":0}
{"ts":"2026-07-21T02:15:00Z","sessionId":"bad-matrix","policy":"untagged","mode":"deterministic","path":"ladder-exhausted","tokensBefore":53000,"latencyMs":11,"costBasis":"derived","costUSD":0.2}
{"ts":"","sessionId":"","policy":"untagged","mode":null,"path":"not-a-compaction-path","tokensBefore":0,"latencyMs":0,"costBasis":"reported","costUSD":1}
EOF
  printf 'partial' >> "$f"
  if out="$(render_table "$f")"; then
    if printf '%s\n' "$out" | grep -q 'path=deterministic'; then
      ok self-test "table renders deterministic row"
    else
      err self-test "missing deterministic row"; fails=1
    fi
    if printf '%s\n' "$out" | grep -q 'basis=reported'; then
      ok self-test "table renders reported row"
    else
      err self-test "missing reported row"; fails=1
    fi
    if printf '%s\n' "$out" | grep -q "basis=unknown.*cost=\\\$0.02"; then
      ok self-test "table labels missing basis as unknown"
    else
      err self-test "missing-basis row not labeled unknown"; fails=1
    fi
    if printf '%s\n' "$out" | grep -q 'basis=reported.*cost=n/a'; then
      ok self-test "table renders invalid cost as n/a"
    else
      err self-test "invalid cost not rendered as n/a"; fails=1
    fi
    if [ "$(printf '%s\n' "$out" | grep -c '^INFO')" = "10" ] &&
       printf '%s\n' "$out" | grep -Fxq 'WARN  omitted-records invalid-record=2 parse-error=1 trailing-partial=1'; then
      ok self-test "malformed records are counted without aborting"
    else
      err self-test "record anomaly counts wrong"; fails=1
    fi
    if ! printf '%s\n' "$out" | grep -q '^TOTAL — forged'; then
      ok self-test "ledger controls cannot forge report lines"
    else
      err self-test "ledger control characters reached report output"; fails=1
    fi
  else
    err self-test "table rejects malformed fields"; fails=1
    out=""
  fi
  if out="$(render_rollup "self-test rollup" "$f")"; then
    if printf '%s\n' "$out" | grep -q 'deterministic: n=4'; then
      ok self-test "rollup groups by path"
    else
      err self-test "rollup grouping wrong"; fails=1
    fi
    expected="TOTAL — 10 compaction(s), spent \$0.03 [reported basis only], derived-upper-bound \$0.09 [not counted as spent], default-path counterfactual \$0.175, unknown-cost=3, unknown-basis=1, invalid-zero-cost=1, unknown-counterfactual=1, basis-inconsistent-counterfactual=1, invalid-record=2, parse-error=1, trailing-partial=1, totals-incomplete"
    if printf '%s\n' "$out" | grep -Fxq "$expected"; then
      ok self-test "rollup separates bases and reports exact aggregate anomalies"
    else
      err self-test "basis-separated totals wrong: $(printf '%s' "$out" | tail -1)"; fails=1
    fi
  else
    err self-test "rollup rejects malformed fields"; fails=1
    out=""
  fi
  SESSION="s2"
  if out="$(render_rollup "self-test session filter" "$f")" &&
     printf '%s\n' "$out" | grep -q 'TOTAL — 2 compaction(s)' &&
     printf '%s\n' "$out" | grep -Fq "spent \$0 [reported basis only]" &&
     printf '%s\n' "$out" | grep -q 'invalid-zero-cost=1' &&
     ! printf '%s\n' "$out" | grep -q "default-path counterfactual \\\$0.235"; then
    ok self-test "--session filters without mixing cost bases"
  else
    err self-test "session filter wrong"; fails=1
  fi
  SESSION=""
  GROUP_BY="policy-path"
  if out="$(render_rollup "self-test policy" "$f")" &&
     printf '%s\n' "$out" | grep -q 'compact-b / deterministic: n=2'; then
    ok self-test "policy x path cross-tab"
  else
    err self-test "policy cross-tab wrong"; fails=1
  fi
  GROUP_BY="path"
  complete="$dir/complete-malformed.jsonl"
  head -n 1 "$f" > "$complete"
  printf 'bad json\n' >> "$complete"
  out="$(render_rollup "self-test complete malformed final line" "$complete")"
  if printf '%s\n' "$out" | grep -q 'parse-error=1' &&
     ! printf '%s\n' "$out" | grep -q 'trailing-partial='; then
    ok self-test "newline-terminated malformed final line is a parse error"
  else
    err self-test "complete malformed final line misclassified"; fails=1
  fi
  returns_exit2() {
    rc=0
    "$@" >/dev/null 2>&1 || rc=$?
    [ "$rc" -eq 2 ]
  }
  if returns_exit2 "$0" --tail nope --self-test &&
     returns_exit2 "$0" --tail 100001 --self-test &&
     returns_exit2 "$0" --tail &&
     returns_exit2 "$0" --session; then
    ok self-test "argument failures consistently return exit 2"
  else
    err self-test "argument failure returned the wrong status"; fails=1
  fi
  rm -rf "$dir"
  echo "=================================="
  if [ "$fails" -eq 0 ]; then echo "PASS — 0 errors, 0 warnings"; return 0; fi
  echo "FAIL — ${fails} errors, 0 warnings"; return 1
}

if [ "$MODE" = "selftest" ]; then
  self_test
  exit $?
fi

display_file="$(printf '%q' "$EVENTS_FILE")"
[ -f "$EVENTS_FILE" ] || { err events "no events ledger at $display_file (no committed compactions recorded yet, or events.enabled=false)"; exit 2; }
[ -r "$EVENTS_FILE" ] || { err events "events ledger is unreadable: $display_file"; exit 2; }
if ! ledger_bytes="$(wc -c < "$EVENTS_FILE")"; then
  err events "could not read events ledger size: $display_file"
  exit 2
fi
[ "$ledger_bytes" -le "$MAX_LEDGER_BYTES" ] || { err events "events ledger exceeds the 64 MiB reporting limit"; exit 2; }

if [ "$TABLE" = "1" ]; then
  info "per-compaction events — $display_file"
  render_table "$EVENTS_FILE"
  echo
fi
render_rollup "rollup ($GROUP_BY)" "$EVENTS_FILE"
