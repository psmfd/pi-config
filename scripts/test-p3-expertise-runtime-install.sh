#!/usr/bin/env bash
# test-p3-expertise-runtime-install.sh — red/green filesystem tests for the
# A2/P3 digest-attested runtime installer (ADR-0156, ADR-0157, ADR-0158).
#
# Usage:
#   ./scripts/test-p3-expertise-runtime-install.sh
#
# Exit codes:
#   0  every leg passed
#   1  one or more legs failed
#   2  environment or fixture-setup failure (missing tool, unusable scratch,
#      a fixture that could not be built)
#
# `set -e` is deliberately not used: every leg must run so the summary lists
# all failures, and negative legs expect non-zero exits. Every setup step goes
# through setup_or_die instead, and every negative leg asserts the specific
# refusal — exit 1, the installer's own message, and an unchanged selector —
# never a bare non-zero exit, so a crash or an unrelated guard cannot pass as
# the guard under test.
#
# Output follows agent/rules/script-output-conventions.md. The extra
# `not ok 1 - <leg>` line on a failure is consumed by
# scripts/verify-guard-mutations.sh, which strips the number and matches the
# leg name; keep it.
#
# Portability: GNU and BSD stat differ (-c versus -f) and macOS has no
# sha256sum. Both are probed once below. The setup-smoke workflow runs this
# suite on macos-latest.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
installer="$repo_root/scripts/install-expertise-runtime.sh"
implementation="$repo_root/scripts/install-expertise-runtime.py"
driver="$repo_root/scripts/fixtures/p3-expertise-runtime/install-test-driver.py"
errors=0
warnings=0
legs=0
comparisons=0
scratch=""

info() { printf 'INFO  %s\n' "$*"; }
ok() { legs=$((legs + 1)); printf 'OK    [%s] %s\n' "$1" "$2"; }
warn() { warnings=$((warnings + 1)); printf 'WARN  [%s] %s\n' "$1" "$2" >&2; }
fail() {
  legs=$((legs + 1))
  printf 'ERROR [%s] %s\n' "$1" "$2" >&2
  printf 'not ok 1 - %s\n' "$1"
  errors=$((errors + 1))
}
env_error() { printf 'ERROR [env] %s\n' "$1" >&2; }
# check <command...>: a guarded comparison inside a leg (counted separately
# from legs; a short-circuited chain stops counting at its first failure).
check() { comparisons=$((comparisons + 1)); "$@"; }
# setup_or_die <what> <command...>: fixture setup is never a test result.
setup_or_die() {
  local what="$1"
  shift
  if ! "$@"; then
    env_error "fixture setup failed: $what"
    exit 2
  fi
}
finish() {
  printf '%s\n' '=================================='
  if [ "$errors" -eq 0 ]; then
    printf 'PASS — 0 errors, %d warnings, %d legs, %d guarded comparisons\n' \
      "$warnings" "$legs" "$comparisons"
    exit 0
  fi
  printf 'FAIL — %d errors, %d warnings, %d legs, %d guarded comparisons\n' \
    "$errors" "$warnings" "$legs" "$comparisons"
  exit 1
}

# Invoked indirectly by trap.
# shellcheck disable=SC2329
cleanup() {
  if [ -n "$scratch" ]; then
    rm -rf -- "$scratch"
  fi
}
trap cleanup EXIT
# An interrupted run must reach the EXIT cleanup and must not continue to a
# summary; the handler exits with the conventional signal status.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

for tool in python3 find id; do
  command -v "$tool" >/dev/null 2>&1 || {
    env_error "required test tool is unavailable: $tool"
    exit 2
  }
done
# sha256 of stdin: sha256sum (GNU), shasum (macOS), openssl (either).
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r | awk '{print $1}'
  else
    return 1
  fi
}
sha256_of() { sha256_hex <"$1"; }
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1 &&
   ! command -v openssl >/dev/null 2>&1; then
  env_error "no sha256 tool available (sha256sum, shasum, or openssl)"
  exit 2
fi
# stat: GNU accepts -c with %a/%i/%Y/%s/%h; BSD uses -f with %Lp/%i/%m/%z/%l.
if stat -c %a . >/dev/null 2>&1; then
  stat_mode() { stat -c %a "$1"; }
  stat_ident() { stat -c '%i:%Y:%s' "$1"; }
  stat_links() { stat -c %h "$1"; }
