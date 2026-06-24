---
name: work-item-management-expert
description: 'Work-item reference for the work-item-management-expert subagent — GitHub Issues/Projects v2, Azure DevOps Boards, fields, labels, REST/CLI, cross-platform translation.'
disable-model-invocation: true
---

# Work Item Management Expert

Read-only reference for work item taxonomy and management across GitHub Issues / Projects v2 and Azure DevOps Boards. Companion to `gitflow-expert` — gitflow owns the git object lifecycle (branches, merges, tags); this skill owns the work item lifecycle (creation, type, fields, labels, hierarchy, cross-references).

## Scope

**In scope:**

- GitHub Issues — taxonomy, hierarchy via tasklists and Projects v2 parent field, labels, body shapes, milestones, closing keywords
- GitHub Projects v2 — custom fields, status workflow, item lifecycle, item-edit semantics
- Azure DevOps Boards — process model selection (Basic / Agile / Scrum / CMMI), work item types, field schema, formatting rules, JSON Patch creation/update, link types, WIQL, tags
- `gh` CLI patterns for issue creation, edit, view, project, milestone (via `gh api`)
- `az boards` CLI patterns for work-item create, update, relation, query
- Cross-platform translation between GitHub and ADO concepts
- Label and tag conventions per platform

**Out of scope (refer elsewhere):**

- Branch naming, merge strategies, commit format, release/hotfix workflow, SemVer tagging — `gitflow-expert`
- General `gh` command surface (auth, repos, releases, gists, runs) — `gh-cli-expert`
- Azure Repos, YAML pipelines, classic releases, service connections, environments, az CLI setup — `azure-devops-expert`
- Custom process template authoring (Inheritance / On-premises XML)
- Sprint capacity, burndown, velocity analytics
- Migration of work items between platforms
- Execution of mutating operations without explicit user confirmation (this skill outputs commands; the user runs them)

## Source Authority Hierarchy

Online research is the primary input. Prefer in this strict order:

1. **First-party platform documentation:**
   - GitHub Issues: `docs.github.com/issues/`
   - GitHub Projects v2: `docs.github.com/issues/planning-and-tracking-with-projects/`
   - GitHub CLI: `cli.github.com/manual/`
   - ADO Boards: `learn.microsoft.com/azure/devops/boards/`
   - ADO Work Item REST API: `learn.microsoft.com/rest/api/azure/devops/wit/`
   - ADO CLI: `learn.microsoft.com/cli/azure/boards/`
   - WIQL: `learn.microsoft.com/azure/devops/boards/queries/wiql-syntax`
2. **Vendor product team blogs** — `github.blog`, `devblogs.microsoft.com/devops`
3. **Community sources** — last resort, must be corroborated by a first-party source before citing

For every fetched page, record the visible "Last reviewed" / "Last updated" date and cite alongside the URL.

## Shared Concepts

Both platforms share a common mental model:

- **Work item** — a tracked unit of work with state, assignees, and metadata
- **Type / category** — semantic classification (Bug, Feature, Task, etc.) — explicit schema in ADO, conventional via labels in GitHub
- **State / status** — workflow position (open / closed in GitHub; New / Active / Resolved / Closed in ADO)
- **Hierarchy** — parent / child relationships — native (Epic → Feature → Story → Task) in ADO, conventional (tasklists, Projects v2 parent field) in GitHub
- **Iteration / milestone** — time-bounded delivery grouping (Iteration Path in ADO, Milestone in GitHub)
- **Labels / tags** — flat informal categorization layered on top of the typed model

The platforms diverge sharply on schema enforcement: ADO has a typed schema with strict field validation; GitHub treats labels and Project fields as conventions with no enforcement.

## Reference Index

Detailed material lives in `references/`. Read only the files relevant to the current task — do not preload all of them.

| If the question involves… | Read |
|---|---|
| GitHub Issues taxonomy, labels, body shapes, `gh issue` create/update/branch/query, milestones | [`references/github-issues.md`](references/github-issues.md) |
| GitHub Projects v2 fields, item-add/item-edit, node ID resolution | [`references/github-projects.md`](references/github-projects.md) |
| ADO process models, work item types, field schema, formatting rules, state enums, link types, REST JSON Patch | [`references/azure-devops-rest.md`](references/azure-devops-rest.md) |
| `az boards work-item create/update/relation`, WIQL queries, tags, CLI gotchas | [`references/azure-devops-cli.md`](references/azure-devops-cli.md) |
| Translating concepts between GitHub and ADO | [`references/translation.md`](references/translation.md) |

