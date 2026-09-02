#!/usr/bin/env bash
#
# Static UTF-8 byte accounting for selected repository-authored prompt surfaces.
# Decision record: ADR-0150. Operating rule: agent/rules/prompt-budget.md.
#
# This tool does not claim complete prompt accounting. Tool schemas, pi's base
# prompt, dynamic extension content, expertise injection, and project context
# composition remain runtime-metered by prefill-meter/token-meter/cache-meter.
#
# Usage:
#   scripts/prompt-budget.sh
#   scripts/prompt-budget.sh --check
#   scripts/prompt-budget.sh --write-baseline [--headroom PCT]
#   scripts/prompt-budget.sh --root DIR [--manifest FILE]
#   scripts/prompt-budget.sh --verbose
#
# Exit codes: 0 pass/report, 1 budget breach, 2 environment/manifest failure.

set -euo pipefail

ok() { printf 'OK    [%s] %s\n' "$1" "$2"; }
info() { printf 'INFO  [%s] %s\n' "$1" "$2"; }
err() { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }
fatal() { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${PROMPT_BUDGET_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MANIFEST="${PROMPT_BUDGET_MANIFEST:-}"
MODE=report
VERBOSE=0
HEADROOM_PCT=5
errors=0

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --write-baseline) MODE=baseline ;;
    --verbose) VERBOSE=1 ;;
    --root)
      shift
      [ "$#" -gt 0 ] || fatal args '--root requires a directory'
      ROOT="$1"
      ;;
    --manifest)
      shift
      [ "$#" -gt 0 ] || fatal args '--manifest requires a file'
      MANIFEST="$1"
      ;;
    --headroom)
      shift
      [ "$#" -gt 0 ] || fatal args '--headroom requires a percentage'
      HEADROOM_PCT="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fatal args "unknown argument: $1" ;;
  esac
  shift
done

case "$HEADROOM_PCT" in
  ''|*[!0-9]*) fatal args '--headroom must be a non-negative integer' ;;
esac

[ -n "$MANIFEST" ] || MANIFEST="$ROOT/scripts/prompt-budgets.json"

file_bytes() { LC_ALL=C wc -c < "$1" | tr -d ' '; }
str_bytes() { LC_ALL=C printf '%s' "$1" | wc -c | tr -d ' '; }

frontmatter_of() {
  LC_ALL=C awk '
    NR == 1 && $0 == "---" { in_frontmatter = 1; next }
    in_frontmatter == 1 && $0 == "---" { exit }
    in_frontmatter == 1 { print }
  ' "$1"
}