elif stat -f %Lp . >/dev/null 2>&1; then
  stat_mode() { stat -f %Lp "$1"; }
  stat_ident() { stat -f '%i:%m:%z' "$1"; }
  stat_links() { stat -f %l "$1"; }
  warn env "GNU stat unavailable; using BSD stat -f formats"
else
  env_error "stat supports neither -c (GNU) nor -f (BSD)"
  exit 2
fi
[ -x "$installer" ] || { env_error "installer is missing or not executable"; exit 2; }
[ -x "$driver" ] || { env_error "P3 fixture driver is missing or not executable"; exit 2; }
[ -f "$implementation" ] || { env_error "P3 installer implementation is missing"; exit 2; }

scratch="$(mktemp -d "${TMPDIR:-/tmp}/pi-config-p3.XXXXXXXX")" || { env_error "mktemp failed"; exit 2; }
# Canonicalize once: the driver compares canonical paths, and TMPDIR may sit
# behind a symlink (macOS /tmp and /var/folders always do).
scratch="$(cd "$scratch" && pwd -P)" || { env_error "scratch is not enterable"; exit 2; }
chmod 700 "$scratch"
home="$scratch/home"
setup_or_die "test home" mkdir -m 700 "$home"
printf 'test-only\n' >"$home/.p3-runtime-test-root"
chmod 600 "$home/.p3-runtime-test-root"