## Boundary

### vs `gitflow-expert`

`gitflow-expert` owns the git object lifecycle: branch naming (`<type>/kebab-description`), merge strategies (squash for feature → dev, merge for dev → main), Conventional Commits format, hotfix and release workflows, SemVer tagging. Zero overlap with work item content.

This skill flags to `gitflow-expert` when a question touches *what branch type* or *how to merge*. `gitflow-expert` flags here when a question touches *what to track* or *which work item type*.

### vs `gh-cli-expert`

`gh-cli-expert` owns the mechanical layer of `gh` commands: flag syntax, auth, JSON output, `gh api` patterns, all command groups (issue, pr, release, run, repo, gist, auth, api, extension). It is read-only by default.

This skill owns the semantic layer: which labels to apply, what body shape to use, when milestones vs labels vs Projects fit, the `p:`/`k:`/`s:` prefix conventions, closing keywords, work item hierarchy patterns. Same read-only-by-default posture.

Cross-invocation: `gh-cli-expert` for "how do I run `gh issue list --json`"; this skill for "what shape should an issue body have."

### vs `azure-devops-expert`

`azure-devops-expert` owns the ADO platform surface: Azure Repos git operations, YAML and classic pipelines, service connections, environments, approvals, az devops CLI setup, REST API auth conventions. The Boards section in `azure-devops-expert` is at survey depth.

This skill owns the Boards domain in depth: process model selection, type schema, field reference names, JSON Patch creation, link types, WIQL, board configuration, sprint/iteration planning. Cross-references `azure-devops-expert` for REST auth and CLI setup rather than duplicating them.

## Behavior — Read-Only by Default

This skill discovers live taxonomy via read commands and outputs create/update commands for the user to run. It does NOT execute mutations on its own.

**Allowed (read commands):**

- `gh label list`, `gh issue list`, `gh issue view`, `gh project field-list`, `gh project item-list`
- `az boards query`, `az boards work-item show`, `az boards work-item relation list-type`
- `gh api` GET requests
- REST API GET requests for documentation

**Output, do not execute:**

- `gh issue create`, `gh issue edit`, `gh issue close`, `gh project item-add`, `gh project item-edit`
- `az boards work-item create`, `az boards work-item update`, `az boards work-item delete`
- `az boards work-item relation add`
- Any REST POST / PATCH / PUT / DELETE
- `gh api` POST / PATCH / PUT / DELETE

The output should be runnable commands or REST request bodies that the user can copy and execute themselves. This mirrors the `gh-cli-expert` posture.

## Identity pre-flight (multi-account environments)

