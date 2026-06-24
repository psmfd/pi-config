#!/usr/bin/env bash
#
# validate.sh — pi_config repo validator
#
# Verifies that every authored surface (skills, agents, prompts, rules,
# extensions, ADRs, AGENTS.md, README) is well-formed and internally
# consistent. Required test/lint/typecheck surfaces must actually run;
# missing Node/npx or missing required check scripts are validation errors.
# Exits non-zero on any error.
#
# Run:
#   ./scripts/validate.sh           normal output
#   VERBOSE=1 ./scripts/validate.sh detailed per-file output
#
# Designed for CI and pre-PR gates. See agent/rules/post-implementation-review.md.
#
# Exit codes:
#   0 — all checks passed (warnings allowed)
#   1 — one or more validation errors
#   2 — environment failure (missing dependency, not in repo)

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || { echo "validate.sh: cannot cd to $REPO_DIR" >&2; exit 1; }

VERBOSE="${VERBOSE:-0}"

# --- Output helpers --------------------------------------------------------
RED=""; GRN=""; YLW=""; BLU=""; RST=""
if [ -t 1 ]; then
  RED="$(printf '\033[31m')"; GRN="$(printf '\033[32m')"
  YLW="$(printf '\033[33m')"; BLU="$(printf '\033[34m')"
  RST="$(printf '\033[0m')"
fi

errors=0
warnings=0
checks=0

err()  { echo "${RED}ERROR${RST} $*" >&2; errors=$((errors + 1)); }
warn() { echo "${YLW}WARN${RST}  $*"; warnings=$((warnings + 1)); }
ok()   { if [ "$VERBOSE" = "1" ]; then echo "${GRN}ok${RST}    $*"; fi; checks=$((checks + 1)); }
info() { echo "${BLU}==>${RST} $*"; }

resolve_path_from() {
  local base_dir="$1" target="$2"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$base_dir" "$target" <<'PY'
import os
import sys
base_dir = os.path.expanduser(sys.argv[1])
target = sys.argv[2]
print(os.path.realpath(os.path.join(base_dir, target)))
PY
    return
  fi

  if command -v realpath >/dev/null 2>&1; then
    (cd "$base_dir" 2>/dev/null && realpath "$target")
    return
  fi

  if command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
    (cd "$base_dir" 2>/dev/null && readlink -f "$target")
    return
  fi

  return 1
}

# --- Frontmatter helpers ---------------------------------------------------

# Extract YAML frontmatter block (between the first pair of `---` lines).
extract_frontmatter() {
  awk '/^---$/{c++; next} c==1{print} c==2{exit}' "$1"
}

# Read a top-level scalar key from a frontmatter block. Handles bare,
# single-quoted, and double-quoted values. Does NOT handle multi-line scalars,
# nested structures, or arrays — sufficient for our flat frontmatter.
fm_value() {
  local fm="$1" key="$2"
  printf '%s\n' "$fm" \
    | sed -nE "s/^${key}:[[:space:]]*//p" \
    | head -n1 \
    | sed -E "s/^'(.*)'[[:space:]]*$/\1/; s/^\"(.*)\"[[:space:]]*$/\1/; s/[[:space:]]+$//"
}

fm_has_key() {
  printf '%s\n' "$1" | grep -qE "^$2:"
}