# Invoked through setup_or_die.
# shellcheck disable=SC2329
make_fixture() {
  local directory="$1" kind="${2:-regular}" digest_mode="${3:-valid}"
  local payload_text="${4:-p3-linux-arm64-native-fixture}"
  mkdir -p "$directory" || return 1
  python3 - "$directory" "$kind" "$digest_mode" "$payload_text" <<'PY'
import hashlib, io, json, pathlib, sys, tarfile
root, kind, digest_mode = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
payload = (sys.argv[4] + "\n").encode()
payload_sha = hashlib.sha256(payload).hexdigest()
archive = root / "fixture.tar.gz"
with tarfile.open(archive, "w:gz") as bundle:
    if kind == "symlink":
        member = tarfile.TarInfo("vec0.so")
        member.type = tarfile.SYMTYPE
        member.linkname = "elsewhere"
        bundle.addfile(member)
    else:
        member = tarfile.TarInfo("../vec0.so" if kind == "traversal" else "vec0.so")
        member.size = len(payload)
        member.mode = 0o777
        bundle.addfile(member, io.BytesIO(payload))
        if kind == "extra":
            extra = b"unexpected\n"
            other = tarfile.TarInfo("extra.so")
            other.size = len(extra)
            bundle.addfile(other, io.BytesIO(extra))
archive.chmod(0o600)
archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
installed_sha = payload_sha if digest_mode == "valid" else "f" * 64
generation = f"v1-linux-arm64-sqlite-vec-v0.1.9-{installed_sha[:12]}"
manifest = {
    "schemaVersion": 1,
    "generation": generation,
    "platform": {"os": "linux", "arch": "arm64"},
    "compatibility": {"pi": "test-pi", "bun": "test-bun", "sqlite": "test-sqlite"},
    "source": {
        "url": "https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/fixture.tar.gz",
        "asset": "fixture.tar.gz",
        "sha256": archive_sha,
    },
    "files": [{
        "path": "native/sqlite-vec/vec0.so",
        "archivePath": "vec0.so",
        "sha256": installed_sha,
        "size": len(payload),
        "mode": "0600",
        "role": "native-library",
        "version": "v0.1.9",
    }],
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
(root / "generation").write_text(generation + "\n")
(root / "payload-sha256").write_text(payload_sha + "\n")
PY
}

# run_install <fixture> <root> [archive] [driver args...]
run_install() {
  local fixture="$1" root="$2" archive="${3:-$1/fixture.tar.gz}"
  shift 2
  [ $# -gt 0 ] && shift
  HOME="$home" python3 "$driver" --implementation "$implementation" \
    --manifest "$fixture/manifest.json" --archive "$archive" \
    --root "$root" --test-platform linux-arm64 "$@"
}

# expect_failure <leg> <fixture> <root> <message> [archive] [status]
# A refusal is only evidence when it is the classified kind (exit 1, or the
# given status for exit-2 manifest rejections), names the guard that fired,
# and leaves the selector as it was.
expect_failure() {
  local name="$1" fixture="$2" root="$3" message="$4" archive="${5:-}"
  local expected_status="${6:-1}"
  [ -n "$archive" ] || archive="$fixture/fixture.tar.gz"
  local selector="$root/current-generation" before="" status=0
  if [ -e "$selector" ]; then
    before="$(sha256_of "$selector")"
  fi
  run_install "$fixture" "$root" "$archive" >"$scratch/$name.out" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    fail "$name" "installer accepted a refused state"
    return 1
  fi
  if [ "$status" -ne "$expected_status" ]; then
    fail "$name" "expected a classified refusal (exit $expected_status), got exit $status"
    sed -n '1,10p' "$scratch/$name.out" >&2
    return 1
  fi
  if ! grep -F -- "$message" "$scratch/$name.out" | grep -q '^ERROR'; then
    fail "$name" "refusal did not name the expected guard: $message"
    sed -n '1,10p' "$scratch/$name.out" >&2
    return 1
  fi
  if [ -n "$before" ]; then
    if [ "$(sha256_of "$selector")" != "$before" ]; then
      fail "$name" "selector changed after refusal"
      return 1
    fi
  elif [ -e "$selector" ]; then
    fail "$name" "selector appeared after refusal"
    return 1
  fi
  ok "$name" "refused ($message) without selecting a generation"
  return 0
}

base="$home/base"
setup_or_die "base fixture" make_fixture "$base"
root="$home/data/agent-expertise/runtime"
info "Running P3 runtime installation tests"

if run_install "$base" "$root" >"$scratch/fresh.out" 2>&1; then
  generation="$(cat "$base/generation")"
  generation_dir="$root/generations/$generation"
  selector="$root/current-generation"
  payload="$generation_dir/native/sqlite-vec/vec0.so"
  manifest="$generation_dir/manifest.json"
  if check test -d "$generation_dir" \
    && check test -f "$selector" \
    && check test -f "$payload" \
    && check test ! -L "$selector" \
    && check test ! -L "$payload" \
    && check test "$(stat_mode "$root")" = 700 \
    && check test "$(stat_mode "$generation_dir")" = 700 \
    && check test "$(stat_mode "$selector")" = 600 \
    && check test "$(stat_mode "$manifest")" = 600 \
    && check test "$(stat_mode "$payload")" = 600 \
    && check test "$(stat_links "$payload")" = 1 \
    && check test -z "$(find "$generation_dir" -type l -print -quit)" \
    && check test "$(sha256_of "$payload")" = "$(cat "$base/payload-sha256")"; then
    ok fresh_install "private, regular, digest-matching closed generation selected"
  else
    fail fresh_install "installed layout, modes, links, or digest are wrong"
  fi
else
  cat "$scratch/fresh.out" >&2
  fail fresh_install "installer failed on a valid fixture"
  finish
fi

before="$(stat_ident "$payload")"
selector_before="$(sha256_of "$selector")"
manifest_before="$(sha256_of "$manifest")"
payload_sha="$(cat "$base/payload-sha256")"
if run_install "$base" "$root" "$home/deliberately-missing-archive.tar.gz" >"$scratch/idempotent.out" 2>&1 \
  && check test "$before" = "$(stat_ident "$payload")" \
  && check test "$selector_before" = "$(sha256_of "$selector")"; then
  ok idempotent_rerun "existing generation revalidated offline without archive acquisition"
else
  fail idempotent_rerun "rerun changed or rejected valid installed state"
fi

archive_bad="$home/archive-bad"
setup_or_die "archive-bad fixture" cp -a "$base" "$archive_bad"
setup_or_die "archive-bad manifest" python3 - "$archive_bad/manifest.json" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); m=json.loads(p.read_text()); m["source"]["sha256"]="0"*64; p.write_text(json.dumps(m)+"\n")
PY
expect_failure archive_digest "$archive_bad" "$home/archive-bad-root" \
  "runtime archive digest mismatch"

extracted_bad="$home/extracted-bad"
setup_or_die "extracted-bad fixture" make_fixture "$extracted_bad" regular invalid
expect_failure extracted_digest "$extracted_bad" "$home/extracted-bad-root" \
  "installed file digest mismatch"

symlink_archive="$home/symlink-archive"
setup_or_die "symlink-archive fixture" make_fixture "$symlink_archive" symlink valid
expect_failure archive_symlink "$symlink_archive" "$home/symlink-archive-root" \
  "runtime archive contains a non-regular member"

extra_archive="$home/extra-archive"
setup_or_die "extra-archive fixture" make_fixture "$extra_archive" extra valid
expect_failure archive_inventory "$extra_archive" "$home/extra-archive-root" \
  "runtime archive inventory does not exactly match the manifest"

unsafe_root="$home/unsafe-root"
setup_or_die "unsafe root" mkdir -m 750 "$unsafe_root"
expect_failure unsafe_root_mode "$base" "$unsafe_root" \
  "mode must be exactly 0700"
check test "$(stat_mode "$unsafe_root")" = 750 || fail unsafe_root_mode "installer silently repaired unsafe root mode"

unsafe_parent="$home/unsafe-parent"
setup_or_die "unsafe parent" mkdir -m 770 "$unsafe_parent"
expect_failure writable_ancestor "$base" "$unsafe_parent/runtime" \
  "installation path contains a group/world-writable ancestor"
check test ! -e "$unsafe_parent/runtime" || fail writable_ancestor "installer wrote below a writable ancestor"

wrong_owner_root="$home/wrong-owner-root"
status=0
run_install "$base" "$wrong_owner_root" "$base/fixture.tar.gz" \
  --test-uid "$(( $(id -u) + 1 ))" >"$scratch/wrong-owner.out" 2>&1 || status=$?
if [ "$status" -eq 0 ]; then
  fail wrong_owner "installer accepted entries not owned by the expected UID"
elif [ "$status" -ne 1 ] || ! grep -Fq "ERROR installation path contains an untrusted owner" "$scratch/wrong-owner.out"; then
  sed -n '1,10p' "$scratch/wrong-owner.out" >&2
  fail wrong_owner "expected the untrusted-owner refusal (exit 1), got exit $status"
elif [ -e "$wrong_owner_root" ]; then
  fail wrong_owner "owner mismatch wrote installation state"
else
  ok wrong_owner "expected-UID mismatch failed before installation"
fi

symlink_target="$home/symlink-target"
setup_or_die "symlink target" mkdir -m 700 "$symlink_target"
setup_or_die "symlinked root" ln -s "$symlink_target" "$home/symlink-root"
expect_failure symlinked_root "$base" "$home/symlink-root" \
  "installation path contains a symlink"
check test ! -e "$symlink_target/current-generation" || fail symlinked_root "installer followed a symlinked root"

# The following legs share $root; each restores the fixture bytes it changed
# and asserts the restore, so a wrong restore cannot silently change what the
# next leg tests. Restoring is test setup, not installer repair.
setup_or_die "payload drift" python3 - "$payload" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
data = path.read_bytes()
path.write_bytes(bytes([data[0] ^ 1]) + data[1:])
PY
chmod 600 "$payload"
expect_failure existing_digest_drift "$base" "$root" \
  "installed file digest mismatch"
printf 'p3-linux-arm64-native-fixture\n' >"$payload"
chmod 600 "$payload"
check test "$(sha256_of "$payload")" = "$payload_sha" || { env_error "payload restore failed"; exit 2; }

printf 'unexpected\n' >"$generation_dir/unlisted"
chmod 600 "$generation_dir/unlisted"
expect_failure closed_inventory "$base" "$root" \
  "runtime generation inventory does not exactly match its manifest"
rm -f "$generation_dir/unlisted"

outside_link="$home/outside-hardlink"
setup_or_die "outside hard link" ln "$payload" "$outside_link"
expect_failure hard_link "$base" "$root" \
  "must have exactly one hard link"
rm -f "$outside_link"
check test "$(stat_links "$payload")" = 1 || { env_error "hard-link restore failed"; exit 2; }

printf '\n' >>"$manifest"
expect_failure installed_manifest_drift "$base" "$root" \
  "installed runtime manifest does not match the trusted source manifest"
setup_or_die "manifest restore" python3 - "$base/manifest.json" "$manifest" <<'PY'
import json, pathlib, sys
source = json.loads(pathlib.Path(sys.argv[1]).read_text())
pathlib.Path(sys.argv[2]).write_text(json.dumps(source, sort_keys=True, separators=(",", ":")) + "\n")
PY
chmod 600 "$manifest"
check test "$(sha256_of "$manifest")" = "$manifest_before" || { env_error "manifest restore failed"; exit 2; }

printf 'not-json\n' >"$selector"
chmod 600 "$selector"
expect_failure malformed_selector "$base" "$root" \
  "runtime selector is malformed"
printf '{"generation":"%s","manifestSha256":"%s","schemaVersion":1}\n' \
  "$generation" "$(sha256_of "$manifest")" >"$selector"
chmod 600 "$selector"
check test "$(sha256_of "$selector")" = "$selector_before" || { env_error "selector restore failed"; exit 2; }

# Traversal in the manifest and in the archive are exit-2 manifest/archive
# rejections, not exit-1 state refusals.
traversal_manifest="$home/traversal-manifest"
setup_or_die "traversal-manifest fixture" cp -a "$base" "$traversal_manifest"
setup_or_die "traversal-manifest edit" python3 - "$traversal_manifest/manifest.json" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); m=json.loads(p.read_text()); m["files"][0]["path"]="../escape/vec0.so"; p.write_text(json.dumps(m)+"\n")
PY
expect_failure manifest_traversal "$traversal_manifest" "$home/traversal-manifest-root" \
  "manifest.files[0].path is not a normalized relative path" "" 2