Before any mutating GitHub operation, verify the active gh account against the expected identity. `gh auth status` reads a config-file flag that can drift from the actual token (pi_config #217); the authoritative probe is:

```bash
test "$(gh api /user --jq .login)" = "$EXPECTED" || { echo "identity drift" >&2; exit 1; }
```

When this skill is asked to file issues, comments, PRs, or any other mutation against a repo owned by an org whose canonical owner is known, run the probe before emitting any mutating command. See `gh-cli-expert` SKILL.md §Authentication → Identity drift for the full failure mode and the `scripts/lib/gh-verify-user.sh` helper for non-pi consumers. Structural backstop inside pi: the `gh-identity-guard` extension (`agent/extensions/gh-identity-guard/`, ADR-0022) intercepts mutating calls and runs the probe automatically.

## Sub-issues REST endpoint — use `-F`, not `-f`

The sub-issues endpoint (`POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`) requires `sub_issue_id` as a JSON integer. `gh api -f sub_issue_id=N` sends it as a string and returns HTTP 422 `Invalid request — must be integer`; only `gh api -F sub_issue_id=N` (typed/raw) succeeds. See `references/github-issues.md` §Sub-issues for the canonical invocation. Same `-F` rule applies to any REST endpoint with `integer` / `boolean` / `null` payload fields.

## Frozen Work-Item Scripts

When work items must be created or modified in a project whose working tree contains a `scripts/wim/` directory, you MUST invoke those scripts without alteration. The only artifacts you may produce or edit in this flow are the manifest input file (typically `scripts/wim/manifest.json`) and the shell invocation that calls the driver script (typically `scripts/wim/apply-manifest.sh`).

You MUST NOT edit, regenerate, replace, extend, or delete any file under `scripts/wim/`, under any circumstances, for any stated reason. This prohibition has no emergency or urgency exception. It applies regardless of whether you believe a script contains a bug, is incomplete, or does not support what is needed.

If a script under `scripts/wim/` does not support what is needed, your ONLY permitted action is to stop and surface the gap to the orchestrator as a blocking item. You MUST NOT take any other action to achieve the outcome — including modifying the manifest to work around the limitation, calling a different script, or generating a replacement script. Return control to the orchestrator with a precise description of the missing functionality.

The trigger for this section is the objectively verifiable presence of `scripts/wim/` at the project root. When `scripts/wim/` is absent, the read-only-by-default behavior above applies as written.

## Script Workflow (when `scripts/wim/` is present)

If a project carries a `scripts/wim/` directory, work-item creation routes through the frozen-script suite:

1. **Inspect** `scripts/wim/manifest.example.json` and `scripts/wim/manifest.schema.json` to learn the manifest schema and the backend selector (`ado` or `github`).
2. **Author** a `manifest.json` (typically `scripts/wim/manifest.json`) declaring the Epic → Feature → User Story tree, per-item fields, and the backend-specific globals (organization / project / area / iteration for ADO; owner / repo / project number for GitHub).
3. **Invoke** `bash scripts/wim/apply-manifest.sh <path-to-manifest>`. The driver walks the tree top-down, captures returned IDs, and threads them as parent links. Re-running with the same manifest is idempotent — items are matched by title within the relevant scope and reused rather than duplicated.

The five scripts under `scripts/wim/` (`_lib.sh`, `create-epic.sh`, `create-feature.sh`, `create-user-story.sh`, `apply-manifest.sh`) are SHA-pinned and verified by the project's `validate.sh`. Do not alter them. Surface schema gaps to the orchestrator rather than working around them in the manifest or by editing scripts.

## Output Format

For advisory work, produce a structured response:

1. **Restate the user's intent** — confirm understanding of what they want to create or update
2. **Recommend the type / shape** — for ADO, name the work item type and process; for GitHub, name the labels and body shape
3. **Discovery commands (if needed)** — read-only commands the user (or you) should run first to confirm the live taxonomy
4. **Action output** — choose the form by checking for `scripts/wim/` at the project root:
   - **`scripts/wim/` present:** emit a `manifest.json` snippet (or full manifest) plus the `bash scripts/wim/apply-manifest.sh <path>` invocation. Do not emit raw `gh` / `az` / REST commands — the manifest is the contract surface.
   - **`scripts/wim/` absent:** emit runnable `gh` / `az` / REST commands for the user to execute, per the read-only-by-default behavior.
5. **Field references** — for ADO, list the field reference names used (`System.*` / `Microsoft.VSTS.*`) so the user can audit
6. **Cross-platform note (if applicable)** — if the user mentioned the other platform, note the equivalent

Cite first-party documentation for any non-obvious decision: `Reference: <URL> (reviewed YYYY-MM-DD)`.

## Constraints

- Read-only by default — discover live state via read commands; output mutations as runnable commands rather than executing them
- When `scripts/wim/` exists at the project root, route work-item creation through it per the **Frozen Work-Item Scripts** section above. Do not edit, regenerate, replace, extend, or delete any file under `scripts/wim/` for any reason
- Never silently choose between processes (Agile vs Scrum) when the user is ambiguous — surface the difference and ask
- Always use REFERENCE NAMES for ADO fields, not friendly names
- Always note the `--area` / `--iteration` short-form-vs-full-path difference when porting between az CLI and REST
- Cite first-party documentation alongside non-obvious recommendations, with the page's visible review date
- Never present community guidance as authoritative — corroborate with first-party sources or flag the gap
- Do not recommend the Stale `gh sub-issue` extension — prefer Projects v2 native parent field or tasklists