frontmatter_value() {
  local file="$1" key="$2" line
  line="$(frontmatter_of "$file" | grep -m1 -E "^${key}:" || true)"
  [ -n "$line" ] || return 0
  line="${line#*:}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  case "$line" in
    \'*\') line="${line#\'}"; line="${line%\'}" ;;
    \"*\") line="${line#\"}"; line="${line%\"}" ;;
  esac
  printf '%s' "$line"
}

body_bytes_of() {
  command -v node >/dev/null 2>&1 || fatal env 'node is required for wrapper accounting'
  node - "$1" <<'NODE'
const fs = require("node:fs");
let content = fs.readFileSync(process.argv[2], "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\r/g, "\n");
let body = content;
if (content.startsWith("---")) {
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex !== -1) body = content.slice(endIndex + 4).trim();
}
process.stdout.write(String(Buffer.byteLength(body, "utf8")));
NODE
}

is_hidden_skill() {
  frontmatter_of "$1" \
    | grep -qE '^disable-model-invocation:[[:space:]]*true[[:space:]]*$'
}

round_up_64() { printf '%d' "$((($1 + 63) / 64 * 64))"; }

with_headroom() {
  local current="$1" slack
  if [ "$current" -eq 0 ]; then
    printf '0'
    return
  fi
  slack="$((current * HEADROOM_PCT / 100))"
  [ "$slack" -ge 256 ] || slack=256
  round_up_64 "$((current + slack))"
}

ratchet_ceiling() {
  local current="$1" existing="$2" label="$3" candidate
  candidate="$(with_headroom "$current")"
  if [ -z "$existing" ]; then
    printf '%s' "$candidate"
  elif [ "$current" -gt "$existing" ]; then
    fatal baseline "$label is already over its existing ceiling ($current > $existing); approve the growth explicitly before re-baselining"
  elif [ "$candidate" -lt "$existing" ]; then
    printf '%s' "$candidate"
  else
    printf '%s' "$existing"
  fi
}

AGENTS_BYTES=0
CATALOG_BYTES=0
TABLE_BYTES=0
PROSE_BYTES=0
VISIBLE_SKILL_BYTES=0
VISIBLE_SKILL_COUNT=0
HIDDEN_SKILL_COUNT=0
WRAPPER_TOTAL_BYTES=0
WRAPPER_COUNT=0
EXTENSION_PROMPT_FILES=0
EXTENSION_PROMPT_SITES=0
declare -a WRAPPER_PATHS=()
declare -a WRAPPER_BYTES=()

measure_all() {
  local agents_file="$ROOT/agent/AGENTS.md" file name description bytes hits
  [ -f "$agents_file" ] || fatal env "missing $agents_file"

  AGENTS_BYTES="$(file_bytes "$agents_file")"
  CATALOG_BYTES="$(sed -n '/<!-- BEGIN agent-catalog/,/<!-- END agent-catalog -->/p' "$agents_file" | wc -c | tr -d ' ')"
  TABLE_BYTES="$(awk '
    /<!-- BEGIN agent-catalog/ { in_catalog = 1 }
    /<!-- END agent-catalog -->/ { in_catalog = 0; next }
    !in_catalog && /^\|/ { print }
  ' "$agents_file" | wc -c | tr -d ' ')"
  PROSE_BYTES="$((AGENTS_BYTES - CATALOG_BYTES - TABLE_BYTES))"

  for file in "$ROOT"/agent/skills/*/SKILL.md; do
    [ -f "$file" ] || continue
    if is_hidden_skill "$file"; then
      HIDDEN_SKILL_COUNT="$((HIDDEN_SKILL_COUNT + 1))"
      continue
    fi
    name="$(frontmatter_value "$file" name)"
    description="$(frontmatter_value "$file" description)"
    bytes="$(( $(str_bytes "$name") + $(str_bytes "$description") ))"
    VISIBLE_SKILL_BYTES="$((VISIBLE_SKILL_BYTES + bytes))"
    VISIBLE_SKILL_COUNT="$((VISIBLE_SKILL_COUNT + 1))"
  done

  for file in "$ROOT"/agent/agents/*.md; do
    [ -f "$file" ] || continue
    bytes="$(body_bytes_of "$file")"
    WRAPPER_PATHS+=("${file#"$ROOT"/}")
    WRAPPER_BYTES+=("$bytes")
    WRAPPER_TOTAL_BYTES="$((WRAPPER_TOTAL_BYTES + bytes))"
    WRAPPER_COUNT="$((WRAPPER_COUNT + 1))"
  done

  while IFS= read -r file; do
    [ -f "$file" ] || continue
    hits="$(grep -Eo 'promptSnippet|promptGuidelines' "$file" | wc -l | tr -d ' ' || true)"
    [ "$hits" -gt 0 ] || continue
    EXTENSION_PROMPT_FILES="$((EXTENSION_PROMPT_FILES + 1))"
    EXTENSION_PROMPT_SITES="$((EXTENSION_PROMPT_SITES + hits))"
  done < <(find "$ROOT/agent/extensions" -type f -name '*.ts' -print | sort)
}

report_measurements() {
  local i
  ok agents-md "$AGENTS_BYTES bytes"
  info agents-md-segments "catalog=$CATALOG_BYTES tables=$TABLE_BYTES prose=$PROSE_BYTES bytes"
  ok skills-visible "$VISIBLE_SKILL_BYTES bytes across $VISIBLE_SKILL_COUNT visible skills ($HIDDEN_SKILL_COUNT hidden)"
  info wrappers-total "$WRAPPER_TOTAL_BYTES bytes across $WRAPPER_COUNT wrapper bodies; informational, not one-request cost"
  if [ "$VERBOSE" -eq 1 ]; then
    for i in "${!WRAPPER_PATHS[@]}"; do
      info wrapper "${WRAPPER_PATHS[$i]}=${WRAPPER_BYTES[$i]} bytes"
    done
  fi
  info extension-prompt-metadata "$EXTENSION_PROMPT_SITES source sites across $EXTENSION_PROMPT_FILES files; dynamic payload bytes remain runtime-metered"
  info runtime-only "tool schemas, pi base prompt, dynamic extension content, expertise blocks, and project context"
}

require_jq() {
  command -v jq >/dev/null 2>&1 || fatal env 'jq is required for manifest modes'
}

budget_number() {
  local expression="$1" label="$2"
  jq -er "$expression | if type == \"number\" then floor else error(\"not numeric\") end" "$MANIFEST" 2>/dev/null \
    || fatal manifest "missing or non-numeric budget: $label"
}

gate() {
  local label="$1" current="$2" budget="$3"
  if [ "$current" -le "$budget" ]; then
    ok "$label" "$current / $budget bytes"
  else
    err "$label" "$current bytes exceeds budget $budget"
  fi
}

run_report() {
  info scope 'selected static authored surfaces; UTF-8 bytes'
  measure_all
  report_measurements
  printf '%s\n' '=================================='
  printf 'PASS — 0 errors, 0 warnings\n'
}

run_check() {
  local agents_budget skills_budget wrapper_budget i path
  require_jq
  [ -f "$MANIFEST" ] || fatal manifest "missing $MANIFEST"
  jq -e '.version == 1 and .unit == "bytes" and (.budgets["wrapper-files"] | type == "object")' "$MANIFEST" >/dev/null 2>&1 \
    || fatal manifest 'unsupported schema; expected version=1, unit=bytes, wrapper-files object'

  measure_all
  agents_budget="$(budget_number '.budgets["agents-md"]' agents-md)"
  skills_budget="$(budget_number '.budgets["skills-visible"]' skills-visible)"
  gate agents-md "$AGENTS_BYTES" "$agents_budget"
  gate skills-visible "$VISIBLE_SKILL_BYTES" "$skills_budget"

  for i in "${!WRAPPER_PATHS[@]}"; do
    path="${WRAPPER_PATHS[$i]}"
    wrapper_budget="$(jq -er --arg path "$path" '.budgets["wrapper-files"][$path] | if type == "number" then floor else error("missing") end' "$MANIFEST" 2>/dev/null)" \
      || fatal manifest "missing wrapper budget: $path"
    gate wrapper-file "${WRAPPER_BYTES[$i]}" "$wrapper_budget"
    [ "$VERBOSE" -eq 1 ] && info wrapper-path "$path"
  done

  while IFS= read -r path; do
    [ -f "$ROOT/$path" ] || err manifest "stale wrapper budget: $path"
  done < <(jq -r '.budgets["wrapper-files"] | keys[]' "$MANIFEST")

  report_measurements
  printf '%s\n' '=================================='
  if [ "$errors" -eq 0 ]; then
    printf 'PASS — 0 errors, 0 warnings\n'
  else
    printf 'FAIL — %d errors, 0 warnings\n' "$errors"
    exit 1
  fi
}

run_baseline() {
  local temp_dir tmp next existing_manifest='' i path budget agents_budget skills_budget existing
  require_jq
  measure_all
  mkdir -p "$(dirname "$MANIFEST")"
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/prompt-budgets.XXXXXX")"
  tmp="$temp_dir/manifest.json"
  next="$temp_dir/next.json"
  trap 'rm -rf "${temp_dir:-}"' EXIT

  if [ -f "$MANIFEST" ]; then
    jq -e '.version == 1 and .unit == "bytes" and (.budgets["wrapper-files"] | type == "object")' "$MANIFEST" >/dev/null 2>&1 \
      || fatal manifest 'cannot ratchet an unsupported manifest schema'
    existing_manifest="$temp_dir/existing.json"
    cp "$MANIFEST" "$existing_manifest"
  fi

  existing=''
  [ -z "$existing_manifest" ] || existing="$(jq -er '.budgets["agents-md"] | if type == "number" then floor else empty end' "$existing_manifest" 2>/dev/null || true)"
  agents_budget="$(ratchet_ceiling "$AGENTS_BYTES" "$existing" agents-md)"
  existing=''
  [ -z "$existing_manifest" ] || existing="$(jq -er '.budgets["skills-visible"] | if type == "number" then floor else empty end' "$existing_manifest" 2>/dev/null || true)"
  skills_budget="$(ratchet_ceiling "$VISIBLE_SKILL_BYTES" "$existing" skills-visible)"

  jq -n \
    --argjson agents "$agents_budget" \
    --argjson skills "$skills_budget" \
    '{
      version: 1,
      unit: "bytes",
      scope: "Selected repository-authored prompt surfaces; see ADR-0150.",
      budgets: {
        "agents-md": $agents,
        "skills-visible": $skills,
        "wrapper-files": {}
      }
    }' > "$tmp"

  for i in "${!WRAPPER_PATHS[@]}"; do
    path="${WRAPPER_PATHS[$i]}"
    existing=''
    if [ -n "$existing_manifest" ]; then
      existing="$(jq -er --arg path "$path" '.budgets["wrapper-files"][$path] | if type == "number" then floor else empty end' "$existing_manifest" 2>/dev/null || true)"
    fi
    budget="$(ratchet_ceiling "${WRAPPER_BYTES[$i]}" "$existing" "$path")"
    jq --arg path "$path" --argjson budget "$budget" \
      '.budgets["wrapper-files"][$path] = $budget' "$tmp" > "$next"
    mv "$next" "$tmp"
  done

  mv "$tmp" "$MANIFEST"
  ok baseline "ratcheted ${MANIFEST#"$ROOT"/}; ceilings never increase (target headroom $HEADROOM_PCT%, minimum 256 bytes, rounded to 64)"
  printf '%s\n' '=================================='
  printf 'PASS — 0 errors, 0 warnings\n'
}

case "$MODE" in
  report) run_report ;;
  check) run_check ;;
  baseline) run_baseline ;;
esac