# --- 1. Skills -------------------------------------------------------------
info "Validating agent/skills/*/SKILL.md"
for d in agent/skills/*/; do
  [ -d "$d" ] || continue
  skill_name="$(basename "$d")"
  skill_file="${d}SKILL.md"
  if [ ! -f "$skill_file" ]; then
    err "skills: $skill_name has no SKILL.md"
    continue
  fi
  fm="$(extract_frontmatter "$skill_file")"
  if [ -z "$fm" ]; then
    err "skills: $skill_file has no YAML frontmatter"
    continue
  fi
  name="$(fm_value "$fm" name)"
  desc="$(fm_value "$fm" description)"
  if [ -z "$name" ]; then
    err "skills: $skill_file frontmatter missing 'name'"
  elif [ "$name" != "$skill_name" ]; then
    err "skills: $skill_file frontmatter name='$name' does not match directory '$skill_name'"
  fi
  if [ -z "$desc" ]; then
    err "skills: $skill_file frontmatter missing 'description'"
  else
    # Byte-length check per agent/rules/skill-description-style.md
    # (100–180 byte target, 200 byte hard ceiling, em-dash = 3 bytes).
    # `wc -c` is POSIX-defined as bytes regardless of locale.
    desc_bytes=$(printf '%s' "$desc" | wc -c | tr -d ' ')
    desc_bytes=${desc_bytes:-0}
    if [ "$desc_bytes" -lt 100 ]; then
      err "skills: $skill_name description is $desc_bytes bytes (rule: 100–180 byte target; under floor)"
    elif [ "$desc_bytes" -gt 200 ]; then
      err "skills: $skill_name description is $desc_bytes bytes (rule: 200 byte hard ceiling)"
    elif [ "$desc_bytes" -gt 180 ]; then
      warn "skills: $skill_name description is $desc_bytes bytes (over 180-byte soft cap, under 200 ceiling)"
    fi
    # Topic-inventory item-count check (3–8 comma-separated items between
    # the em-dash separator and the trailing period). Uses bash parameter
    # expansion for first-match em-dash semantics without subshell cost.
    # NOTE: items containing a literal ', ' (e.g. parentheticals like
    # '(macOS, Linux)') will be over-counted; the rule shape discourages this.
    case "$desc" in
      *'— '*)
        inv=${desc#*— }
        inv=${inv%.}
        item_count=$(printf '%s' "$inv" | awk -F', ' '{print NF}')
        item_count=${item_count:-0}
        if [ "$item_count" -lt 3 ]; then
          err "skills: $skill_name description has $item_count topic-inventory item(s) (rule: 3–8)"
        elif [ "$item_count" -gt 8 ]; then
          err "skills: $skill_name description has $item_count topic-inventory items (rule: 3–8)"
        fi
        ;;
      *)
        warn "skills: $skill_name description missing em-dash separator (rule shape: '<Domain> reference for the <name> subagent — <items>.')"
        ;;
    esac
  fi
  ok "skills: $skill_name"
done

# --- 2. Agent wrappers -----------------------------------------------------
info "Validating agent/agents/*.md"
agent_count=0
for f in agent/agents/*.md; do
  [ -f "$f" ] || continue
  agent_count=$((agent_count + 1))
  agent_name="$(basename "$f" .md)"
  fm="$(extract_frontmatter "$f")"
  if [ -z "$fm" ]; then
    err "agents: $f has no YAML frontmatter"
    continue
  fi
  name="$(fm_value "$fm" name)"
  desc="$(fm_value "$fm" description)"
  if [ -z "$name" ]; then
    err "agents: $f frontmatter missing 'name'"
  elif [ "$name" != "$agent_name" ]; then
    err "agents: $f frontmatter name='$name' does not match filename '$agent_name'"
  fi
  if [ -z "$desc" ]; then
    err "agents: $f frontmatter missing 'description'"
  fi
  if ! fm_has_key "$fm" tools; then
    err "agents: $f frontmatter missing 'tools' (required by subagent extension)"
  fi
  mode="$(fm_value "$fm" mode)"
  if [ -z "$mode" ]; then
    err "agents: $f frontmatter missing 'mode' (required by catalog generator; use 'read-only' or 'interactive')"
  elif [ "$mode" != "read-only" ] && [ "$mode" != "interactive" ]; then
    err "agents: $f frontmatter mode='$mode' is not one of: read-only, interactive"
  fi
  ok "agents: $agent_name"
done

# --- 3. Prompts ------------------------------------------------------------
info "Validating agent/prompts/*.md"
for f in agent/prompts/*.md; do
  [ -f "$f" ] || continue
  pname="$(basename "$f" .md)"
  if ! [[ "$pname" =~ ^[a-z][a-z0-9-]*$ ]]; then
    err "prompts: $f filename '$pname' is not a valid kebab-case slash-command name"
    continue
  fi
  if [ ! -s "$f" ]; then
    err "prompts: $f is empty"
    continue
  fi
  ok "prompts: /$pname"
done

# --- 4. Rules --------------------------------------------------------------
info "Validating agent/rules/*.md"
for f in agent/rules/*.md; do
  [ -f "$f" ] || continue
  rname="$(basename "$f" .md)"
  fm="$(extract_frontmatter "$f")"
  if [ -z "$fm" ]; then
    err "rules: $f has no YAML frontmatter"
    continue
  fi
  desc="$(fm_value "$fm" description)"
  if [ -z "$desc" ]; then
    err "rules: $f frontmatter missing 'description'"
  fi
  ok "rules: $rname"
done

# --- 5. AGENTS.md catalog sync --------------------------------------------
info "Validating agent/AGENTS.md catalog"
AGENTS_MD="agent/AGENTS.md"
if [ ! -f "$AGENTS_MD" ]; then
  err "AGENTS.md: $AGENTS_MD missing"
else
  if ! grep -qF "<!-- BEGIN agent-catalog" "$AGENTS_MD"; then
    err "AGENTS.md: missing BEGIN agent-catalog marker"
  fi
  if ! grep -qF "<!-- END agent-catalog" "$AGENTS_MD"; then
    err "AGENTS.md: missing END agent-catalog marker"
  fi
  # shellcheck disable=SC2016  # sed \1 backref is not a shell expansion
  catalog_names="$(awk '
    /<!-- BEGIN agent-catalog/{inblock=1; next}
    /<!-- END agent-catalog/{inblock=0; next}
    inblock && /^\| `[a-z][a-z0-9-]*` \| (read-only|interactive) \|/{print}
  ' "$AGENTS_MD" | sed -E 's/^\| `([a-z][a-z0-9-]*)` \|.*/\1/' | sort)"
  agent_files="$(for f in agent/agents/*.md; do [ -f "$f" ] && basename "$f" .md; done | sort)"
  catalog_rows="$(printf '%s\n' "$catalog_names" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$catalog_rows" != "$agent_count" ]; then
    err "AGENTS.md: catalog has $catalog_rows row(s) but agent/agents/ has $agent_count file(s) — run scripts/regen-agent-catalog.sh"
  fi
  # Name-parity check: every catalog row must have a wrapper file and vice versa.
  # Catches the "invoked an agent that doesn't exist" failure mode at PR time
  # rather than at runtime (where the parallel-mode aggregation in the subagent
  # extension surfaces the failure as ambiguous `(no output)` — see pi_config
  # issue #44 and rules/agent-first-selection.md "Skills Are Not Agents").
  missing_wrappers="$(comm -23 <(printf '%s\n' "$catalog_names" | sed '/^$/d') <(printf '%s\n' "$agent_files"))"
  missing_catalog="$(comm -13 <(printf '%s\n' "$catalog_names" | sed '/^$/d') <(printf '%s\n' "$agent_files"))"
  if [ -n "$missing_wrappers" ]; then
    while IFS= read -r n; do
      [ -n "$n" ] && err "AGENTS.md: catalog lists '$n' but agent/agents/$n.md does not exist"
    done <<< "$missing_wrappers"
  fi
  if [ -n "$missing_catalog" ]; then
    while IFS= read -r n; do
      [ -n "$n" ] && err "AGENTS.md: agent/agents/$n.md exists but is not in the catalog table — run scripts/regen-agent-catalog.sh"
    done <<< "$missing_catalog"
  fi
  if [ -z "$missing_wrappers" ] && [ -z "$missing_catalog" ] && [ "$catalog_rows" = "$agent_count" ]; then
    # Content-drift check (#31): catches edits to wrapper frontmatter that
    # weren't followed by `scripts/regen-agent-catalog.sh`. Row-count and
    # name-parity alone cannot detect description/mode drift.
    if drift_out="$(./scripts/regen-agent-catalog.sh --check 2>&1 >/dev/null)"; then
      # Surface any non-fatal `warn:` lines the generator emitted (e.g. a
      # description containing `|`, which validate.sh's frontmatter loops do
      # not independently catch). Empty on a clean run.
      if [ -n "$drift_out" ]; then
        printf '%s\n' "$drift_out" >&2
        warn "AGENTS.md: catalog regenerated with non-fatal warnings (see above)"
      fi
      ok "AGENTS.md: catalog in sync ($agent_count agents, names + content match)"
    else
      printf '%s\n' "$drift_out" >&2
      err "AGENTS.md: catalog content drift detected — run scripts/regen-agent-catalog.sh"
    fi
  fi
