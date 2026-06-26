#!/usr/bin/env bash
#
# test-gh-identity-hook.sh — shell-based test driver for
# hooks/gh-identity-guard.sh.
#
# Strategy:
#   - Per-case temp dir with an empty git repo (no real remote needed; the
#     hook is invoked directly with synthesized argv + stdin).
#   - PATH-shadowed `gh` stub that echoes a configurable login.
#   - Isolated HOME so the user's real ~/.pi/agent/settings.json never
#     leaks in.
#
# Output per agent/rules/script-output-conventions.md.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="${REPO_ROOT}/hooks/gh-identity-guard.sh"

if [ ! -x "$HOOK" ]; then
  printf 'ERROR [bootstrap] hook not executable: %s\n' "$HOOK" >&2
  exit 2
fi

# --- harness ---------------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
FAILED_CASES=()

# make_gh_stub <login> <exit-code> <tmpdir>
#   Writes <tmpdir>/bin/gh that, when called as `gh api /user --jq .login`,
#   echoes <login> and exits <exit-code>. All other invocations exit 0.
make_gh_stub() {
  local login="$1" rc="$2" dir="$3"
  mkdir -p "${dir}/bin"
  cat >"${dir}/bin/gh" <<EOF
#!/usr/bin/env bash
case "\$*" in
  "api /user --jq .login")
    printf '%s\n' '${login}'
    exit ${rc}
    ;;
  *)
    exit 0
    ;;
esac
EOF
  chmod +x "${dir}/bin/gh"
}

# run_case <name> <expected-exit> <remote-name> <remote-url> [extra env=val ...]
#
# Per-case fixtures controlled by caller-set env vars (consumed by harness):
#   STUB_LOGIN          login the gh stub should report (default: matches expected)
#   STUB_RC             gh stub exit code (default: 0)
#   EXPECTED_IDENTITY   text to write to .pi/expected-identity (empty = no file)
#   EXPECTED_IDENTITY_UNTRACKED
#                       "1" = write .pi/expected-identity but do not git-add it
#   USER_LAYER_LOGIN    login to write into ~/.pi/agent/settings.json
#                       (empty = no user-layer settings)
#   OMIT_GH             "1" = do not stub gh (simulates gh-not-on-PATH)
run_case() {
  local name="$1" want_rc="$2" rname="$3" rurl="$4"; shift 4
  local tmp
  tmp="$(mktemp -d -t gh-id-hook.XXXXXX)" || {
    printf 'ERROR [%s] mktemp failed\n' "$name" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_CASES+=("$name")
    return
  }
  (
    cd "$tmp" || exit 99
    git init -q . >/dev/null 2>&1
    # Per-repo file
    if [ -n "${EXPECTED_IDENTITY:-}" ]; then
      mkdir -p .pi
      printf '%s\n' "$EXPECTED_IDENTITY" >.pi/expected-identity
      if [ "${EXPECTED_IDENTITY_UNTRACKED:-0}" != "1" ]; then
        git add -- .pi/expected-identity >/dev/null 2>&1
      fi
      # Optional: make the pin unreadable (#268 unreadable-fall-through case).
      if [ -n "${CHMOD_PIN:-}" ]; then
        chmod "$CHMOD_PIN" .pi/expected-identity
      fi
    fi
    # User-layer fallback (under isolated HOME)
    local home="${tmp}/home"
    mkdir -p "${home}/.pi/agent"
    if [ -n "${USER_LAYER_LOGIN:-}" ]; then
      printf '{"extensionSettings":{"ghIdentityGuard":{"expectedIdentity":"%s"}}}\n' \
        "$USER_LAYER_LOGIN" >"${home}/.pi/agent/settings.json"
    fi
    # gh stub
    local path_prefix=""
    if [ "${OMIT_GH:-0}" != "1" ]; then
      make_gh_stub "${STUB_LOGIN:-TheSemicolon}" "${STUB_RC:-0}" "$tmp"
      path_prefix="${tmp}/bin:"
    fi
    # Run hook with isolated env. We unset SKIP/OVERRIDE here and let the
    # caller re-set them through positional env=val pairs.
    env -i \
      HOME="$home" \
      PATH="${path_prefix}/usr/bin:/bin" \
      TERM=dumb \
      "$@" \
      bash "$HOOK" "$rname" "$rurl" </dev/null >"${tmp}/stdout" 2>"${tmp}/stderr"
    local got_rc=$?
    if [ "$got_rc" -eq "$want_rc" ]; then
      printf 'OK    [%s] exit=%d (expected %d)\n' "$name" "$got_rc" "$want_rc"
      exit 0
    else
      printf 'FAIL  [%s] exit=%d (expected %d)\n' "$name" "$got_rc" "$want_rc"
      printf '      stdout: %s\n' "$(tr '\n' '|' <"${tmp}/stdout")"
      printf '      stderr: %s\n' "$(tr '\n' '|' <"${tmp}/stderr")"
      exit 1
    fi
  )
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_CASES+=("$name")
  fi
  rm -rf "$tmp"
  # Reset per-case env (sub-shell-isolated, but harness vars are re-read each call)
  unset STUB_LOGIN STUB_RC EXPECTED_IDENTITY EXPECTED_IDENTITY_UNTRACKED USER_LAYER_LOGIN OMIT_GH CHMOD_PIN
}

