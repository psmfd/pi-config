#!/usr/bin/env bash
#
# verify-guard-mutations.sh — prove that security-guard regression tests
# actually fail when their guard is removed (#931).
#
# The #916 lesson: a regression guard that still passes on buggy code is worse
# than no guard, because it certifies the gap. A green test is evidence only if
# it has been seen to go red for the right reason. This harness produces that
# evidence mechanically instead of by hand.
#
# For each entry in scripts/guard-mutations.json:
#   1. apply the registered edit(s) — a surgical change that DISABLES one guard
#   2. run the paired test suite
#   3. assert the suite failed AND the specifically named tests are among the
#      failures
#   4. restore the file, always
#
# Step 3 checks the NAMED tests, not just a non-zero exit. A mutation that
# breaks the build would otherwise "pass" this harness while proving nothing —
# the suite would have failed for the wrong reason.
#
# Fail-closed everywhere: an edit whose anchor no longer matches (or matches
# more than once) is an ERROR, not a skip. Silently skipping a drifted mutation
# is precisely how a harness like this rots into a green rubber stamp.
#
# Run:
#   ./scripts/verify-guard-mutations.sh                  verify every mutation
#   ./scripts/verify-guard-mutations.sh --filter <id>    verify one
#   ./scripts/verify-guard-mutations.sh --list           list without running
#   VERBOSE=1 ./scripts/verify-guard-mutations.sh        show suite output
#
# Exit codes:
#   0  every registered mutation was detected by its named tests
#   1  a mutation went undetected, or a named test did not fail
#   2  environment/precondition failure (missing tool, dirty tree, bad manifest)
#
# Tracked: package-agent active-grant boundary (#931). The manifest is
# repo-level so other boundaries can register without moving anything.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "verify-guard-mutations.sh: cannot cd to $REPO_DIR" >&2; exit 2; }

VERBOSE="${VERBOSE:-0}"
# Overridable so the harness's own fail-closed behaviour can be exercised
# against fixture manifests (see tests/guard-mutations/).
MANIFEST="${GUARD_MUTATIONS_MANIFEST:-scripts/guard-mutations.json}"
FILTER=""
LIST_ONLY=0

errors=0
checked=0

info() { printf 'INFO  %s\n' "$*"; }
ok()   { printf 'OK    [%s] %s\n' "$1" "$2"; }
err()  { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --filter) [ $# -ge 2 ] || { echo "ERROR --filter requires an id" >&2; exit 2; }; FILTER="$2"; shift 2 ;;
    --list)   LIST_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR unknown argument: $1" >&2; exit 2 ;;
  esac
done

for tool in jq git python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR $tool not found in PATH" >&2; exit 2; }
done
[ -f "$MANIFEST" ] || { echo "ERROR manifest not found: $MANIFEST" >&2; exit 2; }
jq -e . "$MANIFEST" >/dev/null 2>&1 || { echo "ERROR manifest is not valid JSON: $MANIFEST" >&2; exit 2; }

ids="$(jq -r '.mutations[].id' "$MANIFEST")"
[ -n "$ids" ] || { echo "ERROR manifest registers no mutations" >&2; exit 2; }

if [ "$LIST_ONLY" = "1" ]; then
  jq -r '.mutations[] | "\(.id)\t\(.file)\t\(.guard)"' "$MANIFEST"
  exit 0
fi

# A mutation is applied by editing a tracked file in place and restoring it
# afterwards. If that file already carries uncommitted changes, a restore would
# discard the operator's work — refuse rather than risk it.
for f in $(jq -r '.mutations[].file' "$MANIFEST" | sort -u); do
  if [ -n "$(git status --porcelain -- "$f")" ]; then
    echo "ERROR target file has uncommitted changes, refusing to mutate it: $f" >&2
    exit 2
  fi
done

restore_all() {
  for rf in $(jq -r '.mutations[].file' "$MANIFEST" | sort -u); do
    git checkout -- "$rf" 2>/dev/null || true
  done
}
trap restore_all EXIT INT TERM