fi

# --- 6. Vendored extensions ------------------------------------------------
info "Validating agent/extensions/*"
for d in agent/extensions/*/; do
  [ -d "$d" ] || continue
  ext_name="$(basename "$d")"
  # A directory without index.ts is a non-loadable library module (e.g. shared/),
  # not a pi extension — pi auto-loads only `*/index.ts` (ADR-0030). Validate it
  # as a library: require README.md + tsconfig.json, skip the loadable checks.
  if [ ! -f "${d}index.ts" ]; then
    if [ ! -f "${d}README.md" ]; then
      err "extensions: library $ext_name missing README.md"
      continue
    fi
    if [ ! -f "${d}tsconfig.json" ]; then
      err "extensions: library $ext_name missing tsconfig.json"
      continue
    fi
    ok "extensions: $ext_name (library)"
    continue
  fi
  if [ ! -f "${d}README.md" ]; then
    err "extensions: $ext_name missing README.md"
    continue
  fi
  # Vendored extensions (subagent) must declare source pi version.
  if [ "$ext_name" = "subagent" ]; then
    if ! grep -qE "[Pp]i [0-9]+\.[0-9]+\.[0-9]+" "${d}README.md"; then
      err "extensions: $ext_name (vendored) README must cite source pi version"
    fi
  fi
  ok "extensions: $ext_name"
done

# --- 6b. Secrets-guard SKIP_PATH_GLOBS smoke test --------------------------
# Per ADR-0006 § Consequences, `drafts/**` and `.review/**` must remain in
# scope for secrets-guard content scans. They are gitignored / never-merged
# respectively, which means a casual reader of secrets-guard/index.ts might
# think "these are not real content, skip them" — but the whole point of
# scanning drafts/ is to prevent secrets leaking through the working-artifact
# area into a later merge, and the whole point of scanning .review/ is to
# prevent secrets in Tier 3 payloads even on the never-merged feature branch.
# This smoke test asserts neither glob appears in SKIP_PATH_GLOBS.
info "Secrets-guard SKIP_PATH_GLOBS smoke test"
sg_index="agent/extensions/secrets-guard/index.ts"
if [ ! -f "$sg_index" ]; then
  err "secrets-guard: $sg_index missing (cannot run smoke test)"
else
  sg_block="$(awk '/^const SKIP_PATH_GLOBS = \[/,/^\];/' "$sg_index")"
  if [ -z "$sg_block" ]; then
    err "secrets-guard: could not extract SKIP_PATH_GLOBS block from $sg_index"
  else
    sg_bad=0
    # Grep is shape-based, intentionally loose: it flags any occurrence of
    # `drafts` or `.review` as a path-component-start inside the array body,
    # case-insensitive, regardless of how the entry is spelled (regex literal,
    # quoted string, with or without trailing terminators). False-positive
    # cost is acceptable — the only realistic trigger is an actual SKIP_PATH_GLOBS
    # entry for these directories, which is what we want to fail.
    if printf '%s\n' "$sg_block" | grep -qiE '(^|[^A-Za-z0-9_])drafts'; then
      err "secrets-guard: SKIP_PATH_GLOBS appears to include drafts/** (ADR-0006 § Consequences)"
      sg_bad=1
    fi
    if printf '%s\n' "$sg_block" | grep -qiE '(^|[^A-Za-z0-9_])\.review'; then
      err "secrets-guard: SKIP_PATH_GLOBS appears to include .review/** (ADR-0006 § Consequences, ADR-0007)"
      sg_bad=1
    fi
    if [ "$sg_bad" -eq 0 ]; then
      ok "secrets-guard: SKIP_PATH_GLOBS does not skip drafts/** or .review/**"
    fi
  fi
fi

# --- 6c. Pi vendor (agent/vendor/pi/) --------------------------------------
# Per ADR-0009 (Pi runtime acquisition strategy). Network-free structural
# check that VERSION + CHECKSUMS + README are consistent and that the
# expected six-platform asset set is fully represented.
info "Validating agent/vendor/pi/ (ADR-0009)"
if [ -x scripts/validate-pi-vendor.sh ]; then
  if scripts/validate-pi-vendor.sh; then
    ok "pi vendor: structurally consistent"
  else
    err "pi vendor: structural validation failed (see ERROR lines above)"
  fi
else
  err "pi vendor: scripts/validate-pi-vendor.sh is missing or not executable"
fi

# --- 6d. Nvm vendor (agent/vendor/nvm/) ------------------------------------
# Per ADR-0010 (setup.sh install-trust posture). Mirrors 6c; same pattern,
# different asset inventory (single install.sh).
info "Validating agent/vendor/nvm/ (ADR-0010)"
if [ -x scripts/validate-nvm-vendor.sh ]; then
  if scripts/validate-nvm-vendor.sh; then
    ok "nvm vendor: structurally consistent"
  else
    err "nvm vendor: structural validation failed (see ERROR lines above)"
  fi
else
  err "nvm vendor: scripts/validate-nvm-vendor.sh is missing or not executable"
fi

# --- 6e. Toolchain vendor pins (agent/vendor/{gh,yq,shellcheck}/) ---
# Per ADR-0011. Each validator mirrors 6c/6d: VERSION + CHECKSUMS + README
# structural shape, no network. yq additionally requires the README to call
# out the mikefarah-vs-kislyuk disambiguation.
for pin in gh yq shellcheck; do
  info "Validating agent/vendor/${pin}/ (ADR-0011)"
  validator="scripts/validate-${pin}-vendor.sh"
  if [ -x "$validator" ]; then
    if "$validator"; then
      ok "${pin} vendor: structurally consistent"
    else
      err "${pin} vendor: structural validation failed (see ERROR lines above)"
    fi
  else
    err "${pin} vendor: ${validator} is missing or not executable"
  fi
done

# --- 6e-bis. Gitleaks vendor pin (agent/vendor/gitleaks/) -----------------
# Per ADR-0037 (secret-scanner tooling strategy). Validated separately from
# the ADR-0011 loop because it is a security scanner with its own governing
# ADR, while still using the same sha256-pinned GitHub release-asset pattern.
info "Validating agent/vendor/gitleaks/ (ADR-0037)"
if [ -x scripts/validate-gitleaks-vendor.sh ]; then
  if scripts/validate-gitleaks-vendor.sh; then
    ok "gitleaks vendor: structurally consistent"
  else
    err "gitleaks vendor: structural validation failed (see ERROR lines above)"
  fi
else
  err "gitleaks vendor: scripts/validate-gitleaks-vendor.sh is missing or not executable"
fi

# --- 6e-quater. scan-secrets self-test (ADR-0048) --------------------------
# The repo-agnostic secret scanner ships hermetic assertions (range / null-SHA
# parsing) that need neither gitleaks nor a repo. Gate them so a regression in
# the parsing logic is caught here rather than at scan time.
info "Running scripts/scan-secrets.sh --self-test (ADR-0048)"
if [ -x scripts/scan-secrets.sh ]; then
  if scripts/scan-secrets.sh --self-test >/dev/null; then
    ok "scan-secrets: self-test passed"
  else
    err "scan-secrets: self-test failed (run: scripts/scan-secrets.sh --self-test)"
  fi
else
  err "scan-secrets: scripts/scan-secrets.sh is missing or not executable"
fi

# --- 6e-ter. cocoindex-code vendor pin (agent/vendor/cocoindex-code/) -------
# Per ADR-0033 (pin-not-copy record: PyPI engine version + embedding-model
# checksums). Validated separately from the 6e loop because its acquisition
# model (PyPI tool + HuggingFace model) differs from the ADR-0011 binary pins.
info "Validating agent/vendor/cocoindex-code/ (ADR-0033)"
if [ -x scripts/validate-cocoindex-code-vendor.sh ]; then
  if scripts/validate-cocoindex-code-vendor.sh; then
    ok "cocoindex-code vendor: structurally consistent"
  else
    err "cocoindex-code vendor: structural validation failed (see ERROR lines above)"
  fi
else
  err "cocoindex-code vendor: scripts/validate-cocoindex-code-vendor.sh is missing or not executable"
fi

# --- 6f. install-helpers libraries -----------------------------------------
# Smoke-tests scripts/lib/platform-detect.sh and scripts/lib/install-helpers.sh
# in their self-test modes. These are network-free (install-helpers self-test
# runs in dry-run mode) and exercise the same code paths setup.sh consumes.
info "Validating scripts/lib/{platform-detect,install-helpers}.sh"
for lib in scripts/lib/platform-detect.sh scripts/lib/install-helpers.sh; do
  if [ ! -x "$lib" ]; then
    err "install-helpers: $lib is missing or not executable"
    continue
  fi
  if "$lib" --self-test >/dev/null 2>&1; then
    ok "install-helpers: $(basename "$lib") self-test"
  else
    err "install-helpers: $(basename "$lib") --self-test failed"
  fi
done

# --- 7. ADRs ---------------------------------------------------------------
info "Validating adrs/*.md"
# bash 3.2 (the macOS system bash, used by the setup-smoke workflow) lacks
# `declare -A`. Use a space-delimited string accumulator of `num=path` pairs
# and a case-glob scan for portability. ADR filenames cannot contain spaces
# (NNNN-kebab-name.md convention), so the splitter is safe.
adr_seen_list=""
shopt -s nullglob
for f in adrs/[0-9]*.md; do
  base="$(basename "$f")"
  num="$(printf '%s' "$base" | sed -nE 's/^([0-9]+)-.*$/\1/p')"
  if [ -z "$num" ]; then
    err "adrs: $f filename does not match NNNN-name.md"
    continue
  fi
  prior=""
  for entry in $adr_seen_list; do
    case "$entry" in
      "${num}="*) prior="${entry#*=}"; break ;;
    esac
  done
  if [ -n "$prior" ]; then
    err "adrs: ADR number $num used by both $f and $prior"
    continue
  fi
  adr_seen_list="$adr_seen_list ${num}=${f}"
  ok "adrs: ADR-$num"
done
shopt -u nullglob

# --- 8. Intra-repo markdown link check (cheap) ----------------------------
info "Checking intra-repo markdown links"
# The inner loop reads awk's output via process substitution rather than a
# pipe so it runs in the parent shell — `err()` calls below mutate the
# parent's `errors` counter, which the PASS/FAIL summary relies on.
# (Previous shape: `awk '...' | while ...; done` ran the inner loop in a
# subshell, dropping every `err()` increment. See #90.)
while IFS= read -r mdfile; do
  # Extract relative-link targets from `[text](path)` where path doesn't
  # start with http(s):, mailto:, #, or contain a query/fragment we can't
  # resolve. Also skip absolute paths (those are not intra-repo).
  while IFS= read -r link; do
    # Strip fragment / query
    target="${link%%#*}"
    target="${target%%\?*}"
    [ -z "$target" ] && continue
    # Resolve relative to the file's directory
    dir="$(dirname "$mdfile")"
    full="$(resolve_path_from "$dir" "$target" 2>/dev/null || true)"
    if [ -z "$full" ] || [ ! -e "$full" ]; then
      err "links: $mdfile -> '$link' (target not found)"
    fi
  done < <(awk '
    {
      while (match($0, /\[[^]]*\]\([^)]+\)/)) {
        whole = substr($0, RSTART, RLENGTH)
        paren = index(whole, "](")
        if (paren > 0) {
          url = substr(whole, paren + 2, length(whole) - paren - 2)
          if (url !~ /^(https?:|mailto:|#)/ && url !~ /^\//) {
            print url
          }
        }
        $0 = substr($0, RSTART + RLENGTH)
      }
    }
  ' "$mdfile")
done < <(find . -name '*.md' \
            -not -path './node_modules/*' \
            -not -path './.git/*' \
            -not -path './agent/sessions/*' \
            -not -path './agent/skills/*/references/*' \
            -not -path './docs/archive/*' \
            -not -path './.review/*' \
            -not -path './drafts/*' \
            -not -path './agent/extensions/compaction-optimizer/archive/*')
# Excluded paths:
#  - node_modules, .git:           dependency / VCS internals
#  - agent/sessions:               runtime session artifacts (not authored content)
#  - agent/skills/*/references:    cross-skill paths resolved at runtime, not authored intra-repo links
#  - docs/archive:                 frozen reference for rescinded substrates (ADR-0020); the relative
#                                  paths inside archived files resolved against the file's original
#                                  location and are intentionally broken at the new location
#  - .review:                      Tier 3 working-artifact area per ADR-0006/0007; gitignored, never
#                                  merged, may contain speculative or stale cross-references during planning
#  - drafts:                       working-artifact area per ADR-0006; gitignored, never merged,
#                                  may contain speculative or stale cross-references during drafting
#  - agent/extensions/compaction-optimizer/archive: runtime session archives per ADR-0019; gitignored,
#                                  never merged; relative paths inside reflect the original session
#                                  capture location and are intentionally not validated here

