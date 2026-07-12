#!/usr/bin/env bash
#
# test-bump-pi-runtime.sh — offline unit tests for scripts/bump-pi-runtime.sh
# (#449, ADR-0092). Network-free: `gh` is a PATH shim writing fixture
# responses; the script under test runs from a disposable fixture repo so
# write-path assertions never touch the real vendor pin.
#
# Exit codes: 0 all tests pass, 1 any test fails, 2 environment failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0
fail=0
t_ok()  { printf 'OK    [%s] %s\n' "$1" "$2"; pass=$((pass + 1)); }
t_err() { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; fail=$((fail + 1)); }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- Fixture repo: minimal tree the script needs ----------------------------
fx="$work/repo"
mkdir -p "$fx/scripts/lib" "$fx/agent/vendor/pi" "$fx/agent/extensions/subagent"
cp "$SCRIPT_DIR/bump-pi-runtime.sh" "$fx/scripts/"
cp "$SCRIPT_DIR/lib/semver-classify.sh" "$fx/scripts/lib/"
cp "$SCRIPT_DIR/lib/fetch-pi-binary.sh" "$fx/scripts/lib/"
printf 'v0.80.6-psmfd.1\n' > "$fx/agent/vendor/pi/VERSION"
printf '%064d  pi-linux-x64-v0.80.6-psmfd.1.tar.gz\n' 0 > "$fx/agent/vendor/pi/CHECKSUMS"
{
  printf '# pi runtime vendor pin\n\n'
  printf '> **Pinned to pi `v0.80.6-psmfd.1`** (source: PSMFD-attested rebuilds on\n'
  printf '> [`psmfd/pi`](https://github.com/psmfd/pi/releases), upstream base `0.80.6`).\n'
} > "$fx/agent/vendor/pi/README.md"
printf '> **Vendored from pi 0.80.6** stub\n' > "$fx/agent/extensions/subagent/README.md"
git -C "$fx" init -q && git -C "$fx" add -A && \
  git -C "$fx" -c user.name=t -c user.email=t@t commit -qm fixture

# --- gh shim: behavior driven by GH_SHIM_MODE --------------------------------
shim="$work/bin"
mkdir -p "$shim"
cat > "$shim/gh" <<'SHIM'
#!/usr/bin/env bash
mode="${GH_SHIM_MODE:-none}"
case "$1 $2" in
  "auth status") exit 0 ;;
  "api repos/psmfd/pi/releases/latest"*) ;;
esac
case "$*" in
  *"releases/latest"*)
    case "$mode" in
      newer)   printf 'v0.80.7-psmfd.1\n'; exit 0 ;;
      current) printf 'v0.80.6-psmfd.1\n'; exit 0 ;;
      apifail) exit 1 ;;
    esac ;;
  "release download"*)
    # Write a fixture SHA256SUMS into the --dir argument.
    dir=""
    prev=""
    for a in "$@"; do [ "$prev" = "--dir" ] && dir="$a"; prev="$a"; done
    [ -n "$dir" ] || exit 1
    case "$mode" in
      attestfail|badsums|attestok|promote)
        if [ "$mode" = badsums ]; then
          printf 'nothexdigest  pi-linux-x64-v0.80.7-psmfd.1.tar.gz\n' > "$dir/SHA256SUMS"
        else
          # All six platform assets (fetch-pi-binary validates the CURRENT
          # platform's entry, so the fixture must be platform-complete) plus
          # the pi-sbom line the script must exclude.
          {
            for p in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
              printf '%064d  pi-%s-v0.80.7-psmfd.1.tar.gz\n' 1 "$p"
            done
            for p in windows-arm64 windows-x64; do
              printf '%064d  pi-%s-v0.80.7-psmfd.1.zip\n' 1 "$p"
            done
            printf '%064d  pi-sbom-v0.80.7-psmfd.1.cdx.json\n' 2
          } > "$dir/SHA256SUMS"
        fi
        exit 0 ;;
      *) exit 1 ;;
    esac ;;
  "attestation verify"*)
    case "$mode" in
      attestfail) exit 1 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 1
SHIM
chmod +x "$shim/gh"
run() { PATH="$shim:$PATH" GH_SHIM_MODE="$1" "$fx/scripts/bump-pi-runtime.sh" "${@:2}"; }