check test ! -e "$home/escape" || fail manifest_traversal "a traversal path escaped the generation"

traversal_archive="$home/traversal-archive"
setup_or_die "traversal-archive fixture" make_fixture "$traversal_archive" traversal valid
expect_failure member_traversal "$traversal_archive" "$home/traversal-archive-root" \
  "archive member is not a normalized relative path" "" 2

printf '{"generation":"%s","manifestSha256":"%s","schemaVersion":1}\n' \
  "$generation" "$(printf 'f%.0s' $(seq 1 64))" >"$selector"
chmod 600 "$selector"
expect_failure selector_digest "$base" "$root" \
  "runtime selector manifest digest mismatch"
printf '{"generation":"%s","manifestSha256":"%s","schemaVersion":1}\n' \
  "$generation" "$(sha256_of "$manifest")" >"$selector"
chmod 600 "$selector"
check test "$(sha256_of "$selector")" = "$selector_before" || { env_error "selector restore failed"; exit 2; }

printf '{"generation":"v1-linux-arm64-sqlite-vec-v0.1.9-ffffffffffff","manifestSha256":"%s","schemaVersion":1}\n' \
  "$(sha256_of "$manifest")" >"$selector"
chmod 600 "$selector"
expect_failure selector_untrusted "$base" "$root" \
  "runtime selector references an untrusted generation"