# --- cases -----------------------------------------------------------------

# 1. GitHub HTTPS remote, identity matches → pass
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "github-https-match" 0 origin "https://github.com/psmfd/pi-config.git"

# 2. GitHub SSH remote, identity matches → pass
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "github-ssh-match" 0 origin "git@github.com:psmfd/pi-config.git"

# 3. GitHub ssh:// URL form, match → pass
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "github-ssh-url-match" 0 origin "ssh://git@github.com/psmfd/pi-config.git"

# 4. GitHub HTTPS with token, match → pass
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "github-https-token-match" 0 origin "https://x-access-token:ghp_xxx@github.com/psmfd/pi-config.git"

# 5. GitHub remote, identity drift → fail (exit 1)
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="some-bot" \
  run_case "github-identity-drift" 1 origin "https://github.com/psmfd/pi-config.git"

# 6. ADO HTTPS remote → pass-through (exit 0), no identity check fired
EXPECTED_IDENTITY="" STUB_LOGIN="" OMIT_GH=1 \
  run_case "ado-https-passthrough" 0 origin "https://dev.azure.com/myorg/myproject/_git/myrepo"

# 7. ADO with org subdomain → pass-through
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "ado-org-subdomain-passthrough" 0 origin "https://myorg@dev.azure.com/myorg/myproject/_git/myrepo"

# 8. ADO SSH → pass-through
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "ado-ssh-passthrough" 0 origin "git@ssh.dev.azure.com:v3/myorg/myproject/myrepo"

# 9. Legacy visualstudio.com → pass-through
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "ado-visualstudio-passthrough" 0 origin "https://myorg.visualstudio.com/myproject/_git/myrepo"

# 10. GitLab remote → pass-through
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "gitlab-passthrough" 0 origin "git@gitlab.com:owner/repo.git"

# 11. Self-hosted Gitea → pass-through
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "gitea-passthrough" 0 origin "https://gitea.internal.example.com/owner/repo.git"

# 12. Bitbucket → pass-through
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "bitbucket-passthrough" 0 origin "git@bitbucket.org:owner/repo.git"

# 13. GitHub remote, no expected identity configured → fail-closed (exit 1)
EXPECTED_IDENTITY="" USER_LAYER_LOGIN="" STUB_LOGIN="TheSemicolon" \
  run_case "no-expected-identity-fail-closed" 1 origin "https://github.com/psmfd/pi-config.git"

# 14. GitHub remote, expected from user-layer settings.json → pass
EXPECTED_IDENTITY="" USER_LAYER_LOGIN="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "user-layer-fallback-match" 0 origin "https://github.com/psmfd/pi-config.git"