# --- 9. Setup.sh sanity ----------------------------------------------------
info "Checking setup.sh"
if [ ! -x setup.sh ]; then
  err "setup.sh: not executable"
fi
if ! grep -qE 'agent/extensions' setup.sh; then
  err "setup.sh: does not reference agent/extensions (count check missing?)"
fi
if ! grep -qE '\.example\.json' setup.sh; then
  err "setup.sh: missing the runtime-config seeding step (ADR-0049)"
fi

# --- 9a. Operator runtime config templates (ADR-0049) ----------------------
# The live agent/{settings,models}.json are gitignored and operator-owned; the
# repo ships generic *.example templates that setup.sh §2c seeds from. Guard the
# templates so the seed source cannot silently rot or the live files re-enter
# tracking.
info "Validating operator runtime config templates (ADR-0049)"
for cfg in settings models; do
  tmpl="agent/${cfg}.example.json"
  if [ ! -f "$tmpl" ]; then
    err "config template: $tmpl is missing"
    continue
  fi
  if [ ! -s "$tmpl" ]; then
    err "config template: $tmpl is empty"
  fi
  # settings.json.example is strict JSON; models.json.example is JSONC
  # (line comments + trailing commas), so only the former is jq-validated.
  if [ "$cfg" = "settings" ] && command -v jq >/dev/null 2>&1; then
    if jq empty "$tmpl" >/dev/null 2>&1; then
      ok "config template: $tmpl is valid JSON"
    else
      err "config template: $tmpl does not parse as JSON"
    fi
  else
    ok "config template: $tmpl present"
  fi
  # The live file must be gitignored (not tracked).
  live="agent/${cfg}.json"
  if git ls-files --error-unmatch "$live" >/dev/null 2>&1; then
    err "config: $live is tracked but must be gitignored and operator-owned (ADR-0049)"
  else
    ok "config: $live is not tracked"
  fi
