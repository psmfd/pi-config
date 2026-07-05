#!/usr/bin/env bash
#
# semver-classify.sh — sourceable Conventional-Commits bump classifier and raw
# SemVer arithmetic, shared by scripts/release.sh (source-repo tagging) and
# scripts/sync-mirror.sh (overlay-mirror version derivation). Supersedes the
# ADR-0058 "kept in lockstep by comment" duplication (see ADR-0068).
#
# Provides three PURE functions (no git/jq/network) so `--self-test` needs no
# preconditions:
#
#   classify_bump          stdin: commit message lines -> MAJOR|MINOR|PATCH|NONE
#   bump_version <v> <lvl> RAW arithmetic only. No pre-1.0 (major==0) demotion —
#                          that is the caller's responsibility (sync-mirror.sh's
#                          ext_next_version applies it; release.sh's source repo
#                          is already post-1.0 and must NOT demote).
#   ver_gt <a> <b>         numeric (not lexical) semver compare; returns 0 iff a>b.
#
# Input contract for classify_bump: each line is checked independently for a
# leading `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer token, a leading
# `type(scope)!:` marker, `feat(...):`, or `fix|perf(...):`. The footer token is
# anchored to the line start (a prose mention of the words is NOT a footer). A
# `BREAKING CHANGE:` footer lives in the commit BODY, not
# the subject — so callers MUST feed subject+body (`git log --format='%s%n%b'`)
# to detect it. Feeding subjects only (`%s`) silently misses footer-only breaks.
# Both call sites standardize on `%s%n%b` (ADR-0068 closed the prior divergence
# where release.sh fed `%s` and could not see a footer).
#
# This file sets NO shell options at top level (only inside --self-test): it is
# sourced after the caller has already activated `set -euo pipefail`, and its
# top level is function definitions only, which are -u-safe on their own.
#
# Usage:
#   . "$SCRIPT_DIR/lib/semver-classify.sh"
#   bump="$(git log --format='%s%n%b' "$range" | classify_bump)"
#   next="$(bump_version "$last_tag" "$bump")"
#
#   scripts/lib/semver-classify.sh --self-test   # network-free; validate.sh gate

# classify_bump: read commit message lines on stdin, print MAJOR|MINOR|PATCH|NONE.
classify_bump() {
  local bump=NONE line
  while IFS= read -r line; do
    # Conventional Commits breaking-change FOOTER: the token `BREAKING CHANGE:`
    # (or `BREAKING-CHANGE:`) must start a footer line. Anchor to line start —
    # a substring match anywhere (`*"BREAKING CHANGE"*`) also fires on prose that
    # merely mentions the words (e.g. a body line describing the footer, even in
    # backticks), which caused a false MAJOR bump.
    case "$line" in
      "BREAKING CHANGE:"* | "BREAKING-CHANGE:"*) printf 'MAJOR\n'; return 0 ;;
    esac
    if printf '%s' "$line" | grep -qE '^[a-z]+(\([^)]*\))?!:'; then printf 'MAJOR\n'; return 0; fi
    if printf '%s' "$line" | grep -qE '^feat(\([^)]*\))?:'; then bump=MINOR; fi
    if [ "$bump" != "MINOR" ] && printf '%s' "$line" | grep -qE '^(fix|perf)(\([^)]*\))?:'; then
      bump=PATCH
    fi
  done
  printf '%s\n' "$bump"
}

# bump_version <vX.Y.Z> <MAJOR|MINOR|PATCH>: print the incremented version.
bump_version() {
  local v="${1#v}" level="$2" major minor patch rest
  major="${v%%.*}"; rest="${v#*.}"; minor="${rest%%.*}"; patch="${rest#*.}"
  case "$level" in
    MAJOR) major=$((major + 1)); minor=0; patch=0 ;;
    MINOR) minor=$((minor + 1)); patch=0 ;;
    PATCH) patch=$((patch + 1)) ;;
  esac
  printf 'v%s.%s.%s\n' "$major" "$minor" "$patch"
}