# 14b. Per-repo pin EXISTS but is UNREADABLE → must fall through to the user
# layer rather than being read (#268). The per-repo file names a *different*
# login ("some-bot"); if the hook could read it, the stub identity
# "TheSemicolon" would drift (exit 1). Because the file is unreadable, the
# hook falls through to the matching user-layer login → exit 0, proving the
# unreadable file was not consulted. `chmod 000` is a no-op for root, so this
# case only runs for a non-root tester.
if [ "$(id -u)" != "0" ]; then
  EXPECTED_IDENTITY="some-bot" CHMOD_PIN="000" \
  USER_LAYER_LOGIN="TheSemicolon" STUB_LOGIN="TheSemicolon" \
    run_case "unreadable-pin-falls-through-to-user-layer" 0 origin "https://github.com/psmfd/pi-config.git"
fi

# 15. GitHub remote, SKIP_GH_IDENTITY_GUARD=1 → pass with WARN
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "skip-env-bypass" 0 origin "https://github.com/psmfd/pi-config.git" \
  SKIP_GH_IDENTITY_GUARD=1

# 16. GitHub remote, valid GH_IDENTITY_OVERRIDE that matches stub → pass
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="bot-foo" \
  run_case "override-valid-and-matches" 0 origin "https://github.com/psmfd/pi-config.git" \
  GH_IDENTITY_OVERRIDE=bot-foo

# 17. GitHub remote, GH_IDENTITY_OVERRIDE valid but stub-login differs → fail
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="some-other-bot" \
  run_case "override-valid-but-mismatch" 1 origin "https://github.com/psmfd/pi-config.git" \
  GH_IDENTITY_OVERRIDE=bot-foo

# 18. GitHub remote, GH_IDENTITY_OVERRIDE with quoted value → unwrapped and applied
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="bot-foo" \
  run_case "override-quoted-value" 0 origin "https://github.com/psmfd/pi-config.git" \
  GH_IDENTITY_OVERRIDE='"bot-foo"'

# 19. GitHub remote, invalid GH_IDENTITY_OVERRIDE → fail (exit 1)
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "override-invalid-login" 1 origin "https://github.com/psmfd/pi-config.git" \
  GH_IDENTITY_OVERRIDE='not a valid login!'

# 20. GitHub remote, gh missing from PATH → fail-closed (exit 2)
EXPECTED_IDENTITY="TheSemicolon" OMIT_GH=1 \
  run_case "gh-missing-fail-closed" 2 origin "https://github.com/psmfd/pi-config.git"

# 21. GitHub remote, gh probe fails (exit 1 from stub) → fail-closed (exit 2)
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="" STUB_RC=1 \
  run_case "gh-probe-error-fail-closed" 2 origin "https://github.com/psmfd/pi-config.git"

# 22. Per-repo file with leading comment + blank lines → reads first valid line
EXPECTED_IDENTITY="$(printf '# this repo pushes as TheSemicolon\n\nTheSemicolon\n')" STUB_LOGIN="TheSemicolon" \
  run_case "per-repo-file-with-comments" 0 origin "https://github.com/psmfd/pi-config.git"

# --- regression cases for /review round 1 (2026-05-26) --------------------