# --- Tests -------------------------------------------------------------------

# Argument validation (exit 2 class)
run none --tag v0.80.7-psmfd.1 --latest >/dev/null 2>&1 && t_err args "mutex accepted" || {
  [ $? -eq 2 ] && t_ok args "--tag/--latest mutual exclusion → exit 2" || t_err args "mutex wrong exit"; }
run none >/dev/null 2>&1 && t_err args "no target accepted" || {
  [ $? -eq 2 ] && t_ok args "missing target → exit 2" || t_err args "missing target wrong exit"; }
run none --tag 'v1.0.0;rm -rf /' >/dev/null 2>&1 && t_err taggate "injection tag accepted" || {
  [ $? -eq 2 ] && t_ok taggate "shell-metacharacter tag refused at the regex gate → exit 2" || t_err taggate "bad tag wrong exit"; }
run none --tag v1.0.0 >/dev/null 2>&1 && t_err taggate "plain upstream tag accepted" || {
  [ $? -eq 2 ] && t_ok taggate "plain vX.Y.Z (emergency-rollback shape) refused → exit 2" || t_err taggate "plain tag wrong exit"; }

# Idempotency and downgrade
run none --tag v0.80.6-psmfd.1 >/dev/null 2>&1 && t_ok idem "already-at-target no-op → exit 0" || t_err idem "no-op returned nonzero"
run none --tag v0.80.5-psmfd.1 >/dev/null 2>&1 && t_err downgrade "base downgrade accepted" || {
  [ $? -eq 2 ] && t_ok downgrade "older base refused → exit 2" || t_err downgrade "downgrade wrong exit"; }
# Same-base lower psmfd.N: fixture pin is -psmfd.1, so use a fixture pinned at .2
printf 'v0.80.6-psmfd.2\n' > "$fx/agent/vendor/pi/VERSION"
run none --tag v0.80.6-psmfd.1 >/dev/null 2>&1 && t_err downgrade "psmfd.N downgrade accepted" || {
  [ $? -eq 2 ] && t_ok downgrade "same-base lower -psmfd.N refused → exit 2" || t_err downgrade "psmfd.N downgrade wrong exit"; }
printf 'v0.80.6-psmfd.1\n' > "$fx/agent/vendor/pi/VERSION"

# --check / --latest resolution
run current --latest --check >/dev/null 2>&1 && t_ok check "--check current → exit 0" || t_err check "--check current returned nonzero"
run newer --latest --check >/dev/null 2>&1 && t_err check "--check behind returned 0" || {
  [ $? -eq 1 ] && t_ok check "--check behind → exit 1" || t_err check "--check behind wrong exit"; }
run apifail --latest --check >/dev/null 2>&1 && t_err check "API failure treated as current" || {
  [ $? -eq 2 ] && t_ok check "latest-resolution API failure → exit 2 (never a silent no-drift)" || t_err check "API failure wrong exit"; }

# Attestation hard stop: nothing written
before_v="$(cat "$fx/agent/vendor/pi/VERSION")"
before_c="$(cat "$fx/agent/vendor/pi/CHECKSUMS")"
run attestfail --tag v0.80.7-psmfd.1 >/dev/null 2>&1 && t_err attest "attestation failure did not fail the run" || {
  [ $? -eq 1 ] && t_ok attest "attestation failure → exit 1 (hard stop)" || t_err attest "attestation failure wrong exit"; }
[ "$(cat "$fx/agent/vendor/pi/VERSION")" = "$before_v" ] && [ "$(cat "$fx/agent/vendor/pi/CHECKSUMS")" = "$before_c" ] \
  && t_ok attest "VERSION/CHECKSUMS untouched after attestation failure" \
  || t_err attest "attestation failure left partial writes"

# Checksum-shape gate on the STAGED copy: nothing written
run badsums --tag v0.80.7-psmfd.1 >/dev/null 2>&1 && t_err shape "malformed digests accepted" || {
  [ $? -eq 1 ] && t_ok shape "non-64-hex staged digests → exit 1" || t_err shape "shape gate wrong exit"; }
[ "$(cat "$fx/agent/vendor/pi/VERSION")" = "$before_v" ] \
  && t_ok shape "VERSION untouched after shape failure" \
  || t_err shape "shape failure left partial writes"

