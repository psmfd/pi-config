#!/usr/bin/env bash
# Red-first regression suite for scripts/prompt-budget.sh (ADR-0150).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/prompt-budget.sh"
errors=0

ok() { printf 'OK    [%s] %s\n' "$1" "$2"; }
fail() { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }

command -v jq >/dev/null 2>&1 || {
  printf 'ERROR [env] jq is required\n' >&2
  exit 2
}
[ -x "$SUBJECT" ] || {
  printf 'ERROR [env] %s is missing or not executable\n' "$SUBJECT" >&2
  exit 2
}

fixture="$(mktemp -d "${TMPDIR:-/tmp}/prompt-budget-test.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
mkdir -p \
  "$fixture/agent/agents" \
  "$fixture/agent/skills/visible" \
  "$fixture/agent/skills/hidden" \
  "$fixture/agent/extensions/example" \
  "$fixture/scripts"

cat > "$fixture/agent/AGENTS.md" <<'DOC'
# Fixture

<!-- BEGIN agent-catalog (generated) -->
| Agent | Mode | Description |
| --- | --- | --- |
| fixture | read-only | fixture |
<!-- END agent-catalog -->

| Rule | Synopsis |
| --- | --- |
| fixture | fixture |
DOC

cat > "$fixture/agent/skills/visible/SKILL.md" <<'DOC'
---
name: visible
description: 'visible description'
---
Body.
DOC

cat > "$fixture/agent/skills/hidden/SKILL.md" <<'DOC'
---
name: hidden
description: 'hidden description'
disable-model-invocation: true
---
Body.
DOC

cat > "$fixture/agent/agents/one.md" <<'DOC'
---
name: one
tools: read
---
WRAPPER ONE
DOC

cat > "$fixture/agent/agents/two.md" <<'DOC'
WRAPPER TWO
DOC

cat > "$fixture/agent/extensions/example/index.ts" <<'DOC'
const metadata = { promptSnippet: "fixture", promptGuidelines: ["fixture"] };
DOC

agents_bytes="$(wc -c < "$fixture/agent/AGENTS.md" | tr -d ' ')"
visible_bytes="$(printf '%s' 'visiblevisible description' | wc -c | tr -d ' ')"
one_bytes="$(printf '%s' 'WRAPPER ONE' | wc -c | tr -d ' ')"
two_bytes="$(wc -c < "$fixture/agent/agents/two.md" | tr -d ' ')"

jq -n \
  --argjson agents "$agents_bytes" \
  --argjson skills "$visible_bytes" \
  --argjson one "$one_bytes" \
  --argjson two "$two_bytes" \
  '{version:1, unit:"bytes", budgets:{"agents-md":$agents,"skills-visible":$skills,"wrapper-files":{"agent/agents/one.md":$one,"agent/agents/two.md":$two}}}' \
  > "$fixture/scripts/prompt-budgets.json"

run_subject() {
  PROMPT_BUDGET_ROOT='' PROMPT_BUDGET_MANIFEST='' "$SUBJECT" "$@"
}

if run_subject --check --root "$fixture" >"$fixture/pass.log" 2>&1; then
  ok exact 'exact budgets pass'
else
  fail exact 'exact budgets must pass'
fi

if run_subject --root "$fixture" >"$fixture/report.log" 2>&1 \
  && grep -q '2 source sites across 1 files' "$fixture/report.log"; then
  ok metadata-sites 'promptSnippet and promptGuidelines occurrences are counted independently'
else
  fail metadata-sites 'extension metadata occurrence count is incorrect'
fi

jq '.budgets["agents-md"] -= 1' "$fixture/scripts/prompt-budgets.json" > "$fixture/scripts/next.json"
mv "$fixture/scripts/next.json" "$fixture/scripts/prompt-budgets.json"
if run_subject --check --root "$fixture" >"$fixture/red-agents.log" 2>&1; then
  fail red-agents 'agents-md breach unexpectedly passed'
else
  rc=$?
  if [ "$rc" -eq 1 ] && grep -q 'ERROR \[agents-md\]' "$fixture/red-agents.log"; then
    ok red-agents 'agents-md breach fails with exit 1'
  else
    fail red-agents "agents-md breach returned unexpected exit $rc"
  fi
fi

jq --argjson agents "$agents_bytes" --argjson cap "$((one_bytes - 1))" \
  '.budgets["agents-md"]=$agents | .budgets["wrapper-files"]["agent/agents/one.md"]=$cap' \
  "$fixture/scripts/prompt-budgets.json" > "$fixture/scripts/next.json"