printf '{"generation":"%s","manifestSha256":"%s","schemaVersion":1}\n' \
  "$generation" "$(sha256_of "$manifest")" >"$selector"
chmod 600 "$selector"
check test "$(sha256_of "$selector")" = "$selector_before" || { env_error "selector restore failed"; exit 2; }

printf 'x' >>"$payload"
expect_failure installed_size "$base" "$root" \
  "installed file size mismatch"
printf 'p3-linux-arm64-native-fixture\n' >"$payload"
chmod 600 "$payload"
check test "$(sha256_of "$payload")" = "$payload_sha" || { env_error "payload restore failed"; exit 2; }

malformed="$home/malformed"
setup_or_die "malformed fixture" cp -a "$base" "$malformed"
setup_or_die "malformed manifest" python3 - "$malformed/manifest.json" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); text=p.read_text(); p.write_text(text.replace('"schemaVersion": 1,','"schemaVersion": 1,\n  "schemaVersion": 1,'))
PY
status=0
run_install "$malformed" "$home/malformed-root" >"$scratch/malformed.out" 2>&1 || status=$?
if [ "$status" -eq 2 ] && grep -Fq "ERROR manifest contains duplicate key" "$scratch/malformed.out"; then
  ok duplicate_manifest_key "closed manifest parser rejected the duplicate key (exit 2)"
else
  sed -n '1,10p' "$scratch/malformed.out" >&2
  fail duplicate_manifest_key "duplicate key was accepted or refused for another reason (exit $status)"
fi

