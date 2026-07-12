#!/usr/bin/env bash
#
# bump-pi-runtime.sh — bump the vendored pi runtime pin (agent/vendor/pi/) to
# a newer PSMFD-attested release, non-interactively (#449, ADR-0092).
#
# Automates docs/vendor-updates.md § "Pi runtime": resolve the target tag,
# attestation-verify SHA256SUMS BEFORE trusting it as the digest source
# (ADR-0040), stage + promote VERSION/CHECKSUMS, rewrite the README pin
# header, run the vendor validation + fetch self-test + archive attestation
# re-verify, fix the runtime-coupled pins, and emit the subagent re-pair
# audit signal. Callable by a maintainer or by pi-runtime-bump.yml.
#
# Fail-closed by ORDERING, not rollback: every network/verify step writes
# only into a mktemp scratch dir; agent/vendor/pi/{VERSION,CHECKSUMS} are
# untouched until the attestation and checksum-shape gates have passed.
# There is deliberately no flag to bypass attestation failure (#449
# constraint 5). Plain upstream pins (vX.Y.Z, the emergency-rollback path)
# are out of scope — use the manual procedure in docs/vendor-updates.md.
#
# Usage:
#   scripts/bump-pi-runtime.sh (--tag vX.Y.Z-psmfd.N | --latest)
#                              [--check] [--dry-run] [--no-exec-self-test]
#                              [--repo owner/repo] [-h|--help]
#
# Flags:
#   --tag <tag>          Explicit PSMFD target tag (vX.Y.Z-psmfd.N only).
#   --latest             Resolve the target from the latest non-prerelease,
#                        non-draft release on --repo (withdrawn releases are
#                        demoted to prerelease by the release runbook and are
#                        deliberately excluded).
#   --check              Report-only: resolve + compare target vs current pin.
#                        No downloads, no writes. Exit 0 = current, 1 = behind.
#   --dry-run            Run the full verification pipeline (SHA256SUMS
#                        download + attestation verify + staged checksum-shape
#                        check + fetch/self-test of the TARGET tag + archive
#                        attestation re-verify) with zero repo writes.
#   --no-exec-self-test  Fetch, checksum, extract and attestation-re-verify
#                        the archive but do NOT execute the binary. For the
#                        write job of the two-job CI split (ADR-0092): the
#                        binary is executed only in the no-write-token job.
#   --repo <owner/repo>  Release source (default psmfd/pi). For test fixtures.
#
# Exit codes:
#   0 — pin already at target / --check current / bump applied clean /
#       --dry-run passed
#   1 — actionable failure (attestation, checksum shape, validation,
#       self-test, README anchor) or --check found the pin behind
#   2 — environment/precondition failure (missing tools, bad flags,
#       unresolvable tag, dirty target files, attempted downgrade)
#
# Requires: gh (authenticated), awk, mktemp, git.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR" || { printf 'ERROR [bump-pi] cannot cd to %s\n' "$REPO_DIR" >&2; exit 2; }

# Numeric semver compare (ver_gt), shared with release.sh/sync-mirror.sh.
# shellcheck source=scripts/lib/semver-classify.sh
. "$SCRIPT_DIR/lib/semver-classify.sh"

errors=0
warnings=0
ok()     { printf 'OK    [%s] %s\n' "$1" "$2"; }
info()   { printf 'INFO  %s\n' "$*"; }
warn()   { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; warnings=$((warnings + 1)); }
err()    { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }
fatal()  { err "$1" "$2"; summary; exit "${3:-1}"; }
summary() {
  printf '==================================\n'
  if [ "$errors" -eq 0 ]; then
    printf 'PASS — %d error(s), %d warning(s)\n' "$errors" "$warnings"
  else
    printf 'FAIL — %d error(s), %d warning(s)\n' "$errors" "$warnings"
  fi
}