done

# --- 9b. compaction-optimizer test suite ----------------------------------
info "Running compaction-optimizer test suite"
if [ -x scripts/test-compaction-optimizer.sh ]; then
  if co_output="$(scripts/test-compaction-optimizer.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$co_output"
    fi
    ok "compaction-optimizer: tests passed"
  else
    co_status=$?
    printf '%s\n' "$co_output" >&2
    if [ "$co_status" -eq 2 ]; then
      err "compaction-optimizer: test environment unavailable (node/npx); required check skipped"
    else
      err "compaction-optimizer: test suite failed (exit $co_status)"
    fi
  fi
else
  err "compaction-optimizer: scripts/test-compaction-optimizer.sh missing or not executable; required check skipped"
fi

# --- 9b-shared. shared/ foundation test suite (#329, ADR-0030) -------------
info "Running shared/ foundation test suite"
if [ -x scripts/test-shared.sh ]; then
  if sh_output="$(scripts/test-shared.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$sh_output"
    fi
    ok "shared: tests passed"
  else
    sh_status=$?
    printf '%s\n' "$sh_output" >&2
    if [ "$sh_status" -eq 2 ]; then
      err "shared: test environment unavailable (node/npx); required check skipped"
    else
      err "shared: test suite failed (exit $sh_status)"
    fi
  fi
