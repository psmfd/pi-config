#!/usr/bin/env bash
#
# check-mirror-ci.sh — the mirror CI health watch (ADR-0133).
#
# Reports the CI state of every public distribution mirror declared in
# mirror/targets.yml. Nothing else in this repo observes a mirror's own CI: a
# mirror can sit red on main indefinitely and no signal reaches the source repo
# (psmfd/pi-config#967 — psmfd/pi-token-meter was red for 18 days before the
# #856 packaging sweep happened to run its CI commands locally).
#
# The mirrors are the distribution surface. A red mirror means either the
# shipped artifact is broken or its gate is lying, so "cannot tell" is a
# finding here, never a pass.
#
# Three false-green traps this gate is built to avoid:
#
#   1. Branch-only queries.   `gh run list --branch main` surfaces Dependabot
#                             updater runs, which are frequent and almost always
#                             green, and they dominate the default listing. The
#                             workflow must be named explicitly. This masking is
#                             the whole of #967.
#   2. Disabled workflows.    A ci.yml set to `disabled_manually` leaves its last
#                             green run standing forever. The gate asserts
#                             `state == active`, not just the last conclusion.
#   3. Blind exemptions.      The replace-mode config mirror ships no CI by
#                             design (ADR-0054). Rather than skipping it, the
#                             gate asserts the ABSENCE — so a workflow appearing
#                             there is drift that gets reported, not swallowed.
#
# Scope is DERIVED from mirror/targets.yml, the single source of truth for what
# gets published, so this gate cannot drift from the live mirror set. It
# deliberately adds no fourth site to the ADR-0074 lockstep triple
# (targets.yml / sync-mirrors.yml / install.sh).
#
# NOT a release gate. ADR-0057 wired the code-scanning gate into release.sh
# Phase 0; this one is deliberately excluded. A mirror is often red *because*
# it is awaiting the fix that the next promotion carries — blocking the
# promotion on mirror red would deadlock the very case the watch surfaces.
#
# Usage:
#   scripts/check-mirror-ci.sh [--verbose]
#
# Flags:
#   --verbose   Print the run URL and head commit for green mirrors too.
#               Failures always print their detail regardless.
#   -h|--help   Print this help and exit.
#
# Environment (test seams; defaults are the real contract):
#   MIRROR_CI_WORKFLOW   Workflow file to query (default: ci.yml).
#   MIRROR_CI_BRANCH     Branch to read runs from (default: main).
#
# Exit codes:
#   0 — every mirror is green (and the exempt target is genuinely exempt)
#   1 — one or more findings
#   2 — environment/precondition failure (missing gh/jq/yq, not authenticated)
#
# Requires: gh (authenticated), jq, yq (mikefarah). The mirrors are public, so
# the repo-scoped default GITHUB_TOKEN is sufficient in CI — the mirror-sync
# GitHub App (ADR-0061) is deliberately NOT widened to Actions:read for this.

set -euo pipefail

# Inline output helpers (no scripts/lib/log.sh in this repo; matches
# check-mirror-alerts.sh and the script-output-conventions rule).
errors=0
warnings=0
ok()     { printf 'OK    [%s] %s\n' "$1" "$2"; }
warn()   { printf 'WARN  [%s] %s\n' "$1" "$2" >&2; warnings=$((warnings + 1)); }
info()   { printf 'INFO  %s\n' "$*"; }
err()    { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; errors=$((errors + 1)); }
detail() { printf '      %s\n' "$*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="${SCRIPT_DIR}/../mirror/targets.yml"
WORKFLOW="${MIRROR_CI_WORKFLOW:-ci.yml}"
BRANCH="${MIRROR_CI_BRANCH:-main}"
VERBOSE="${VERBOSE:-0}"

usage() { sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
	case "$1" in
		--verbose)   VERBOSE=1; shift ;;
		-h|--help)   usage; exit 0 ;;
		*) err args "unknown argument: $1"; usage >&2; exit 2 ;;
	esac
done

command -v gh >/dev/null 2>&1 || { err deps "gh not found"; exit 2; }
command -v jq >/dev/null 2>&1 || { err deps "jq not found"; exit 2; }
command -v yq >/dev/null 2>&1 || { err deps "yq (mikefarah) not found"; exit 2; }
[ -f "$MANIFEST" ] || { err deps "sync manifest not found: $MANIFEST"; exit 2; }
if ! gh auth status >/dev/null 2>&1 && [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
	err auth "gh is not authenticated and no GH_TOKEN/GITHUB_TOKEN is set"
	exit 2
fi

# gh_get PATH — print the response body on success (exit 0).
#
# On failure, print a one-line truncated diagnostic on STDOUT and exit 1 for a
# determinate 404 or 2 for anything else (network, auth, rate limit). The
# diagnostic goes to stdout, not a global, because every caller captures this in
# a command substitution — a global set inside that subshell would be lost, and
# an empty error message on a fail-closed path is how a real failure gets
# reported as a mystery.
gh_get() {
	local out
	if out="$(gh api "$1" 2>&1)"; then
		printf '%s' "$out"
		return 0
	fi
	printf '%s' "$out" | tr '\n' ' ' | cut -c1-200
	case "$out" in
		*'(HTTP 404)'*) return 1 ;;
	esac
	return 2
}