# 23. Symlink-installed hook (the production install path) — invoke via a
#     symlink in $tmp/.git/hooks/pre-push. Would fail-closed with exit 2
#     before the resolve_symlink fix.
_symlink_case() {
  local name="symlink-install-path-resolves-helper"
  local tmp
  tmp="$(mktemp -d -t gh-id-hook.XXXXXX)"
  (
    cd "$tmp" || exit 99
    git init -q . >/dev/null 2>&1
    mkdir -p .pi .git/hooks bin
    printf 'TheSemicolon\n' >.pi/expected-identity
    git add -- .pi/expected-identity >/dev/null 2>&1
    ln -s "$HOOK" .git/hooks/pre-push
    make_gh_stub "TheSemicolon" 0 "$tmp"
    env -i \
      HOME="${tmp}/home" \
      PATH="${tmp}/bin:/usr/bin:/bin" \
      TERM=dumb \
      bash .git/hooks/pre-push origin "https://github.com/psmfd/pi-config.git" \
        </dev/null >"${tmp}/stdout" 2>"${tmp}/stderr"
    local rc=$?
    if [ "$rc" -eq 0 ]; then
      printf 'OK    [%s] exit=0 via symlink-installed hook\n' "$name"
      exit 0
    fi
    printf 'FAIL  [%s] exit=%d (expected 0)\n' "$name" "$rc"
    printf '      stdout: %s\n' "$(tr '\n' '|' <"${tmp}/stdout")"
    printf '      stderr: %s\n' "$(tr '\n' '|' <"${tmp}/stderr")"
    exit 1
  )
  local rc=$?
  if [ "$rc" -eq 0 ]; then PASS_COUNT=$((PASS_COUNT + 1));
  else FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_CASES+=("$name"); fi
  rm -rf "$tmp"
}
_symlink_case

# 24. Untracked per-repo pins are not authoritative (#306).
EXPECTED_IDENTITY="TheSemicolon" EXPECTED_IDENTITY_UNTRACKED=1 STUB_LOGIN="TheSemicolon" \
  run_case "untracked-per-repo-pin-ignored" 1 origin "https://github.com/psmfd/pi-config.git"

EXPECTED_IDENTITY="some-bot" EXPECTED_IDENTITY_UNTRACKED=1 \
USER_LAYER_LOGIN="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "untracked-per-repo-pin-falls-through-to-user-layer" 0 origin "https://github.com/psmfd/pi-config.git"

EXPECTED_IDENTITY="TheSemicolon" EXPECTED_IDENTITY_UNTRACKED=1 \
USER_LAYER_LOGIN="alice" STUB_LOGIN="TheSemicolon" \
  run_case "untracked-per-repo-pin-does-not-shadow-user-layer" 1 origin "https://github.com/psmfd/pi-config.git"

# 25. Multi-login array in user-layer JSON → any allowed login matches.
#     Tests parity with extension's array-membership semantics.
_array_case() {
  local name="$1" stub="$2" want_rc="$3"
  local tmp
  tmp="$(mktemp -d -t gh-id-hook.XXXXXX)"
  (
    cd "$tmp" || exit 99
    git init -q . >/dev/null 2>&1
    mkdir -p home/.pi/agent bin
    printf '{"extensionSettings":{"ghIdentityGuard":{"expectedIdentity":["alice","alice-bot"]}}}\n' \
      >home/.pi/agent/settings.json
    make_gh_stub "$stub" 0 "$tmp"
    env -i HOME="${tmp}/home" PATH="${tmp}/bin:/usr/bin:/bin" TERM=dumb \
      bash "$HOOK" origin "https://github.com/alice/repo.git" \
      </dev/null >"${tmp}/stdout" 2>"${tmp}/stderr"
    local rc=$?
    if [ "$rc" -eq "$want_rc" ]; then
      printf 'OK    [%s] exit=%d (expected %d, stub=%s)\n' "$name" "$rc" "$want_rc" "$stub"
      exit 0
    fi
    printf 'FAIL  [%s] exit=%d (expected %d, stub=%s)\n' "$name" "$rc" "$want_rc" "$stub"
    printf '      stderr: %s\n' "$(tr '\n' '|' <"${tmp}/stderr")"
    exit 1
  )
  local rc=$?
  if [ "$rc" -eq 0 ]; then PASS_COUNT=$((PASS_COUNT + 1));
  else FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_CASES+=("$name"); fi
  rm -rf "$tmp"
}
_array_case "multi-login-array-first-match" "alice" 0
_array_case "multi-login-array-second-match" "alice-bot" 0
_array_case "multi-login-array-no-match" "mallory" 1

