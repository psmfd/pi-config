#!/usr/bin/env bash
# Required prompt-budget validation stage (ADR-0150, #1067).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode=full
root=''
manifest=''

if [ "${1:-}" = "--probe-check" ]; then
  mode=probe
  [ "$#" -eq 3 ] || {
    printf 'ERROR [args] --probe-check requires ROOT MANIFEST\n' >&2
    exit 2
  }
  root="$2"
  manifest="$3"
elif [ "$#" -ne 0 ]; then
  printf 'ERROR [args] unknown arguments\n' >&2
  exit 2
fi

if [ ! -x "$SCRIPT_DIR/prompt-budget.sh" ]; then
  printf 'ERROR [env] scripts/prompt-budget.sh missing or not executable\n' >&2
  exit 2
fi

if [ "$mode" = full ]; then
  unset PROMPT_BUDGET_ROOT PROMPT_BUDGET_MANIFEST
  if [ ! -x "$SCRIPT_DIR/test-prompt-budget.sh" ]; then
    printf 'ERROR [env] scripts/test-prompt-budget.sh missing or not executable\n' >&2
    exit 2
  fi
  "$SCRIPT_DIR/test-prompt-budget.sh"
  "$SCRIPT_DIR/prompt-budget.sh" --check
else
  PROMPT_BUDGET_ROOT="$root" PROMPT_BUDGET_MANIFEST="$manifest" \
    "$SCRIPT_DIR/prompt-budget.sh" --check
fi
