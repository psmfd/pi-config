#!/usr/bin/env bash
#
# token-meter.sh — report per-model token usage from token-meter's session logs.
#
# Reads the append-only JSONL the token-meter extension writes to
# ~/.pi/agent/extensions/token-meter/sessions/<session-id>.jsonl and aggregates
# by model. Reports; it does NOT gate — so it ends with a `TOTAL —` line rather
# than the PASS/FAIL summary block (script-output-conventions § scope note).
#
# Usage:
#   token-meter.sh                    # current session (most recent by mtime)
#   token-meter.sh --session <id>     # one named session
#   token-meter.sh --all-time         # aggregate across every session file
#   token-meter.sh --by-provider      # group by provider instead of model
#   token-meter.sh --by-tier          # group by tier (frontier/local/unmapped)
#   token-meter.sh --by-policy        # group by routing-policy tag (#521)
#   token-meter.sh --by-policy-tier   # policy x tier cross-tab
#   token-meter.sh --by-policy-model  # policy x model cross-tab
#   token-meter.sh --compare-policies # both cross-tabs in one report
#   token-meter.sh --list             # list sessions (id, started, turns)
#   token-meter.sh --self-test        # fixture self-test (no ~/.pi needed)
#   token-meter.sh -h | --help
#
# The grouping flags compose with the session-selection flags. The tier views
# map providers via the extension's committed tiers.json (override with
# TOKEN_METER_TIERS_FILE); providers absent from the map report as "unmapped".
# Local models rarely report cost, so tier cost renders "n/a" — the
# frontier-vs-local comparison is token-count-based, never a fabricated $0.
# Policy views bucket records with no `policy` field (pre-#521 logs, or an
# unset TOKEN_METER_POLICY_TAG) under "untagged" — never dropped. The sentinel
# is in lockstep with UNTAGGED in agent/extensions/token-meter/record.ts.
#
# Exit codes:
#   0 — report emitted (or --self-test passed)
#   1 — a named session was not found / no sessions exist
#   2 — environment failure (missing jq, or the sessions dir is unreadable)
#
# Requires: jq. Per agent/rules/script-output-conventions.md.

set -euo pipefail

ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
info() { printf 'INFO  %s\n' "$*"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; }

SESSIONS_DIR="${TOKEN_METER_SESSIONS_DIR:-${HOME}/.pi/agent/extensions/token-meter/sessions}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIERS_FILE="${TOKEN_METER_TIERS_FILE:-${SCRIPT_DIR}/../agent/extensions/token-meter/tiers.json}"

MODE="current"; TARGET=""; GROUP_BY="model"; COMPARE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --session)          MODE="session"; TARGET="${2:?--session requires an id}"; shift 2 ;;
    --all-time)         MODE="all"; shift ;;
    --by-provider)      GROUP_BY="provider"; shift ;;
    --by-tier)          GROUP_BY="tier"; shift ;;
    --by-policy)        GROUP_BY="policy"; shift ;;
    --by-policy-tier)   GROUP_BY="policy-tier"; shift ;;
    --by-policy-model)  GROUP_BY="policy-model"; shift ;;
    --compare-policies) COMPARE=1; shift ;;
    --list)             MODE="list"; shift ;;
    --self-test)        MODE="selftest"; shift ;;
    -h|--help)     sed -nE '/^# /{s/^# ?//;p;}; /^$/q' "$0"; exit 0 ;;
    *) err args "unknown flag: $1"; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { err deps "jq not found (required)"; exit 2; }

# Resolve the provider→tier map for the tier views (--by-tier, --by-policy-tier,
# and --compare-policies, which renders a policy x tier cross-tab). Missing/
# unparseable map degrades to {} (every provider reports "unmapped") rather than
# failing the report.
TIERS_JSON="{}"
if [ "$GROUP_BY" = "tier" ] || [ "$GROUP_BY" = "policy-tier" ] || [ "$COMPARE" = "1" ]; then
  if [ -f "$TIERS_FILE" ]; then
    TIERS_JSON="$(jq -c '.tiers // {}' "$TIERS_FILE" 2>/dev/null)" || TIERS_JSON="{}"
    [ -n "$TIERS_JSON" ] || TIERS_JSON="{}"
  else
    info "tiers file not found ($TIERS_FILE) — all providers will report as unmapped"
  fi