# 25. Over-match regression — these MUST pass-through (non-GitHub):
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "notgithub-com-passthrough" 0 origin "https://notgithub.com/owner/repo.git"
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "github-com-attacker-tld-passthrough" 0 origin "https://github.com.attacker.tld/owner/repo.git"
EXPECTED_IDENTITY="" OMIT_GH=1 \
  run_case "github-internal-passthrough" 0 origin "https://github.company.internal/owner/repo.git"

# 26. Case-insensitive remote host match — UPPERCASE github.com is GitHub.
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "github-uppercase-host-matches" 0 origin "https://GITHUB.COM/psmfd/pi-config.git"

# 27. jq absent but settings.json present → no expected identity, fails closed
#     with a WARN about jq. Hard to simulate (jq is usually on PATH in test
#     env). Skip if jq is on PATH for the test runner; otherwise validate the
#     fail-closed message. This is a defensive coverage note rather than a
#     hard test case.

# 28. Login length cap — 50-char string with dashes shaped like the regex
#     would otherwise admit (bash group quirk) must be rejected.
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "override-too-long-rejected" 1 origin "https://github.com/psmfd/pi-config.git" \
  GH_IDENTITY_OVERRIDE="a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y"

# --- regression cases for /review round 2 (2026-05-26) --------------------

# 29. `@` in path of a github.com URL — must still be classified as GitHub
#     (split host from path BEFORE looking for userinfo `@`). Round-1
#     `extract_host` mistakenly treated `@v1` in path as userinfo and
#     extracted host `v1`, bypassing the guard.
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "github-at-in-path-still-classified" 0 origin "https://github.com/owner/repo@v1"

# 30. Double-`@` userinfo (RFC-violating but plausible from typo / hostile
#     injection): `https://user:pa@ss@github.com/...` must extract `github.com`
#     (rightmost `@` separates userinfo from authority), NOT `ss`.
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "github-double-at-userinfo" 0 origin "https://user:pa@ss@github.com/owner/repo.git"

# 31. Probe rc=2 fail-closed pathway (gh missing) still works after the
#     `probe_rc=$?` restructure. SSH-URL form for breadth.
EXPECTED_IDENTITY="TheSemicolon" OMIT_GH=1 \
  run_case "gh-missing-via-ssh-url" 2 origin "git@github.com:psmfd/pi-config.git"

# 32. Trailing-dot FQDN (absolute-DNS form) — `github.com.` must still be
#     classified as GitHub (RFC 3986 §3.2.2). Source: security-review
#     2026-05-27 LOW.
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "github-trailing-dot-fqdn" 0 origin "https://github.com./psmfd/pi-config.git"

# --- regression cases for EMU username support (#262) ---------------------

# 33. EMU login flows end-to-end: expected-identity is the EMU form, stub
#     reports the same, hook accepts. Real-world driver was Example-User_acme.
EXPECTED_IDENTITY="Example-User_acme" STUB_LOGIN="Example-User_acme" \
  run_case "emu-login-end-to-end" 0 origin "https://github.com/some-org/some-repo.git"

# 34. EMU login as a valid GH_IDENTITY_OVERRIDE value — must parse.
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="mona-cat_octo" \
  run_case "emu-override-valid" 0 origin "https://github.com/some-org/some-repo.git" \
  GH_IDENTITY_OVERRIDE=mona-cat_octo

# 35. EMU-shaped GH_IDENTITY_OVERRIDE with too-short shortcode — rejected.
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "emu-override-shortcode-too-short" 1 origin "https://github.com/psmfd/pi-config.git" \
  GH_IDENTITY_OVERRIDE=name_xy

# 36. EMU-shaped GH_IDENTITY_OVERRIDE with too-long shortcode — rejected.
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "emu-override-shortcode-too-long" 1 origin "https://github.com/psmfd/pi-config.git" \
  GH_IDENTITY_OVERRIDE=name_123456789