usage() { sed -n '2,52p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

RELEASE_REPO="psmfd/pi"
UPSTREAM_REPO="earendil-works/pi"
VENDOR_DIR="$REPO_DIR/agent/vendor/pi"
VERSION_FILE="$VENDOR_DIR/VERSION"
CHECKSUMS_FILE="$VENDOR_DIR/CHECKSUMS"
README_FILE="$VENDOR_DIR/README.md"
SIGNER_WORKFLOW=".github/workflows/psmfd-release.yml"  # coupled to psmfd/pi; see docs/vendor-updates.md § Pi runtime
PSMFD_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+-psmfd\.[0-9]+$'

TARGET=""
USE_LATEST=0
CHECK_ONLY=0
DRY_RUN=0
EXEC_SELF_TEST=1

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)     [ $# -ge 2 ] || { err args "--tag requires a value"; exit 2; }; TARGET="$2"; shift 2 ;;
    --latest)  USE_LATEST=1; shift ;;
    --check)   CHECK_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-exec-self-test) EXEC_SELF_TEST=0; shift ;;
    --repo)    [ $# -ge 2 ] || { err args "--repo requires a value"; exit 2; }; RELEASE_REPO="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) err args "unknown flag: $1"; exit 2 ;;
  esac
done

# --- Preflight -------------------------------------------------------------
[ -n "$TARGET" ] && [ "$USE_LATEST" = 1 ] && { err args "--tag and --latest are mutually exclusive"; exit 2; }
[ -z "$TARGET" ] && [ "$USE_LATEST" = 0 ] && { err args "one of --tag or --latest is required"; exit 2; }
[ "$CHECK_ONLY" = 1 ] && [ "$DRY_RUN" = 1 ] && { err args "--check and --dry-run are mutually exclusive"; exit 2; }
for tool in gh awk mktemp git; do
  command -v "$tool" >/dev/null 2>&1 || { err preflight "required tool missing: $tool"; exit 2; }
done
gh auth status >/dev/null 2>&1 || { err preflight "gh is not authenticated"; exit 2; }
[ -s "$VERSION_FILE" ] || { err preflight "missing or empty $VERSION_FILE"; exit 2; }
CURRENT="$(tr -d '[:space:]' < "$VERSION_FILE")"

# --- Resolve target ---------------------------------------------------------
if [ "$USE_LATEST" = 1 ]; then
  # releases/latest excludes prereleases and drafts by GitHub semantics —
  # withdrawn releases are demoted to prerelease per the release runbook,
  # so this resolution deliberately never picks them up.
  TARGET="$(gh api "repos/${RELEASE_REPO}/releases/latest" --jq '.tag_name' 2>/dev/null || true)"
  [ -n "$TARGET" ] || { err resolve "could not resolve latest release on ${RELEASE_REPO} (API error or no releases)"; exit 2; }
fi
# The tag is untrusted input until this gate: regex-validate before it touches
# any shell interpolation, file path, or URL (ADR-0092 injection posture).
if ! printf '%s' "$TARGET" | grep -Eq "$PSMFD_TAG_RE"; then
  err resolve "target tag '$TARGET' is not a PSMFD tag (vX.Y.Z-psmfd.N); plain upstream pins are the manual emergency-rollback path (docs/vendor-updates.md)"
  exit 2
fi
info "current pin: ${CURRENT}   target: ${TARGET}"

# --- Idempotency / downgrade guard -------------------------------------------
if [ "$TARGET" = "$CURRENT" ]; then
  ok pin "already at ${TARGET} — nothing to do"
  summary; exit 0
fi
cur_base="${CURRENT#v}"; cur_base="${cur_base%%-psmfd*}"
tgt_base="${TARGET#v}"; tgt_base="${tgt_base%%-psmfd*}"
cur_n="${CURRENT##*-psmfd.}"
tgt_n="${TARGET##*-psmfd.}"
is_downgrade=0
if [ "$cur_base" = "$tgt_base" ]; then
  [ "$tgt_n" -lt "$cur_n" ] && is_downgrade=1
elif ver_gt "$cur_base" "$tgt_base"; then
  is_downgrade=1
fi
if [ "$is_downgrade" = 1 ]; then
  err downgrade "target ${TARGET} is older than pinned ${CURRENT} — refusing; use the manual emergency-rollback procedure (docs/vendor-updates.md § Pi runtime)"
  summary; exit 2
fi

if [ "$CHECK_ONLY" = 1 ]; then
  warn check "pin ${CURRENT} is behind ${RELEASE_REPO} ${TARGET}"
  summary; exit 1
fi

# --- Dirty-tree guard (scoped to the files this script writes) --------------
BUMP_FILES=(agent/vendor/pi/VERSION agent/vendor/pi/CHECKSUMS agent/vendor/pi/README.md
  scripts/lib/extension-deps.sh agent/settings.example.json
  agent/extensions/subagent/PATCH_MANIFEST.json)
if [ "$DRY_RUN" = 0 ] && ! git diff --quiet -- "${BUMP_FILES[@]}"; then
  err preflight "target files already dirty — commit or stash before bumping: $(git diff --name-only -- "${BUMP_FILES[@]}" | tr '\n' ' ')"
  exit 2
fi

# --- Stage + verify (nothing below touches the repo until promotion) --------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "downloading SHA256SUMS for ${TARGET} from ${RELEASE_REPO}…"
if ! gh release download "$TARGET" --repo "$RELEASE_REPO" -p SHA256SUMS --dir "$tmp" 2>&1; then
  fatal download "could not download SHA256SUMS for ${TARGET} from ${RELEASE_REPO}"
fi

info "attestation-verifying SHA256SUMS (signer: ${RELEASE_REPO}/${SIGNER_WORKFLOW})…"
if ! gh attestation verify "$tmp/SHA256SUMS" --repo "$RELEASE_REPO" \
    --signer-workflow "${RELEASE_REPO}/${SIGNER_WORKFLOW}" >/dev/null 2>&1; then
  fatal attest "SHA256SUMS attestation verification FAILED for ${TARGET} — nothing written; do not proceed manually without investigating (ADR-0040)"
fi
ok attest "SHA256SUMS attestation verified"

grep -Ev 'pi-sbom' "$tmp/SHA256SUMS" > "$tmp/CHECKSUMS.new"
if ! awk 'length($1) != 64 { exit 1 } END { if (NR == 0) exit 1 }' "$tmp/CHECKSUMS.new"; then
  fatal checksums "staged CHECKSUMS failed the 64-hex-digest shape check — nothing written"
fi
ok checksums "staged CHECKSUMS shape valid ($(wc -l < "$tmp/CHECKSUMS.new" | tr -d ' ') assets)"

# Fetch + verify the target archive against the STAGED pin (no repo writes):
# a scratch vendor dir carries the staged VERSION/CHECKSUMS so fetch_pi_binary
# validates the new tag end-to-end before promotion.
#
# Cache placement differs by mode (review finding): --dry-run uses a scratch
# cache (zero footprint). The WRITE path uses the REAL cache root — the later
# PATCH_MANIFEST regeneration (validate-subagent-drift.sh) resolves the new
# tag's upstream snapshot at $CACHE_ROOT/pi-<tag>/, which a scratch cache
# never populates, so a fresh CI runner would otherwise always fall to the
# manual-intervention WARN path. On an ephemeral runner the real cache is
# empty (full verification always runs); a warm local cache skips
# re-verification on hit — the same documented #109 gap as the manual
# runbook. Cross-RUN caching (actions/cache) remains prohibited (ADR-0092).
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/pi_config"
stage_vendor="$tmp/vendor"
mkdir -p "$stage_vendor"
cp "$tmp/CHECKSUMS.new" "$stage_vendor/CHECKSUMS"
printf '%s\n' "$TARGET" > "$stage_vendor/VERSION"
if [ "$DRY_RUN" = 1 ]; then
  fetch_cache="$tmp/cache"
else
  fetch_cache="$CACHE_ROOT"
fi
# shellcheck source=scripts/lib/fetch-pi-binary.sh
. "$SCRIPT_DIR/lib/fetch-pi-binary.sh"
if [ "$EXEC_SELF_TEST" = 1 ]; then
  info "fetch + self-test (executes the binary) against the staged pin…"
  if ! _fpb_self_test --vendor-dir "$stage_vendor" --cache-dir "$fetch_cache" >/dev/null; then
    fatal self-test "fetch/self-test failed for ${TARGET} — nothing written"
  fi
  ok self-test "binary fetched, checksummed, and executed clean"
else
  info "fetch (no binary execution) against the staged pin…"
  if ! fetch_pi_binary --vendor-dir "$stage_vendor" --cache-dir "$fetch_cache" >/dev/null; then
    fatal fetch "fetch/checksum/extract failed for ${TARGET} — nothing written"
  fi
  ok fetch "archive fetched, checksummed, and extracted (execution skipped per --no-exec-self-test)"
fi

# Re-verify the fetched archive's own attestation (ADR-0040: verified again
# at bump time after the self-test).
archive="$(find "$fetch_cache/downloads" -name "pi-*-${TARGET}.*" -type f 2>/dev/null | head -n1)"
if [ -z "$archive" ]; then
  fatal attest-archive "fetched archive not found under the scratch cache — cannot re-verify"
fi
if ! gh attestation verify "$archive" --repo "$RELEASE_REPO" \
    --signer-workflow "${RELEASE_REPO}/${SIGNER_WORKFLOW}" >/dev/null 2>&1; then
  fatal attest-archive "fetched archive attestation verification FAILED — nothing written"
fi
ok attest-archive "fetched archive attestation verified ($(basename "$archive"))"

if [ "$DRY_RUN" = 1 ]; then
  ok dry-run "all verification gates passed for ${TARGET}; no files written"
  summary; exit 0
fi

# --- Promote ------------------------------------------------------------------
# Promotion temp files live INSIDE the vendor dir so the mv is guaranteed
# same-filesystem and therefore atomic (a /tmp-rooted mktemp could sit on a
# different mount, degrading mv to copy+unlink — review finding). Fresh plain
# data files: no exec-bit-preservation concern (contrast check-ext-ref-drift's
# in-place idiom for executable scripts).
cp "$tmp/CHECKSUMS.new" "$VENDOR_DIR/.CHECKSUMS.tmp.$$"
mv -f "$VENDOR_DIR/.CHECKSUMS.tmp.$$" "$CHECKSUMS_FILE"
printf '%s\n' "$TARGET" > "$VENDOR_DIR/.VERSION.tmp.$$"
mv -f "$VENDOR_DIR/.VERSION.tmp.$$" "$VERSION_FILE"
ok promote "VERSION + CHECKSUMS promoted to ${TARGET}"

# README pin header rewrite — anchored on the exact two phrases the header
# carries; fail closed if either anchor is missing (prose drifted).
if ! grep -qF '**Pinned to pi `' "$README_FILE" || ! grep -qF 'upstream base `' "$README_FILE"; then
  fatal readme "README pin-header anchors not found — rewrite the header manually and update this script's anchors"
fi
sed -E \
  -e "s|\*\*Pinned to pi \`v[0-9]+\.[0-9]+\.[0-9]+-psmfd\.[0-9]+\`\*\*|**Pinned to pi \`${TARGET}\`**|" \
  -e "s|upstream base \`[0-9]+\.[0-9]+\.[0-9]+\`|upstream base \`${tgt_base}\`|" \
  "$README_FILE" > "$tmp/README.new"
if ! grep -qF "$TARGET" "$tmp/README.new"; then
  fatal readme "README rewrite did not take effect — nothing further; fix manually"
fi
cat "$tmp/README.new" > "$README_FILE"
ok readme "README pin header rewritten to ${TARGET}"

# --- Post-promotion validation -------------------------------------------------
if ! "$SCRIPT_DIR/validate-pi-vendor.sh"; then
  fatal validate "validate-pi-vendor.sh failed after promotion — inspect before committing"
fi
ok validate "validate-pi-vendor.sh clean"

# --- Runtime-coupled pins (advisory: pin-drift-check re-fixes independently) ---
for target_name in extension-deps settings-example; do
  if ! "$SCRIPT_DIR/check-ext-ref-drift.sh" --fix --target "$target_name" >/dev/null 2>&1; then
    warn coupled-pins "check-ext-ref-drift.sh --fix --target ${target_name} failed — pin-drift-check.yml will retry on its own trigger"
  fi
done
ok coupled-pins "runtime-coupled pins aligned to ${tgt_base}"

# --- Subagent re-pair audit signal (WARN-only; never auto-resolved) ------------
SUBAGENT_AUDIT="unknown"
old_paired="$(grep -oE 'Vendored from pi [0-9]+\.[0-9]+\.[0-9]+' agent/extensions/subagent/README.md | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
if [ -z "$old_paired" ]; then
  warn subagent-audit "could not read the paired pi version from the subagent README — audit manually (docs/vendor-updates.md § Subagent extension)"
elif [ "$old_paired" = "$tgt_base" ]; then
  SUBAGENT_AUDIT="unchanged"
  ok subagent-audit "subagent snapshot already paired to ${tgt_base}"
else
  changed="$(gh api "repos/${UPSTREAM_REPO}/compare/v${old_paired}...v${tgt_base}" \
    --jq '[.files[]?.filename | select(startswith("examples/extensions/subagent/") or startswith("packages/coding-agent/examples/extensions/subagent/"))] | length' 2>/dev/null || true)"
  if [ -z "$changed" ]; then
    warn subagent-audit "could not resolve upstream compare v${old_paired}...v${tgt_base} — audit manually (docs/vendor-updates.md § Subagent extension)"
  elif [ "$changed" -gt 0 ]; then
    SUBAGENT_AUDIT="changed"
    warn subagent-audit "upstream subagent example changed (${changed} file(s)) between v${old_paired} and v${tgt_base} — Procedure B re-pair audit REQUIRED before merge (docs/vendor-updates.md § Subagent extension)"
  else
    SUBAGENT_AUDIT="unchanged"
    ok subagent-audit "upstream subagent example unchanged v${old_paired}..v${tgt_base} — pairing at ${old_paired} remains current"
  fi
fi

# PATCH_MANIFEST pinnedPiVersion refresh: safe ONLY when the audit proved the
# upstream source unchanged and no vendored subagent source is dirty — the
# documented anti-pattern is regenerating after source edits without a
# patch-table review (docs/vendor-updates.md § Anti-pattern; ADR-0092 hybrid).
if [ "$SUBAGENT_AUDIT" = "unchanged" ]; then
  if git diff --quiet -- agent/extensions/subagent/ && "$SCRIPT_DIR/validate-subagent-drift.sh" --regenerate >/dev/null 2>&1; then
    ok subagent-manifest "PATCH_MANIFEST pinnedPiVersion refreshed to ${TARGET} (source unchanged; pure pin refresh)"
  else
    warn subagent-manifest "PATCH_MANIFEST regeneration skipped/failed — validate.sh will flag it; resolve manually"
  fi
else
  warn subagent-manifest "PATCH_MANIFEST NOT regenerated (audit: ${SUBAGENT_AUDIT}) — validate.sh will fail until the subagent audit is resolved by a human"
fi

summary
[ "$errors" -eq 0 ] || exit 1
exit 0