fi

# Aggregate one-or-more JSONL files into a grouped table + TOTAL line. Grouping
# key follows $GROUP_BY: model (default, historical output unchanged), provider,
# or tier (provider mapped through $TIERS_JSON; absent → "unmapped"). Reads raw
# lines and skips any that don't parse (`fromjson? // empty`) so a corrupt/partial
# trailing line never aborts the report. Prints via jq to keep bash off the math.
render_totals() { # render_totals <header-line> <file...>
  local header="$1"; shift
  info "$header"
  jq -Rrn --arg groupBy "$GROUP_BY" --argjson tiers "$TIERS_JSON" '
    # "untagged" is the lockstep sentinel with record.ts UNTAGGED — records with
    # no policy field (pre-#521 logs) bucket there, never dropped (#521).
    def policyof: if (.policy | type) == "string" and .policy != "" then .policy else "untagged" end;
    def tierof: ($tiers[(.provider // "unknown")] // "unmapped");
    def keyof:
      if $groupBy == "provider" then (.provider // "unknown")
      elif $groupBy == "tier" then tierof
      elif $groupBy == "policy" then policyof
      elif $groupBy == "policy-tier" then (policyof + " / " + tierof)
      elif $groupBy == "policy-model" then (policyof + " / " + (.model // "unknown"))
      else .model end;
    [inputs | fromjson? // empty]
    | (group_by(keyof) | map({
        name: (.[0] | keyof),
        turns: length,
        input: (map(.input // 0) | add),
        cacheRead: (map(.cacheRead // 0) | add),
        output: (map(.output // 0) | add),
        total: (map(.totalTokens // 0) | add),
        cost: (map(.costTotal // 0) | add),
        costSeen: (any(.[]; .costTotal != null))
      }) | sort_by(-.total)) as $m
    | (($m | map(.total) | add) // 0) as $gt
    | (($m | map(.turns) | add) // 0) as $gturns
    | (any($m[]; .costSeen)) as $gcostSeen
    | (($m | map(.cost) | add) // 0) as $gcost
    | def money(seen; c): if seen then "$" + (c*100|round/100|tostring) else "n/a" end;
      ($m[] | "INFO  \(.name): turns=\(.turns) input=\(.input) cacheRead=\(.cacheRead) output=\(.output) total=\(.total) cost=\(money(.costSeen; .cost))"),
      "==================================",
      "TOTAL — \($gturns) turns, \($gt) tokens, \(money($gcostSeen; $gcost))"
  ' "$@"
}

# --compare-policies: the two #521 cross-tabs back-to-back over one file set —
# the A/B report ("aggregating spend per policy x tier and per policy x model")
# as a single command instead of two flags to remember.
compare_policies() { # compare_policies <header-line> <file...>
  local header="$1"; shift
  GROUP_BY="policy-tier"
  render_totals "$header — policy x tier" "$@"
  GROUP_BY="policy-model"
  render_totals "$header — policy x model" "$@"
}

# Dispatch a report over the resolved file set: the normal single grouping, or
# the --compare-policies double render.
emit_report() { # emit_report <header-line> <file...>
  if [ "$COMPARE" = "1" ]; then compare_policies "$@"; else render_totals "$@"; fi
}

case "$MODE" in
  selftest)
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/token-meter-st.XXXXXX")"
    f="$tmp/s.jsonl"
    {
      printf '%s\n' '{"model":"sonnet","turns":1,"input":800,"cacheRead":4000,"cacheWrite":0,"output":300,"totalTokens":5100,"costTotal":0.1}'
      printf '%s\n' '{"model":"haiku","input":100,"cacheRead":0,"output":50,"totalTokens":150,"costTotal":0.01}'
      printf '%s\n' '{bad partial line with no newline handling'
      printf '%s\n' '{"model":"sonnet","input":200,"cacheRead":1000,"output":100,"totalTokens":1300,"costTotal":null}'
    } > "$f"
    out="$(render_totals "self-test" "$f")"
    fails=0
    printf '%s' "$out" | grep -q 'total=6400' && ok self-test "sonnet aggregates two turns (5100+1300)" || { err self-test "sonnet total wrong"; fails=1; }
    printf '%s' "$out" | grep -q 'TOTAL — 3 turns, 6550 tokens' && ok self-test "grand total skips the corrupt line" || { err self-test "grand total wrong"; fails=1; }
    printf '%s' "$out" | grep -q '\$0.11' && ok self-test "cost sums reported turns only" || { err self-test "cost wrong"; fails=1; }

    # Provider/tier grouping fixture: two frontier providers, one local (cost
    # null), one provider deliberately absent from the tier map.
    f2="$tmp/s2.jsonl"
    {
      printf '%s\n' '{"model":"claude-sonnet-5","provider":"anthropic","input":100,"cacheRead":0,"cacheWrite":0,"output":50,"totalTokens":150,"costTotal":0.02}'
      printf '%s\n' '{"model":"gpt-5-mini","provider":"github-copilot","input":200,"cacheRead":0,"cacheWrite":0,"output":100,"totalTokens":300,"costTotal":0.03}'
      printf '%s\n' '{"model":"coding-workhorse","provider":"omlx","input":400,"cacheRead":0,"cacheWrite":0,"output":200,"totalTokens":600,"costTotal":null}'
      printf '%s\n' '{"model":"mystery","provider":"acme","input":10,"cacheRead":0,"cacheWrite":0,"output":5,"totalTokens":15,"costTotal":null}'
    } > "$f2"
    tiersf="$tmp/tiers.json"
    printf '%s\n' '{"v":1,"tiers":{"anthropic":"frontier","github-copilot":"frontier","omlx":"local"}}' > "$tiersf"

    GROUP_BY="provider"
    out="$(render_totals "self-test provider" "$f2")"
    printf '%s' "$out" | grep -q 'omlx: turns=1 input=400 cacheRead=0 output=200 total=600 cost=n/a' \
      && ok self-test "provider grouping keeps null cost as n/a" || { err self-test "provider grouping wrong"; fails=1; }

    GROUP_BY="tier"
    TIERS_JSON="$(jq -c '.tiers // {}' "$tiersf")"
    out="$(render_totals "self-test tier" "$f2")"
    printf '%s' "$out" | grep -q 'frontier: turns=2 input=300 cacheRead=0 output=150 total=450 cost=\$0.05' \
      && ok self-test "tier grouping sums frontier providers" || { err self-test "frontier tier wrong"; fails=1; }
    printf '%s' "$out" | grep -q 'local: turns=1 .* total=600 cost=n/a' \
      && ok self-test "local tier stays token-count-based (n/a cost)" || { err self-test "local tier wrong"; fails=1; }
    printf '%s' "$out" | grep -q 'unmapped: turns=1 .* total=15' \
      && ok self-test "unlisted provider surfaces as unmapped" || { err self-test "unmapped tier wrong"; fails=1; }

    # Policy grouping fixture (#521): two tagged policies plus one record with
    # NO policy field at all (a pre-#521 log line) — it must bucket under
    # "untagged", never be dropped.
    f3="$tmp/s3.jsonl"
    {
      printf '%s\n' '{"model":"coding-workhorse","provider":"omlx","input":400,"cacheRead":0,"cacheWrite":0,"output":200,"totalTokens":600,"costTotal":null,"policy":"mixed-local"}'
      printf '%s\n' '{"model":"claude-sonnet-5","provider":"anthropic","input":100,"cacheRead":0,"cacheWrite":0,"output":50,"totalTokens":150,"costTotal":0.02,"policy":"mixed-local"}'
      printf '%s\n' '{"model":"claude-sonnet-5","provider":"anthropic","input":300,"cacheRead":0,"cacheWrite":0,"output":150,"totalTokens":450,"costTotal":0.06,"policy":"all-frontier"}'
      printf '%s\n' '{"model":"gpt-5-mini","provider":"github-copilot","input":20,"cacheRead":0,"cacheWrite":0,"output":10,"totalTokens":30,"costTotal":0.01}'
    } > "$f3"

    GROUP_BY="policy"
    out="$(render_totals "self-test policy" "$f3")"
    printf '%s' "$out" | grep -q 'mixed-local: turns=2 .* total=750' \
      && ok self-test "policy grouping sums a tagged policy" || { err self-test "policy grouping wrong"; fails=1; }
    printf '%s' "$out" | grep -q 'untagged: turns=1 .* total=30' \
      && ok self-test "record with no policy field buckets as untagged (never dropped)" \
      || { err self-test "untagged fallback wrong"; fails=1; }

    GROUP_BY="policy-tier"
    out="$(render_totals "self-test policy-tier" "$f3")"
    printf '%s' "$out" | grep -q 'mixed-local / local: turns=1 .* total=600 cost=n/a' \
      && ok self-test "policy x tier cross-tab keeps local cost honest" || { err self-test "policy-tier wrong"; fails=1; }
    printf '%s' "$out" | grep -q 'mixed-local / frontier: turns=1 .* total=150' \
      && ok self-test "policy x tier splits one policy across tiers" || { err self-test "policy-tier split wrong"; fails=1; }

    GROUP_BY="policy-model"
    out="$(render_totals "self-test policy-model" "$f3")"
    printf '%s' "$out" | grep -q 'all-frontier / claude-sonnet-5: turns=1 .* total=450' \
      && ok self-test "policy x model cross-tab" || { err self-test "policy-model wrong"; fails=1; }

    # compare_policies runs in the $() subshell, so its GROUP_BY writes don't leak.
    out="$(compare_policies "self-test compare" "$f3")"
    printf '%s' "$out" | grep -q 'policy x tier' && printf '%s' "$out" | grep -q 'policy x model' \
      && ok self-test "--compare-policies renders both cross-tabs" || { err self-test "compare-policies wrong"; fails=1; }

    rm -rf "$tmp"
    echo "=================================="
    if [ "$fails" -eq 0 ]; then echo "PASS — 0 errors, 0 warnings"; exit 0; fi
    echo "FAIL — ${fails} errors, 0 warnings"; exit 1
    ;;
  list)
    [ -d "$SESSIONS_DIR" ] || { info "no sessions yet ($SESSIONS_DIR)"; exit 0; }
    found=0
    info "session                       started               turns"
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      found=1
      id="$(basename "$f" .jsonl)"
      started="$(head -n1 "$f" | jq -r '.ts // "?"' 2>/dev/null || echo "?")"
      turns="$(grep -c . "$f" 2>/dev/null || echo 0)"
      printf 'INFO  %-28s  %-19s  %5s\n' "$id" "$started" "$turns"
    done < <(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null)
    [ "$found" = "1" ] || info "no sessions yet"
    exit 0
    ;;
  all)
    [ -d "$SESSIONS_DIR" ] || { err sessions "no sessions dir: $SESSIONS_DIR"; exit 1; }
    files=("$SESSIONS_DIR"/*.jsonl)
    [ -e "${files[0]}" ] || { err sessions "no session logs under $SESSIONS_DIR"; exit 1; }
    emit_report "all-time across ${#files[@]} session(s)" "${files[@]}"
    exit 0
    ;;
  session)
    f="$SESSIONS_DIR/$(basename "$TARGET" .jsonl).jsonl"
    [ -f "$f" ] || { err session "session not found: $TARGET ($f)"; exit 1; }
    emit_report "session=$(basename "$f" .jsonl)" "$f"
    exit 0
    ;;
  current)
    [ -d "$SESSIONS_DIR" ] || { err sessions "no sessions dir yet: $SESSIONS_DIR (is token-meter enabled?)"; exit 1; }
    f="$(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null | head -n1)"
    [ -n "$f" ] && [ -f "$f" ] || { err sessions "no session logs under $SESSIONS_DIR"; exit 1; }
    emit_report "current session=$(basename "$f" .jsonl)" "$f"
    exit 0
    ;;
esac