# 37. EMU-shaped GH_IDENTITY_OVERRIDE with second underscore — rejected.
EXPECTED_IDENTITY="TheSemicolon" STUB_LOGIN="TheSemicolon" \
  run_case "emu-override-multiple-underscores" 1 origin "https://github.com/psmfd/pi-config.git" \
  GH_IDENTITY_OVERRIDE=name_short_extra

# --- Interactive (TTY) bootstrap cases (ADR-0025) -------------------------
# The bootstrap path only fires with a controlling terminal (`[ -t 2 ]` AND an
# openable /dev/tty). The standard harness redirects stderr to a file, so all
# the cases above already exercise the NO-TTY fail-closed fallback (#13) and
# the override short-circuits (#15–#19) — none of them ever reach the prompt.
#
# To drive the interactive path we need a real pty so `[ -t 2 ]` is true and
# /dev/tty resolves. Bash alone cannot allocate a controlling terminal, so we
# use python3's os.forkpty (python3 is already a repo dependency — setup.sh,
# resolve_path). Skipped with a SKIP line if python3 is unavailable.
PTY_DRIVER=""
make_pty_driver() {
  PTY_DRIVER="$(mktemp -t gh-id-pty.XXXXXX)"   # no .py suffix: BSD mktemp -t treats trailing text as a literal prefix
  cat >"$PTY_DRIVER" <<'PYEOF'
import os, sys, select

hook, rname, rurl, feed, outpath = sys.argv[1:6]
feed_b = feed.encode()

# Empty git ref-list on stdin (immediate EOF) so /dev/tty != stdin, matching
# git's pre-push contract (git pipes the ref list; the terminal is separate).
r0, w0 = os.pipe()
os.close(w0)

pid, master = os.forkpty()
if pid == 0:
    # Child: fd 0/1/2 are the pty slave and it is the controlling terminal,
    # so `[ -t 2 ]` is true and /dev/tty works. Redirect fd 0 to the empty
    # ref-list pipe (git contract) — the hook prompts on /dev/tty, not stdin.
    os.dup2(r0, 0)
    os.execvpe("bash", ["bash", hook, rname, rurl], os.environ)
    os._exit(127)

os.close(r0)
try:
    os.write(master, feed_b)
except OSError:
    pass

out = b""
while True:
    try:
        rl, _, _ = select.select([master], [], [], 5.0)
    except OSError:
        break
    if not rl:
        break
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk

_, status = os.waitpid(pid, 0)
with open(outpath, "wb") as f:
    f.write(out)
if hasattr(os, "waitstatus_to_exitcode"):
    rc = os.waitstatus_to_exitcode(status)
else:
    rc = (status >> 8) if os.WIFEXITED(status) else 1
sys.exit(rc & 0xFF if rc >= 0 else 1)
PYEOF
}

# run_tty_case <name> <want-rc> <remote-url>
#   Env knobs:
#     TTY_ACTIVE_LOGIN   login the gh stub reports for `api /user`
#     TTY_IS_FORK        "1" => gh stub reports a non-null repo parent (fork)
#     TTY_FEED           bytes written to the pty (use $'y\\nlogin\\n')
#     TTY_EXTRA_ENV      extra KEY=VAL passed into the child env (e.g. a bypass)
#     TTY_EXPECT_FILE    "1" file must exist / "0" must not exist
#     TTY_EXPECT_CONTENT exact expected single-line content of the file
#     TTY_EXPECT_SUBSTR  substring that MUST appear in combined output
#     TTY_EXPECT_NOSUBSTR substring that must NOT appear in combined output
run_tty_case() {
  local name="$1" want_rc="$2" rurl="$3"
  local tmp got_rc
  tmp="$(mktemp -d -t gh-id-hook.XXXXXX)"
  (
    cd "$tmp" || exit 99
    git init -q . >/dev/null 2>&1
    mkdir -p bin home/.pi/agent
    cat >bin/gh <<EOF
#!/usr/bin/env bash
case "\$*" in
  "api /user --jq .login")
    printf '%s\n' '${TTY_ACTIVE_LOGIN:-}'
    ;;
  "repo view --json parent --jq "*)
    if [ "${TTY_IS_FORK:-0}" = "1" ]; then printf 'fork\n'; fi
    ;;
  *) : ;;
