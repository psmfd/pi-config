#!/usr/bin/env bash
#
# test-secrets-guard-hook.sh — regression tests for hooks/secrets-guard.sh.
#
# Each case creates an isolated git repository, stages one file, and invokes
# the hook directly. Scanner stubs verify that runtime failures block commits.
# Targets Bash 3.2+ and macOS system tools.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/hooks/secrets-guard.sh"

if [ ! -x "$HOOK" ]; then
  printf 'ERROR [bootstrap] hook not executable: %s\n' "$HOOK" >&2
  exit 2
fi
for required_command in git awk mktemp; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'ERROR [bootstrap] %s is required\n' "$required_command" >&2
    exit 2
  fi
done

PASS_COUNT=0
FAIL_COUNT=0
FAILED_CASES=()

repeat_char() {
  awk -v count="$1" -v char="$2" 'BEGIN {
    for (i = 0; i < count; i++) printf "%s", char
  }'
}

make_jwt() {
  printf 'eyJ%s.eyJ%s.%s\n' \
    "$(repeat_char "$1" a)" \
    "$(repeat_char "$2" b)" \
    "$(repeat_char "$3" c)"
}

make_scanner_stub() {
  local name="$1" directory="$2" real_git
  mkdir -p "$directory"
  if [ "$name" = "git" ]; then
    real_git="$(command -v git)"
    cat >"$directory/git" <<STUB
#!/usr/bin/env bash
case "\$*" in
  "diff --cached --name-only --diff-filter=ACM -z") exit 2 ;;
  *) exec "$real_git" "\$@" ;;
esac
STUB
  else
    cat >"$directory/$name" <<'STUB'
#!/usr/bin/env bash
exit 2
STUB
  fi
  chmod +x "$directory/$name"
}

# run_case <name> <expected-exit> <fixture-kind> [stub-command]
run_case() {
  local name="$1" expected="$2" fixture="$3" stub_command="${4:-}"
  local tmp path_prefix output status
  tmp="$(mktemp -d -t secrets-hook.XXXXXX)" || {
    printf 'ERROR [%s] mktemp failed\n' "$name" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_CASES+=("$name")
    return
  }

  (
    cd "$tmp" || exit 99
    git init -q . >/dev/null 2>&1
    case "$fixture" in
      clean) printf 'ordinary configuration\n' >probe.txt ;;
      pem)
        printf '%s%s\n' '-----BEGIN RSA ' 'PRIVATE KEY' >probe.txt
        ;;
      jwt-min) make_jwt 10 10 10 >probe.txt ;;
      jwt-max) make_jwt 4000 4000 4000 >probe.txt ;;
      jwt-header-under) make_jwt 9 10 10 >probe.txt ;;
      jwt-payload-under) make_jwt 10 9 10 >probe.txt ;;
      jwt-signature-under) make_jwt 10 10 9 >probe.txt ;;
      jwt-header-over) make_jwt 4001 10 10 >probe.txt ;;
      jwt-payload-over) make_jwt 10 4001 10 >probe.txt ;;
      jwt-signature-over) make_jwt 10 10 4001 >probe.txt ;;
      jwt-nested-valid-start)
        printf 'eyJ%s' "$(repeat_char 4001 a)" >probe.txt
        make_jwt 10 10 10 >>probe.txt
        ;;
      *) exit 98 ;;
    esac
    git add -- probe.txt >/dev/null 2>&1

    path_prefix=""
    if [ -n "$stub_command" ]; then
      make_scanner_stub "$stub_command" "$tmp/bin"
      path_prefix="$tmp/bin:"
    fi

    set +e
    output="$(env -i \
      HOME="$tmp/home" \
      LC_ALL=C \
      PATH="${path_prefix}/usr/bin:/bin" \
      bash "$HOOK" 2>&1)"
    status=$?
    set -e

    if [ "$status" -ne "$expected" ]; then
      printf 'FAIL  [%s] exit=%d, expected=%d\n' "$name" "$status" "$expected"
      printf '      output: %s\n' "$(printf '%s' "$output" | tr '\n' '|')"
      exit 1
    fi
    if [ "$expected" -eq 2 ]; then
      case "$output" in
        *'commit blocked'*) ;;
        *)
          printf 'FAIL  [%s] missing fail-closed diagnostic\n' "$name"
          printf '      output: %s\n' "$(printf '%s' "$output" | tr '\n' '|')"
          exit 1
          ;;
      esac
    fi
    printf 'OK    [%s] exit=%d\n' "$name" "$status"
  )
  status=$?
  rm -rf "$tmp"

  if [ "$status" -eq 0 ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_CASES+=("$name")
  fi
}

run_case clean 0 clean
run_case pem-secret 1 pem
run_case jwt-minimum-bound 1 jwt-min
run_case jwt-maximum-bound 1 jwt-max
run_case jwt-header-under-bound 0 jwt-header-under
run_case jwt-payload-under-bound 0 jwt-payload-under
run_case jwt-signature-under-bound 0 jwt-signature-under
run_case jwt-header-over-bound 0 jwt-header-over
run_case jwt-payload-over-bound 0 jwt-payload-over
run_case jwt-signature-over-bound 0 jwt-signature-over
run_case jwt-nested-valid-start 1 jwt-nested-valid-start
run_case grep-runtime-error 2 clean grep
run_case awk-runtime-error 2 clean awk
run_case git-enumeration-error 2 clean git

printf '\n'
if [ "$FAIL_COUNT" -gt 0 ]; then
  printf 'FAIL — %d errors, 0 warnings (%d tests passed)\n' "$FAIL_COUNT" "$PASS_COUNT"
  printf 'Failed cases:'
  for failed_case in "${FAILED_CASES[@]}"; do
    printf ' %s' "$failed_case"
  done
  printf '\n'
  exit 1
fi
printf 'PASS — 0 errors, 0 warnings (%d tests passed)\n' "$PASS_COUNT"
exit 0