unsupported_root="$home/unsupported-root"
status=0
HOME="$home" python3 "$driver" --implementation "$implementation" \
  --manifest "$base/manifest.json" --archive "$base/fixture.tar.gz" --root "$unsupported_root" \
  --test-platform linux-amd64 >"$scratch/unsupported.out" 2>&1 || status=$?
if [ "$status" -eq 2 ] && grep -Fq "ERROR unsupported host for expertise runtime installation" "$scratch/unsupported.out" \
  && [ ! -e "$unsupported_root" ]; then
  ok unsupported_platform "refused before filesystem mutation (exit 2)"
else
  sed -n '1,10p' "$scratch/unsupported.out" >&2
  fail unsupported_platform "unsupported platform was accepted, wrote state, or refused for another reason (exit $status)"
fi

after_stage_root="$home/after-stage-root"
status=0
run_install "$base" "$after_stage_root" "$base/fixture.tar.gz" --failpoint after-stage \
  >"$scratch/after-stage.out" 2>&1 || status=$?
if [ "$status" -ne 1 ] || ! grep -Fq "ERROR test failpoint after staged-generation validation" "$scratch/after-stage.out"; then
  sed -n '1,10p' "$scratch/after-stage.out" >&2
  fail interrupted_stage "after-stage failpoint was ignored or failed for another reason (exit $status)"
elif [ -e "$after_stage_root/current-generation" ] \
  || [ -e "$after_stage_root/generations/$(cat "$base/generation")" ] \
  || { [ -d "$after_stage_root/generations" ] \
       && find "$after_stage_root/generations" -mindepth 1 -maxdepth 1 -name '.staging-*' -print -quit | grep -q .; }; then
  fail interrupted_stage "failed staging became visible or was not cleaned"
else
  ok interrupted_stage "validated staging failure left no generation or selector"
fi

after_publish_root="$home/after-publish-root"
status=0
run_install "$base" "$after_publish_root" "$base/fixture.tar.gz" --failpoint after-publish \
  >"$scratch/after-publish.out" 2>&1 || status=$?
if [ "$status" -ne 1 ] || ! grep -Fq "ERROR test failpoint after generation publication" "$scratch/after-publish.out"; then
  sed -n '1,10p' "$scratch/after-publish.out" >&2
  fail interrupted_publish "after-publish failpoint was ignored or failed for another reason (exit $status)"
elif [ ! -d "$after_publish_root/generations/$(cat "$base/generation")" ] \
  || [ -e "$after_publish_root/current-generation" ]; then
  fail interrupted_publish "publication failure exposed a partial or selected generation"
elif run_install "$base" "$after_publish_root" >"$scratch/after-publish-retry.out" 2>&1 \
  && [ -f "$after_publish_root/current-generation" ]; then
  ok interrupted_publish "complete inert generation was selected only by a clean retry"
else
  fail interrupted_publish "clean retry could not validate and select the inert generation"
fi

concurrent_root="$home/concurrent-root"
run_install "$base" "$concurrent_root" >"$scratch/concurrent-a.out" 2>&1 &
pid_a=$!
run_install "$base" "$concurrent_root" >"$scratch/concurrent-b.out" 2>&1 &
pid_b=$!
wait "$pid_a"; rc_a=$?
wait "$pid_b"; rc_b=$?
if check test "$rc_a" -eq 0 \
  && check test "$rc_b" -eq 0 \
  && check test "$(find "$concurrent_root/generations" -mindepth 1 -maxdepth 1 -type d ! -name '.staging-*' | wc -l | tr -d ' ')" -eq 1 \
  && check test -f "$concurrent_root/current-generation"; then
  ok concurrent_install "serialized installers produced one complete selected generation"
else
  cat "$scratch/concurrent-a.out" "$scratch/concurrent-b.out" >&2
  fail concurrent_install "parallel installers produced inconsistent state"
fi

upgrade="$home/upgrade"
setup_or_die "upgrade fixture" make_fixture "$upgrade" regular valid p3-linux-arm64-upgrade-fixture
upgrade_root="$home/upgrade-root"
if ! run_install "$base" "$upgrade_root" >"$scratch/upgrade-old.out" 2>&1; then
  cat "$scratch/upgrade-old.out" >&2
  fail trusted_upgrade "could not install the prior trusted generation"