esac
exit 0
EOF
    chmod +x bin/gh
    # shellcheck disable=SC2086  # TTY_EXTRA_ENV must word-split into 0+ KEY=VAL env assignments
    env -i HOME="${tmp}/home" PATH="${tmp}/bin:/usr/bin:/bin" TERM=xterm ${TTY_EXTRA_ENV:-} \
      python3 "$PTY_DRIVER" "$HOOK" origin "$rurl" "${TTY_FEED:-}" "${tmp}/out"
    echo $? >"${tmp}/rc"
  )
  got_rc="$(cat "${tmp}/rc" 2>/dev/null || echo 99)"
  # NOTE: the pty driver breaks its read loop after 5s of no output, then
  # blocks in waitpid. Every case here feeds enough input (or an EOT) that
  # the hook exits well under 5s; an UNDER-fed case would instead stall the
  # hook in `read -t 60` and make waitpid wait the full 60s — always supply
  # complete input or a trailing \x04.
  local fpath="${tmp}/.pi/expected-identity" problems=""
  [ "$got_rc" = "$want_rc" ] || problems="exit=${got_rc}(want ${want_rc}) "
  if [ "${TTY_EXPECT_FILE:-}" = "1" ]; then
    if [ -f "$fpath" ]; then
      if [ -n "${TTY_EXPECT_CONTENT:-}" ] && [ "$(cat "$fpath")" != "$TTY_EXPECT_CONTENT" ]; then
        problems="${problems}content='$(cat "$fpath")'(want '${TTY_EXPECT_CONTENT}') "
      fi
    else
      problems="${problems}file-missing "
    fi
  elif [ "${TTY_EXPECT_FILE:-}" = "0" ]; then
    [ -f "$fpath" ] && problems="${problems}file-unexpectedly-present "
  fi
  if [ -n "${TTY_EXPECT_SUBSTR:-}" ]; then
    grep -qF "$TTY_EXPECT_SUBSTR" "${tmp}/out" 2>/dev/null || problems="${problems}substr-missing('${TTY_EXPECT_SUBSTR}') "
  fi
  if [ -n "${TTY_EXPECT_NOSUBSTR:-}" ]; then
    grep -qF "$TTY_EXPECT_NOSUBSTR" "${tmp}/out" 2>/dev/null && problems="${problems}nosubstr-present('${TTY_EXPECT_NOSUBSTR}') "
  fi
  if [ -z "$problems" ]; then
    printf 'OK    [%s] exit=%d\n' "$name" "$got_rc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf 'FAIL  [%s] %s\n' "$name" "$problems"
    printf '      out: %s\n' "$(tr '\n' '|' <"${tmp}/out" 2>/dev/null)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_CASES+=("$name")
  fi
  rm -rf "$tmp"
  unset TTY_ACTIVE_LOGIN TTY_IS_FORK TTY_FEED TTY_EXTRA_ENV TTY_EXPECT_FILE TTY_EXPECT_CONTENT TTY_EXPECT_SUBSTR TTY_EXPECT_NOSUBSTR
}