info "Mirror CI health — workflow: ${WORKFLOW}, branch: ${BRANCH}, manifest: mirror/targets.yml"

while IFS="$(printf '\t')" read -r t_name t_repo t_mode; do
	[ -n "$t_name" ] || continue

	# The slug is interpolated into an API path; constrain it to the owner/name
	# shape so a malformed manifest entry fails loudly here rather than
	# producing a nonsense request whose 404 would read as "no workflow".
	case "$t_repo" in
		[A-Za-z0-9._-]*/[A-Za-z0-9._-]*) : ;;
		*) err "$t_name" "manifest repo slug is not a well-formed owner/name: '${t_repo}'"; continue ;;
	esac

	rc=0
	wf_body="$(gh_get "repos/${t_repo}/actions/workflows/${WORKFLOW}")" || rc=$?

	# --- replace-mode: assert the ADR-0054 exemption, don't assume it --------
	if [ "$t_mode" = "replace" ]; then
		case "$rc" in
			0) err "$t_name" "has a ${WORKFLOW} workflow, but ADR-0054 says the replace-mode config mirror ships none — reconcile ADR-0054 or bring this target into the gate's scope" ;;
			1) ok "$t_name" "exempt — mode=replace ships no ${WORKFLOW} (ADR-0054)" ;;
			*) err "$t_name" "could not determine whether ${WORKFLOW} exists: ${wf_body}" ;;
		esac
		continue
	fi

	# --- overlay-mode: the extension mirrors, each of which ships a ci.yml ---
	if [ "$rc" -eq 1 ]; then
		# A missing repo 404s identically to a missing workflow; both are findings,
		# so name both rather than asserting the one we cannot distinguish.
		# (Repo existence itself is the sync-mirror.sh onboarding preflight's job.)
		err "$t_name" "${WORKFLOW} not reachable on ${t_repo} (missing workflow, or missing/inaccessible repo) — every overlay mirror ships one in its mirror-owned packaging overlay"
		continue
	elif [ "$rc" -ne 0 ]; then
		err "$t_name" "could not query ${WORKFLOW}: ${wf_body}"
		continue
	fi

	wf_state="$(printf '%s' "$wf_body" | jq -r '.state // "unknown"')"
	if [ "$wf_state" != "active" ]; then
		err "$t_name" "${WORKFLOW} is not active (state=${wf_state}) — a disabled workflow leaves its last green run standing forever"
		continue
	fi

	rc=0
	runs="$(gh_get "repos/${t_repo}/actions/workflows/${WORKFLOW}/runs?branch=${BRANCH}&status=completed&per_page=1")" || rc=$?
	if [ "$rc" -ne 0 ]; then
		err "$t_name" "could not query ${WORKFLOW} runs on ${BRANCH}: ${runs}"
		continue
	fi
	if [ "$(printf '%s' "$runs" | jq -r '.workflow_runs | length')" = "0" ]; then
		err "$t_name" "${WORKFLOW} has no completed run on ${BRANCH} — no data is a finding, not a pass"
		continue
	fi

	conclusion="$(printf '%s' "$runs" | jq -r '.workflow_runs[0].conclusion // "none"')"
	run_url="$(printf '%s' "$runs" | jq -r '.workflow_runs[0].html_url // "?"')"
	run_at="$(printf '%s' "$runs" | jq -r '.workflow_runs[0].updated_at // "?"')"
	run_sha="$(printf '%s' "$runs" | jq -r '.workflow_runs[0].head_sha // "?"' | cut -c1-7)"
	run_title="$(printf '%s' "$runs" | jq -r '.workflow_runs[0].display_title // "?"' | cut -c1-72)"

	if [ "$conclusion" = "success" ]; then
		ok "$t_name" "${WORKFLOW} green on ${BRANCH} (${run_at})"
		if [ "$VERBOSE" = "1" ]; then
			detail "${run_sha} ${run_title}"
			detail "$run_url"
		fi
	else
		# Always surface the attribution on a failure, not just under --verbose:
		# the commit subject names the sync (or the packaging commit) that broke
		# it, which is most of the "which push did this" question.
		err "$t_name" "${WORKFLOW} on ${BRANCH} concluded '${conclusion}' (${run_at})"
		detail "${run_sha} ${run_title}" >&2
		detail "$run_url" >&2
	fi
done < <(yq -r '.targets[] | [.name, .repo, (.mode // "")] | @tsv' "$MANIFEST")

echo "=================================="
if [ "$errors" -eq 0 ]; then
	printf 'PASS — %d errors, %d warnings\n' "$errors" "$warnings"
	exit 0
fi
printf 'FAIL — %d errors, %d warnings\n' "$errors" "$warnings"
printf 'INFO  Mirrors are derived artifacts: fix at source in pi_config and let the\n'
printf 'INFO  next dev->main promotion sync it out. Mirror-owned packaging files\n'
printf 'INFO  (package.json, package-lock.json, .github/) are the exception — those\n'
printf 'INFO  are fixed on the mirror itself; see docs/vendor-updates.md.\n'
exit 1