info "Guard-mutation verification (manifest: $MANIFEST)"

for id in $ids; do
  if [ -n "$FILTER" ] && [ "$FILTER" != "$id" ]; then continue; fi
  checked=$((checked + 1))

  file="$(jq -r --arg i "$id" '.mutations[] | select(.id==$i) | .file' "$MANIFEST")"
  suite="$(jq -r --arg i "$id" '.mutations[] | select(.id==$i) | .suite' "$MANIFEST")"

  if [ ! -f "$file" ]; then err "$id" "target file not found: $file"; continue; fi
  if [ ! -x "$suite" ]; then err "$id" "suite not executable: $suite"; continue; fi

  # Apply every edit. python3 does the exactly-once check so an anchor that has
  # drifted is an error rather than a silent no-op.
  if ! MUT_ID="$id" MUT_FILE="$file" MUT_MANIFEST="$MANIFEST" python3 - <<'PY'
import json, os, sys
mid, path, manifest = os.environ["MUT_ID"], os.environ["MUT_FILE"], os.environ["MUT_MANIFEST"]
spec = next(m for m in json.load(open(manifest))["mutations"] if m["id"] == mid)
src = open(path, encoding="utf-8").read()
for n, edit in enumerate(spec["edits"], 1):
    find = edit["find"]
    count = src.count(find)
    if count != 1:
        sys.stderr.write(f"edit {n}: anchor occurs {count} time(s), expected exactly 1\n")
        sys.exit(1)
    src = src.replace(find, edit["replace"], 1)
open(path, "w", encoding="utf-8").write(src)
PY
  then
    err "$id" "could not apply mutation to $file (anchor drifted — update the manifest)"
    git checkout -- "$file" 2>/dev/null || true
    continue
  fi

  out="$("$suite" 2>&1)"
  suite_rc=$?
  # Restore before asserting, so an assertion failure never leaves a mutated
  # tree behind.
  git checkout -- "$file" 2>/dev/null || true

  clean="$(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g')"
  [ "$VERBOSE" = "1" ] && printf '%s\n' "$clean"

  if [ "$suite_rc" -eq 0 ]; then
    err "$id" "the guard was disabled and the suite still PASSED — the tests do not cover it"
    continue
  fi

  missing=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    # node --test picks its reporter from stdout: `spec` ("✖ <name> (1.2ms)")
    # on a TTY, `tap` ("not ok 3 - <name>") otherwise. Both appear in practice —
    # spec locally, tap on CI runners — so match either rather than assume.
    if printf '%s' "$clean" | grep -Fq "✖ $name"; then continue; fi
    if printf '%s' "$clean" | grep -E '^not ok [0-9]+ - ' | sed -E 's/^not ok [0-9]+ - //' \
         | grep -Fxq "$name"; then continue; fi
    missing="$missing
    - $name"
  done <<EOF
$(jq -r --arg i "$id" '.mutations[] | select(.id==$i) | .expectFailing[]' "$MANIFEST")
EOF

  if [ -n "$missing" ]; then
    # Include the tail of the suite output: without it, "not via the named
    # test(s)" is indistinguishable from a reporter-format mismatch.
    err "$id" "the suite failed, but not via the named test(s) — it may have failed for the wrong reason (e.g. a build error):$missing"
    printf '      --- last 15 lines of suite output ---\n' >&2
    printf '%s\n' "$clean" | tail -15 | sed 's/^/      /' >&2
    continue
  fi

  ok "$id" "guard disabled -> named test(s) failed as required"
done

trap - EXIT INT TERM
restore_all

echo "=================================="
if [ "$errors" -eq 0 ]; then
  printf 'PASS — 0 error(s), 0 warning(s), %s mutation(s) verified\n' "$checked"
  exit 0
fi
printf 'FAIL — %s error(s), 0 warning(s), %s mutation(s) checked\n' "$errors" "$checked"
exit 1