elif HOME="$home" python3 "$driver" --implementation "$implementation" \
  --manifest "$upgrade/manifest.json" --trusted-manifest "$base/manifest.json" \
  --trusted-manifest "$upgrade/manifest.json" --archive "$upgrade/fixture.tar.gz" \
  --root "$upgrade_root" --test-platform linux-arm64 >"$scratch/upgrade-new.out" 2>&1 \
  && check test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["generation"])' "$upgrade_root/current-generation")" \
    = "$(cat "$upgrade/generation")" \
  && check test "$(find "$upgrade_root/generations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 2; then
  ok trusted_upgrade "validated the prior trusted selector before atomically selecting the new generation"
else
  cat "$scratch/upgrade-new.out" >&2
  fail trusted_upgrade "approved prior-generation selection blocked or corrupted upgrade"
fi

# The exact pinned release archive must install against the checked-in manifest.
production_archive="$home/sqlite-vec-0.1.9-loadable-linux-aarch64.tar.gz"
setup_or_die "production archive copy" cp "$repo_root/scripts/fixtures/p3-expertise-runtime/sqlite-vec-0.1.9-loadable-linux-aarch64.tar.gz" "$production_archive"
chmod 600 "$production_archive"
production_root="$home/production-runtime"
production_manifest="$repo_root/agent/vendor/expertise-runtime/linux-arm64-v1.json"
if HOME="$home" python3 "$driver" --implementation "$implementation" \
  --manifest "$production_manifest" --archive "$production_archive" --root "$production_root" \
  --test-platform linux-arm64 >"$scratch/production-install.out" 2>&1 \
  && check test "$(sha256_of "$production_root/generations/v1-linux-arm64-sqlite-vec-v0.1.9-0b84cbd06418/native/sqlite-vec/vec0.so")" \
    = 0b84cbd06418ca3040827deddd650539be05be0f657952426b926c8606217437; then
  ok production_manifest_install "checked-in manifest installed the exact pinned release archive"
else
  cat "$scratch/production-install.out" >&2
  fail production_manifest_install "checked-in manifest and pinned release archive did not install end to end"
fi

override_root="$home/forbidden-production-override"
if PI_EXPERTISE_RUNTIME_TESTING=1 "$installer" --root "$override_root" >"$scratch/override.out" 2>&1 \
  || [ -e "$override_root" ]; then
  fail production_override_isolation "production entry accepted a test-only root override"
else
  ok production_override_isolation "production entry exposes no manifest, archive, root, or platform overrides"
fi

account_home="$(python3 -c 'import os,pwd; print(pwd.getpwuid(os.geteuid()).pw_dir)')"
account_runtime="$account_home/.local/share/agent-expertise/runtime"
if HOME="$account_home" python3 "$driver" --implementation "$implementation" \
  --manifest "$production_manifest" --archive "$account_home/.cache/not-used-by-refused-fixture" \
  --root "$account_runtime" --test-platform linux-arm64 >"$scratch/fixture-production-root.out" 2>&1; then
  fail fixture_production_root "fixture driver accepted the passwd-derived production HOME and root"
elif grep -Fq 'refuses the passwd-derived production HOME' "$scratch/fixture-production-root.out"; then
  ok fixture_production_root "fixture driver rejects its supported CLI before production-root access"
else
  cat "$scratch/fixture-production-root.out" >&2
  fail fixture_production_root "fixture driver refusal did not enforce the explicit production-home guard"
fi

production_alias="$home/production-runtime-alias"
setup_or_die "production alias" ln -s "$account_runtime" "$production_alias"
if HOME="$home" python3 "$driver" --implementation "$implementation" \
  --manifest "$production_manifest" --archive "$production_archive" \
  --root "$production_alias" --test-platform linux-arm64 >"$scratch/fixture-production-alias.out" 2>&1; then
  fail fixture_production_alias "fixture driver accepted an alias of the production root"
elif grep -Fq 'refuses the production runtime root' "$scratch/fixture-production-alias.out"; then
  ok fixture_production_alias "fixture driver rejects resolved aliases of the production root"
else
  cat "$scratch/fixture-production-alias.out" >&2
  fail fixture_production_alias "fixture driver did not enforce its explicit production-root guard"
fi

if "$installer" --check-manifest >"$scratch/real-manifest.out" 2>&1; then
  ok checked_manifest "production Linux ARM64 manifest is valid"
else
  cat "$scratch/real-manifest.out" >&2
  fail checked_manifest "production manifest failed validation"
fi

finish