if command -v python3 >/dev/null 2>&1; then
  make_pty_driver

  # 38. TTY present, accept + re-type a valid login -> writes the file but
  #     STILL fails the push (ADR-0025 A1 commit-gate). File created.
  TTY_ACTIVE_LOGIN="TheSemicolon" TTY_FEED=$'y\nTheSemicolon\n' \
    TTY_EXPECT_FILE=1 TTY_EXPECT_CONTENT="TheSemicolon" TTY_EXPECT_SUBSTR="wrote" \
    run_tty_case "tty-bootstrap-create-then-fail-closed" 1 "https://github.com/psmfd/pi-config.git"

  # 39. TTY present, decline -> fall through to fail-closed, NO file written.
  TTY_ACTIVE_LOGIN="TheSemicolon" TTY_FEED=$'n\n' \
    TTY_EXPECT_FILE=0 TTY_EXPECT_SUBSTR="no expected GitHub identity configured" \
    run_tty_case "tty-bootstrap-decline" 1 "https://github.com/psmfd/pi-config.git"

  # 40. TTY present, accept then enter an INVALID login -> rejected, no file,
  #     single attempt (no retry loop).
  TTY_ACTIVE_LOGIN="TheSemicolon" TTY_FEED=$'y\nnot a valid login!\n' \
    TTY_EXPECT_FILE=0 TTY_EXPECT_SUBSTR="invalid GitHub login" \
    run_tty_case "tty-bootstrap-invalid-login-rejected" 1 "https://github.com/psmfd/pi-config.git"

  # 41. Suggestion shown when active login == remote owner and NOT a fork.
  TTY_ACTIVE_LOGIN="TheSemicolon" TTY_FEED=$'y\nTheSemicolon\n' \
    TTY_EXPECT_FILE=1 TTY_EXPECT_CONTENT="TheSemicolon" TTY_EXPECT_SUBSTR="suggestion" \
    run_tty_case "tty-bootstrap-suggestion-shown" 1 "https://github.com/psmfd/pi-config.git"

  # 42. Suggestion SUPPRESSED on a personal fork (gh repo view parent non-null)
  #     even though active login == owner (confused-deputy mitigation, B1).
  TTY_ACTIVE_LOGIN="TheSemicolon" TTY_IS_FORK="1" TTY_FEED=$'y\nTheSemicolon\n' \
    TTY_EXPECT_FILE=1 TTY_EXPECT_NOSUBSTR="suggestion" \
    run_tty_case "tty-bootstrap-fork-suppresses-suggestion" 1 "https://github.com/psmfd/pi-config.git"

  # 43. Accept then EOF (operator hits Ctrl-D, no login entered) -> empty
  #     login rejected, no file. The \x04 (EOT) byte signals EOF to `read`
  #     on the pty in canonical mode (immediate, vs. waiting out read -t).
  TTY_ACTIVE_LOGIN="TheSemicolon" TTY_FEED=$'y\n\x04' \
    TTY_EXPECT_FILE=0 TTY_EXPECT_SUBSTR="invalid GitHub login" \
    run_tty_case "tty-bootstrap-empty-login-eof" 1 "https://github.com/psmfd/pi-config.git"

  # 44. SKIP bypass short-circuits BEFORE any prompt even with a TTY attached:
  #     no file written, no "Create ...?" prompt, pass (exit 0).
  TTY_ACTIVE_LOGIN="TheSemicolon" TTY_FEED=$'y\nTheSemicolon\n' \
    TTY_EXTRA_ENV="SKIP_GH_IDENTITY_GUARD=1" \
    TTY_EXPECT_FILE=0 TTY_EXPECT_NOSUBSTR="Create" \
    run_tty_case "tty-skip-short-circuits-before-prompt" 0 "https://github.com/psmfd/pi-config.git"

  rm -f "$PTY_DRIVER"
else
  printf 'SKIP  [tty-bootstrap] python3 not available — interactive pty cases skipped\n'
fi

# --- summary ---------------------------------------------------------------
total=$((PASS_COUNT + FAIL_COUNT))
echo
if [ "$FAIL_COUNT" -eq 0 ]; then
  printf 'PASS — 0 errors, 0 warnings, %d checks ok\n' "$total"
  exit 0
fi
echo "Failed cases:"
for c in "${FAILED_CASES[@]}"; do
  printf '  - %s\n' "$c"
done
printf 'FAIL — %d errors, 0 warnings, %d checks ok\n' "$FAIL_COUNT" "$PASS_COUNT"
exit 1