else
  err "shared: scripts/test-shared.sh missing or not executable; required check skipped"
fi

# --- 9b-auto-router. auto-router test suite (#330, ADR-0031) ---------------
info "Running auto-router test suite"
if [ -x scripts/test-auto-router.sh ]; then
  if ar_output="$(scripts/test-auto-router.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$ar_output"
    fi
    ok "auto-router: tests passed"
  else
    ar_status=$?
    printf '%s\n' "$ar_output" >&2
    if [ "$ar_status" -eq 2 ]; then
      err "auto-router: test environment unavailable (node/npx); required check skipped"
    else
      err "auto-router: test suite failed (exit $ar_status)"
    fi
  fi
else
  err "auto-router: scripts/test-auto-router.sh missing or not executable; required check skipped"
fi

# --- 9b-context-manager. context-manager test suite (#331/#334, ADR-0032) --
info "Running context-manager test suite"
if [ -x scripts/test-context-manager.sh ]; then
  if cm_output="$(scripts/test-context-manager.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$cm_output"
    fi
    ok "context-manager: tests passed"
  else
    cm_status=$?
    printf '%s\n' "$cm_output" >&2
    if [ "$cm_status" -eq 2 ]; then
      err "context-manager: test environment unavailable (node/npx); required check skipped"
    else
      err "context-manager: test suite failed (exit $cm_status)"
    fi
  fi