# Dirty-tree guard on the scoped file set
printf 'dirty\n' >> "$fx/agent/vendor/pi/CHECKSUMS"
run attestok --tag v0.80.7-psmfd.1 >/dev/null 2>&1 && t_err dirty "dirty target files accepted" || {
  [ $? -eq 2 ] && t_ok dirty "dirty target files refused → exit 2" || t_err dirty "dirty guard wrong exit"; }
git -C "$fx" checkout -q -- agent/vendor/pi/CHECKSUMS

# --- Promote/write path (review finding: previously untested) ----------------
# Stub the composed validators so the test exercises THIS script's
# orchestration (they have their own suites); pre-stage the fetch cache
# (cache hits skip download — #109) so promotion is reachable offline; the
# subagent README is paired to the TARGET base so the audit resolves
# "unchanged" without network and the manifest-regen stub must fire.
for stub in validate-pi-vendor.sh check-ext-ref-drift.sh validate-subagent-drift.sh; do
  printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/stub-calls.log"\nexit 0\n' "$stub" "$work" > "$fx/scripts/$stub"
  chmod +x "$fx/scripts/$stub"
done
printf '> **Vendored from pi 0.80.7** stub\n' > "$fx/agent/extensions/subagent/README.md"
git -C "$fx" add -A && git -C "$fx" -c user.name=t -c user.email=t@t commit -qm stubs
fxcache="$work/cache/pi_config"
mkdir -p "$fxcache/pi-v0.80.7-psmfd.1/pi" "$fxcache/downloads"
printf '#!/bin/sh\necho 0.80.7\n' > "$fxcache/pi-v0.80.7-psmfd.1/pi/pi"
chmod +x "$fxcache/pi-v0.80.7-psmfd.1/pi/pi"
for p in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  printf 'dummy-archive\n' > "$fxcache/downloads/pi-${p}-v0.80.7-psmfd.1.tar.gz"
done

if PATH="$shim:$PATH" GH_SHIM_MODE=promote XDG_CACHE_HOME="$work/cache" \
    "$fx/scripts/bump-pi-runtime.sh" --tag v0.80.7-psmfd.1 --no-exec-self-test >/dev/null 2>&1; then
  t_ok promote "write path completed → exit 0"
else
  t_err promote "write path failed (exit $?)"
fi
[ "$(cat "$fx/agent/vendor/pi/VERSION")" = "v0.80.7-psmfd.1" ] \
  && t_ok promote "VERSION promoted" || t_err promote "VERSION not promoted"
grep -q 'pi-linux-x64-v0.80.7-psmfd.1.tar.gz' "$fx/agent/vendor/pi/CHECKSUMS" \
  && t_ok promote "CHECKSUMS promoted" || t_err promote "CHECKSUMS not promoted"
grep -q 'pi-sbom' "$fx/agent/vendor/pi/CHECKSUMS" \
  && t_err promote "pi-sbom line leaked into CHECKSUMS" || t_ok promote "pi-sbom excluded from CHECKSUMS"
grep -qF 'Pinned to pi `v0.80.7-psmfd.1`' "$fx/agent/vendor/pi/README.md" \
  && t_ok promote "README pin header rewritten" || t_err promote "README header not rewritten"
grep -q 'upstream base `0.80.7`' "$fx/agent/vendor/pi/README.md" \
  && t_ok promote "README upstream base rewritten" || t_err promote "README base not rewritten"
grep -q '^validate-pi-vendor.sh' "$work/stub-calls.log" \
  && t_ok promote "validate-pi-vendor invoked post-promotion" || t_err promote "validate-pi-vendor not invoked"
grep -q -- '--fix --target extension-deps' "$work/stub-calls.log" \
  && t_ok promote "runtime-coupled pin fix invoked" || t_err promote "coupled-pin fix not invoked"
grep -q -- '--regenerate' "$work/stub-calls.log" \
  && t_ok promote "PATCH_MANIFEST regeneration fired (audit=unchanged, tree clean)" \
  || t_err promote "manifest regeneration did not fire on the pure-pin-refresh path"

printf '==================================\n'
if [ "$fail" -eq 0 ]; then
  printf 'PASS — %d test(s), 0 failure(s)\n' "$pass"
  exit 0
fi
printf 'FAIL — %d test(s), %d failure(s)\n' "$pass" "$fail"
exit 1