mv "$fixture/scripts/next.json" "$fixture/scripts/prompt-budgets.json"
if run_subject --check --root "$fixture" >"$fixture/red-wrapper.log" 2>&1; then
  fail red-wrapper 'per-wrapper breach unexpectedly passed'
else
  rc=$?
  if [ "$rc" -eq 1 ] && grep -q 'ERROR \[wrapper-file\]' "$fixture/red-wrapper.log"; then
    ok red-wrapper 'per-wrapper breach fails with exit 1'
  else
    fail red-wrapper "per-wrapper breach returned unexpected exit $rc"
  fi
fi

jq --argjson agents "$agents_bytes" --argjson one "$one_bytes" \
  '.budgets["agents-md"]=$agents | .budgets["wrapper-files"]["agent/agents/one.md"]=$one' \
  "$fixture/scripts/prompt-budgets.json" > "$fixture/scripts/next.json"
mv "$fixture/scripts/next.json" "$fixture/scripts/prompt-budgets.json"
sed '/disable-model-invocation/d' "$fixture/agent/skills/hidden/SKILL.md" > "$fixture/agent/skills/hidden/next.md"
mv "$fixture/agent/skills/hidden/next.md" "$fixture/agent/skills/hidden/SKILL.md"
if run_subject --check --root "$fixture" >"$fixture/red-visible.log" 2>&1; then
  fail red-visible 'newly visible skill unexpectedly passed existing budget'
else
  rc=$?
  if [ "$rc" -eq 1 ] && grep -q 'ERROR \[skills-visible\]' "$fixture/red-visible.log"; then
    ok red-visible 'visibility change fails the skill budget'
  else
    fail red-visible "visibility breach returned unexpected exit $rc"
  fi
fi

awk '{ print; if ($0 ~ /^description:/) print "disable-model-invocation: true" }' \
  "$fixture/agent/skills/hidden/SKILL.md" > "$fixture/agent/skills/hidden/next.md"
mv "$fixture/agent/skills/hidden/next.md" "$fixture/agent/skills/hidden/SKILL.md"
jq 'del(.budgets["wrapper-files"]["agent/agents/two.md"])' \
  "$fixture/scripts/prompt-budgets.json" > "$fixture/scripts/next.json"
mv "$fixture/scripts/next.json" "$fixture/scripts/prompt-budgets.json"
if run_subject --check --root "$fixture" >"$fixture/missing.log" 2>&1; then
  fail manifest 'missing wrapper manifest entry unexpectedly passed'
else
  rc=$?
  if [ "$rc" -eq 2 ] && grep -q 'ERROR \[manifest\]' "$fixture/missing.log"; then
    ok manifest 'missing wrapper manifest entry fails closed with exit 2'
  else
    fail manifest "missing wrapper entry returned unexpected exit $rc"
  fi
fi

if run_subject --write-baseline --root "$fixture" >"$fixture/baseline.log" 2>&1 \
  && run_subject --check --root "$fixture" >"$fixture/roundtrip.log" 2>&1; then
  ok baseline 'generated baseline passes its own check'
else
  fail baseline 'generated baseline must pass its own check'
fi

jq --argjson exact "$agents_bytes" '.budgets["agents-md"]=$exact' \
  "$fixture/scripts/prompt-budgets.json" > "$fixture/scripts/next.json"
mv "$fixture/scripts/next.json" "$fixture/scripts/prompt-budgets.json"
if run_subject --write-baseline --root "$fixture" >"$fixture/ratchet.log" 2>&1 \
  && [ "$(jq -r '.budgets["agents-md"]' "$fixture/scripts/prompt-budgets.json")" -eq "$agents_bytes" ]; then
  ok ratchet 'baseline regeneration never raises an existing ceiling'
else
  fail ratchet 'baseline regeneration raised an existing ceiling'
fi

jq '.budgets["agents-md"]=0' "$fixture/scripts/prompt-budgets.json" > "$fixture/scripts/red.json"
rc=0
"$SCRIPT_DIR/validate-prompt-budget.sh" --probe-check \
  "$fixture" "$fixture/scripts/red.json" >"$fixture/validate-red.log" 2>&1 || rc=$?
if [ "$rc" -eq 1 ] && grep -q 'ERROR \[agents-md\]' "$fixture/validate-red.log"; then
  ok validate-entry 'intentional breach fails the required prompt-budget validation stage'
else
  fail validate-entry "required-stage breach proof failed (exit $rc)"
fi

printf '%s\n' '=================================='
if [ "$errors" -eq 0 ]; then
  printf 'PASS — 0 errors, 0 warnings\n'
else
  printf 'FAIL — %d errors, 0 warnings\n' "$errors"
  exit 1
fi