else
  err "context-manager: scripts/test-context-manager.sh missing or not executable; required check skipped"
fi

# --- 9b-indexing. indexing test suite (#336, ADR-0033) ---------------------
info "Running indexing test suite"
if [ -x scripts/test-indexing.sh ]; then
  if ix_output="$(scripts/test-indexing.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$ix_output"
    fi
    ok "indexing: tests passed"
  else
    ix_status=$?
    printf '%s\n' "$ix_output" >&2
    if [ "$ix_status" -eq 2 ]; then
      err "indexing: test environment unavailable (node/npx); required check skipped"
    else
      err "indexing: test suite failed (exit $ix_status)"
    fi
  fi
else
  err "indexing: scripts/test-indexing.sh missing or not executable; required check skipped"
fi

# --- 9b-cache-meter. cache-meter test suite (#338, ADR-0034) ---------------
info "Running cache-meter test suite"
if [ -x scripts/test-cache-meter.sh ]; then
  if cmt_output="$(scripts/test-cache-meter.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$cmt_output"
    fi
    ok "cache-meter: tests passed"
  else
    cmt_status=$?
    printf '%s\n' "$cmt_output" >&2
    if [ "$cmt_status" -eq 2 ]; then
      err "cache-meter: test environment unavailable (node/npx); required check skipped"
    else
      err "cache-meter: test suite failed (exit $cmt_status)"
    fi
  fi
else
  err "cache-meter: scripts/test-cache-meter.sh missing or not executable; required check skipped"
fi

# --- 9b-cache-ratio. cache-ratio analysis self-test (#338, ADR-0034) -------
# Regression-tests the analysis logic against fixtures. The LIVE measurement is
# operator-run (real provider sessions) and is intentionally NOT CI-gated.
info "Running cache-ratio analysis self-test"
if [ -x scripts/analyze-cache-ratio.sh ]; then
  if car_output="$(scripts/analyze-cache-ratio.sh --self-test 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$car_output"
    fi
    ok "cache-ratio: analysis self-test passed"
  else
    car_status=$?
    printf '%s\n' "$car_output" >&2
    if [ "$car_status" -eq 2 ]; then
      err "cache-ratio: self-test environment unavailable (jq); required check skipped"
    else
      err "cache-ratio: analysis self-test failed (exit $car_status)"
    fi
  fi
else
  err "cache-ratio: scripts/analyze-cache-ratio.sh missing or not executable; required check skipped"
fi

# --- 9b-0. expertise-client test suite (#317, ADR-0028) --------------------
info "Running expertise-client test suite"
if [ -x scripts/test-expertise-client.sh ]; then
  if ec_output="$(scripts/test-expertise-client.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$ec_output"
    fi
    ok "expertise-client: tests passed"
  else
    ec_status=$?
    printf '%s\n' "$ec_output" >&2
    if [ "$ec_status" -eq 2 ]; then
      err "expertise-client: test environment unavailable (node/npx); required check skipped"
    else
      err "expertise-client: test suite failed (exit $ec_status)"
    fi
  fi
else
  err "expertise-client: scripts/test-expertise-client.sh missing or not executable; required check skipped"
fi

# --- 9b-bis. gh-identity-guard test suite (ADR-0022) -----------------------
info "Running gh-identity-guard test suite"
if [ -x scripts/test-gh-identity-guard.sh ]; then
  if gig_output="$(scripts/test-gh-identity-guard.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$gig_output"
    fi
    ok "gh-identity-guard: tests passed"
  else
    gig_status=$?
    printf '%s\n' "$gig_output" >&2
    if [ "$gig_status" -eq 2 ]; then
      err "gh-identity-guard: test environment unavailable (node/npx); required check skipped"
    else
      err "gh-identity-guard: test suite failed (exit $gig_status)"
    fi
  fi
else
  err "gh-identity-guard: scripts/test-gh-identity-guard.sh missing or not executable; required check skipped"
fi