# ver_gt <vA> <vB>: return 0 iff A > B (numeric per-field; no `sort -V`, which
# is absent/older on BSD and mis-sorts v0.9.0 vs v0.10.0 lexically).
ver_gt() {
  local a="${1#v}" b="${2#v}" rest am an ap bm bn bp
  am="${a%%.*}"; rest="${a#*.}"; an="${rest%%.*}"; ap="${rest#*.}"
  bm="${b%%.*}"; rest="${b#*.}"; bn="${rest%%.*}"; bp="${rest#*.}"
  [ "$am" -ne "$bm" ] && { [ "$am" -gt "$bm" ]; return; }
  [ "$an" -ne "$bn" ] && { [ "$an" -gt "$bn" ]; return; }
  [ "$ap" -gt "$bp" ]
}

_sc_self_test() {
  local fails=0 got
  _ok()  { printf 'OK    [%s] %s\n' semver-classify "$1"; }
  _bad() { printf 'ERROR [%s] %s\n' semver-classify "$1" >&2; fails=$((fails + 1)); }
  _eq()  { if [ "$2" = "$3" ]; then _ok "$1"; else _bad "$1: expected '$2' got '$3'"; fi; }

  got="$(printf 'feat(x): a\nfix(x): b\n' | classify_bump)";  _eq "feat+fix => MINOR" MINOR "$got"
  got="$(printf 'fix(x): b\nchore: c\n' | classify_bump)";    _eq "fix+chore => PATCH" PATCH "$got"
  got="$(printf 'chore: c\ndocs: d\n' | classify_bump)";      _eq "chore+docs => NONE" NONE "$got"
  got="$(printf 'feat!: breaking\n' | classify_bump)";        _eq "feat! => MAJOR" MAJOR "$got"
  got="$(printf 'perf(x): p\n' | classify_bump)";             _eq "perf => PATCH" PATCH "$got"
  # BREAKING CHANGE footer (body line) — the case release.sh's old `%s` feed missed.
  got="$(printf 'refactor(x): m\n\nBREAKING CHANGE: y\n' | classify_bump)"; _eq "footer => MAJOR" MAJOR "$got"
  got="$(printf 'refactor(x): m\n\nBREAKING-CHANGE: y\n' | classify_bump)"; _eq "hyphenated footer => MAJOR" MAJOR "$got"
  # Prose that merely mentions the words is NOT a footer — must not upgrade the bump.
  got="$(printf 'fix(x): a\ndoes not detect a BREAKING CHANGE: footer mid-line\n' | classify_bump)"; _eq "prose mention => PATCH (not MAJOR)" PATCH "$got"
  got="$(printf 'feat(x): a\nthis introduces no BREAKING CHANGE at all\n' | classify_bump)"; _eq "mid-line mention => MINOR (not MAJOR)" MINOR "$got"
  got="$(bump_version v0.1.0 MINOR)";  _eq "bump 0.1.0 MINOR => v0.2.0" v0.2.0 "$got"
  got="$(bump_version v0.1.3 PATCH)";  _eq "bump 0.1.3 PATCH => v0.1.4" v0.1.4 "$got"
  got="$(bump_version v1.2.3 MAJOR)";  _eq "bump 1.2.3 MAJOR => v2.0.0" v2.0.0 "$got"
  if ver_gt v0.10.0 v0.9.0; then _ok "0.10.0 > 0.9.0 (numeric, not lexical)"; else _bad "0.10.0 should be > 0.9.0"; fi
  if ver_gt v0.1.0 v0.1.0; then _bad "0.1.0 should NOT be > 0.1.0"; else _ok "0.1.0 not > 0.1.0"; fi

  echo "=================================="
  if [ "$fails" -eq 0 ]; then echo "PASS — 0 errors, 0 warnings"; return 0; fi
  echo "FAIL — ${fails} errors, 0 warnings"; return 1
}

# Executed directly (not sourced): only --self-test is supported.
if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  set -uo pipefail
  case "${1:-}" in
    --self-test) _sc_self_test; exit $? ;;
    *) printf 'ERROR [semver-classify] usage: %s --self-test\n' "$0" >&2; exit 2 ;;
  esac
fi
