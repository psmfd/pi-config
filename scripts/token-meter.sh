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
#   token-meter.sh --list             # list sessions (id, started, turns)
#   token-meter.sh --self-test        # fixture self-test (no ~/.pi needed)
#   token-meter.sh -h | --help
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

MODE="current"; TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session)   MODE="session"; TARGET="${2:?--session requires an id}"; shift 2 ;;
    --all-time)  MODE="all"; shift ;;
    --list)      MODE="list"; shift ;;
    --self-test) MODE="selftest"; shift ;;
    -h|--help)   sed -nE '/^# /{s/^# ?//;p;}; /^$/q' "$0"; exit 0 ;;
    *) err args "unknown flag: $1"; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { err deps "jq not found (required)"; exit 2; }

# Aggregate one-or-more JSONL files into a per-model table + TOTAL line. Reads raw
# lines and skips any that don't parse (`fromjson? // empty`) so a corrupt/partial
# trailing line never aborts the report. Prints via jq to keep bash off the math.
render_totals() { # render_totals <header-line> <file...>
  local header="$1"; shift
  info "$header"
  jq -Rrn '
    [inputs | fromjson? // empty]
    | (group_by(.model) | map({
        model: .[0].model,
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
      ($m[] | "INFO  \(.model): turns=\(.turns) input=\(.input) cacheRead=\(.cacheRead) output=\(.output) total=\(.total) cost=\(money(.costSeen; .cost))"),
      "==================================",
      "TOTAL — \($gturns) turns, \($gt) tokens, \(money($gcostSeen; $gcost))"
  ' "$@"
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
    rm -rf "$tmp"
    fails=0
    printf '%s' "$out" | grep -q 'total=6400' && ok self-test "sonnet aggregates two turns (5100+1300)" || { err self-test "sonnet total wrong"; fails=1; }
    printf '%s' "$out" | grep -q 'TOTAL — 3 turns, 6550 tokens' && ok self-test "grand total skips the corrupt line" || { err self-test "grand total wrong"; fails=1; }
    printf '%s' "$out" | grep -q '\$0.11' && ok self-test "cost sums reported turns only" || { err self-test "cost wrong"; fails=1; }
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
    render_totals "all-time across ${#files[@]} session(s)" "${files[@]}"
    exit 0
    ;;
  session)
    f="$SESSIONS_DIR/$(basename "$TARGET" .jsonl).jsonl"
    [ -f "$f" ] || { err session "session not found: $TARGET ($f)"; exit 1; }
    render_totals "session=$(basename "$f" .jsonl)" "$f"
    exit 0
    ;;
  current)
    [ -d "$SESSIONS_DIR" ] || { err sessions "no sessions dir yet: $SESSIONS_DIR (is token-meter enabled?)"; exit 1; }
    f="$(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null | head -n1)"
    [ -n "$f" ] && [ -f "$f" ] || { err sessions "no session logs under $SESSIONS_DIR"; exit 1; }
    render_totals "current session=$(basename "$f" .jsonl)" "$f"
    exit 0
    ;;
esac