# --- 9b-ter. gh-identity-guard pre-push hook tests (#257) ------------------
info "Running gh-identity-guard pre-push hook tests"
if [ -x scripts/test-gh-identity-hook.sh ]; then
  if gih_output="$(scripts/test-gh-identity-hook.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$gih_output"
    fi
    ok "gh-identity-guard hook: tests passed"
  else
    gih_status=$?
    printf '%s\n' "$gih_output" >&2
    err "gh-identity-guard hook: test suite failed (exit $gih_status)"
  fi
else
  err "gh-identity-guard hook: scripts/test-gh-identity-hook.sh missing or not executable; required check skipped"
fi

# --- 9b-quater. secrets-guard test suite (#258) ----------------------------
info "Running secrets-guard test suite"
if [ -x scripts/test-secrets-guard.sh ]; then
  if sg_output="$(scripts/test-secrets-guard.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$sg_output"
    fi
    ok "secrets-guard: tests passed"
  else
    sg_status=$?
    printf '%s\n' "$sg_output" >&2
    if [ "$sg_status" -eq 2 ]; then
      err "secrets-guard: test environment unavailable (node/npx); required check skipped"
    else
      err "secrets-guard: test suite failed (exit $sg_status)"
    fi
  fi
else
  err "secrets-guard: scripts/test-secrets-guard.sh missing or not executable; required check skipped"
fi

# --- 9b-quinquies. bash-destructive-guard test suite (#258) ----------------
info "Running bash-destructive-guard test suite"
if [ -x scripts/test-bash-destructive-guard.sh ]; then
  if bdg_output="$(scripts/test-bash-destructive-guard.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$bdg_output"
    fi
    ok "bash-destructive-guard: tests passed"
  else
    bdg_status=$?
    printf '%s\n' "$bdg_output" >&2
    if [ "$bdg_status" -eq 2 ]; then
      err "bash-destructive-guard: test environment unavailable (node/npx); required check skipped"
    else
      err "bash-destructive-guard: test suite failed (exit $bdg_status)"
    fi
  fi
else
  err "bash-destructive-guard: scripts/test-bash-destructive-guard.sh missing or not executable; required check skipped"
fi

# --- 9c. extension type-check (ADR-0021) -----------------------------------
info "Running typecheck-extensions"
if [ -x scripts/typecheck-extensions.sh ]; then
  if tc_output="$(scripts/typecheck-extensions.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$tc_output"
    fi
    ok "typecheck-extensions: all extensions clean"
  else
    tc_status=$?
    printf '%s\n' "$tc_output" >&2
    if [ "$tc_status" -eq 2 ]; then
      err "typecheck-extensions: environment unavailable; required check skipped"
    else
      err "typecheck-extensions: failed (exit $tc_status)"
    fi
  fi
else
  err "typecheck-extensions: scripts/typecheck-extensions.sh missing or not executable; required check skipped"
fi

# --- 9d. extension lint (ADR-0021) -----------------------------------------
info "Running lint-extensions"
if [ -x scripts/lint-extensions.sh ]; then
  if le_output="$(scripts/lint-extensions.sh 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$le_output"
    fi
    ok "lint-extensions: no errors ($(printf '%s' "$le_output" | tail -1))"
  else
    le_status=$?
    printf '%s\n' "$le_output" >&2
    if [ "$le_status" -eq 2 ]; then
      err "lint-extensions: environment unavailable; required check skipped"
    else
      err "lint-extensions: failed (exit $le_status)"
    fi
  fi
else
  err "lint-extensions: scripts/lint-extensions.sh missing or not executable; required check skipped"
fi

# --- 10. markdownlint -------------------------------------------------------
# Runs markdownlint-cli2 across all authored markdown using the repo's
# .markdownlint-cli2.yaml configuration. Pinned to v0.22.1 for reproducibility
# (matches the version invoked by the `linter` subagent).
info "Running markdownlint-cli2"
if [ ! -f .markdownlint-cli2.yaml ]; then
  err "markdownlint: .markdownlint-cli2.yaml missing at repo root"
elif ! command -v npx >/dev/null 2>&1; then
  err "markdownlint: npx not found; markdownlint is a required check (install Node.js to enable)"
else
  if ml_output="$(npx --yes markdownlint-cli2@0.22.1 2>&1)"; then
    if [ "$VERBOSE" = "1" ]; then
      printf '%s\n' "$ml_output"
    fi
    ok "markdownlint: clean"
  else
    printf '%s\n' "$ml_output" >&2
    err "markdownlint: violations found (see output above)"
  fi
fi

# --- Summary ---------------------------------------------------------------
echo
if [ "$errors" -gt 0 ]; then
  echo "${RED}FAIL${RST} — $errors error(s), $warnings warning(s), $checks check(s) ok"
  exit 1
fi
echo "${GRN}PASS${RST} — $errors error(s), $warnings warning(s), $checks check(s) ok"
exit 0
