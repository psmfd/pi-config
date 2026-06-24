---
name: gh-cli-expert
description: 'GitHub CLI reference for the gh-cli-expert subagent — gh issue, pr, release, run, repo, auth, api, extension commands.'
disable-model-invocation: true
---

# gh CLI Expert — Reference

## Command Groups

### Core collaboration

| Command | Subcommands | Purpose |
|---|---|---|
| `gh issue` | list, view, create, edit, close, reopen, delete, comment, lock, unlock, pin, unpin, transfer, status, develop | Issue management |
| `gh pr` | list, view, create, edit, close, reopen, merge, checks, diff, review, comment, ready, revert, checkout, update-branch, lock, unlock, status | Pull request workflow |
| `gh repo` | list, view, create, clone, fork, edit, rename, delete, archive, unarchive, sync, set-default, deploy-key, autolink, gitignore, license | Repository management |
| `gh project` | list, view, create, edit, close, delete, copy, link, unlink, mark-template, field-create, field-delete, field-list, item-add, item-create, item-edit, item-delete, item-list, item-archive | GitHub Projects v2 |
| `gh gist` | list, view, create, edit, delete, clone, rename | Gist management |

### Actions and CI

| Command | Subcommands | Purpose |
|---|---|---|
| `gh run` | list, view, watch, download, rerun, cancel, delete | Workflow run management |
| `gh workflow` | list, view, run, enable, disable | Workflow definitions |
| `gh cache` | list, delete | Actions cache management |
| `gh secret` | list, set, delete | Actions/Codespace/Dependabot secrets |
| `gh variable` | list, get, set, delete | Actions/environment variables |

### Releases and supply chain

| Command | Subcommands | Purpose |
|---|---|---|
| `gh release` | list, view, create, edit, delete, delete-asset, download, upload, verify, verify-asset | Release management |
| `gh attestation` | verify, download, trusted-root | Build provenance verification (Sigstore) |

### Search and discovery

| Command | Subcommands | Purpose |
|---|---|---|
| `gh search` | issues, prs, repos, code, commits | Cross-GitHub search |
| `gh browse` | (flags only) | Open repo/issue/PR in browser |
| `gh status` | (flags only) | Dashboard: assigned issues/PRs, review requests, mentions |

### Authentication and identity

| Command | Subcommands | Purpose |
|---|---|---|
| `gh auth` | login, logout, status, refresh, switch, token, setup-git | Authentication lifecycle |
| `gh ssh-key` | add, delete, list | SSH key management |
| `gh gpg-key` | add, delete, list | GPG key management |

### Configuration and tooling

| Command | Subcommands | Purpose |
|---|---|---|
| `gh config` | get, set, list, clear-cache | gh configuration |
| `gh alias` | set, delete, list, import | Command shortcuts |
| `gh extension` | install, list, upgrade, remove, search, browse, create, exec | Extension lifecycle |
| `gh label` | list, create, edit, delete, clone | Label management |
| `gh ruleset` | list, view, check | Repository rulesets |
| `gh copilot` | (native command) | GitHub Copilot CLI |
| `gh agent-task` | create, list, view | GitHub Agentic Workflows (preview) |

### Cross-cutting flags

These flags are available on most subcommands:

| Flag | Purpose |
|---|---|
| `-R, --repo [HOST/]OWNER/REPO` | Target a different repo |
| `--json <fields>` | Output as JSON with named fields |
| `-q, --jq <expression>` | Filter JSON with jq syntax (bundled, no binary needed) |
| `-t, --template <string>` | Format with Go template |
| `-L, --limit <int>` | Limit result count |
| `-w, --web` | Open in browser instead of terminal |

## Safety Model

### Read-only — safe to execute without confirmation

| Category | Commands |
|---|---|
| Listing | `list` on any resource (issue, pr, run, release, repo, etc.) |
| Viewing | `view`, `status`, `checks`, `diff` |
| Monitoring | `watch` (streams live output, no state change) |
| Downloading | `download` (writes locally only) |
| Searching | `gh search {issues,prs,repos,code,commits}` |
| Browsing | `gh browse` (opens browser) |
| Auth inspection | `gh auth status`, `gh auth token`, `gh api /user --jq .login` (authoritative active-account check — see Authentication §Identity drift) |
| API reads | `gh api` with explicit `--method GET` or no `-f`/`-F` flags |

### Mutating — require explicit user intent before executing

| Category | Commands | What changes |
|---|---|---|
| Creating | `create` on any resource | New issue, PR, release, repo, etc. |
| Editing | `edit`, `rename`, `comment`, `review` | Resource metadata or content |
| State changes | `close`, `reopen`, `merge`, `ready`, `revert` | Resource state |
| Workflow control | `rerun`, `cancel`, `enable`, `disable` | Actions run/workflow state |
| Branch ops | `checkout`, `update-branch`, `sync` | Local or remote git state |
| Secrets/vars | `set` | Actions secrets or variables |
| Upload | `upload` | Release assets |

### Destructive — warn explicitly, never pre-fill `--yes`

| Command | What is destroyed | Reversible? |
|---|---|---|
| `gh issue delete` | Permanent issue deletion | No |
| `gh repo delete` | Permanent repository deletion | No |
| `gh repo archive` | Archives repo | Yes (`unarchive`) |
| `gh run delete` | Permanent run history deletion | No |
| `gh release delete` | Deletes release (tag survives unless `--cleanup-tag`) | No |
| `gh release delete-asset` | Permanent asset removal | No |
| `gh cache delete` | Permanent cache entry deletion | No |
| `gh gist delete` | Permanent gist deletion | No |
| `gh api` with DELETE method | Depends on endpoint | Varies |

Never include `--yes` or `-y` in destructive commands. Let interactive confirmation run.

## Dynamic Help Consultation

Flag syntax and available `--json` fields change with each `gh` release. Use a three-tier consultation model:

**Tier 1 — Embedded reference.** Use the command groups and safety model above for routing and classification. This covers the common path without tool calls.

**Tier 2 — On-demand help.** Before composing any command with non-trivial flags, run:

```bash
gh <command> <subcommand> --help 2>&1
```

Parse the FLAGS section. This is mandatory for:

- Any mutating or destructive command
- Any `--json` field discovery (or run the command with `--json` and no value to list fields)
- Any `gh api` call
- Any flag the agent is not confident about

**Tier 3 — Web search.** For version-specific behavior, API endpoint semantics, or GraphQL schema questions, search GitHub CLI docs or releases.

Do not re-run `--help` for the same subcommand twice in a session. Reuse from context.

## Common Patterns

### JSON output and filtering

```bash
# Specific fields
gh pr list --json number,title,state,author,labels

# Discover available fields (no value = list fields)
gh pr list --json

# jq filter (bundled — no jq binary needed)
gh issue list --json number,title --jq '.[] | "\(.number): \(.title)"'

# Go template with table output
gh pr list --json number,title,author \
  --template '{{range .}}{{tablerow .number .title .author.login}}{{end}}{{tablerender}}'
```

Go template built-in helpers: `color`, `autocolor`, `join`, `pluck`, `truncate`, `tablerow`, `tablerender`, `timeago`, `timefmt`, `hyperlink`, `contains`, `hasPrefix`, `hasSuffix`, `regexMatch`.

### Cross-repo targeting

```bash
gh issue list -R owner/repo
gh api repos/owner/repo/pulls --jq '.[].title'
```

### Scripting (non-interactive)

```bash
GH_PROMPT_DISABLED=1 gh issue list --json number,title --jq '.[].number'
```

## gh api Reference

The most flexible command — proxies any GitHub REST or GraphQL call with automatic authentication.

### REST

```bash
# GET (read-only)
gh api repos/{owner}/{repo}/issues --jq '.[].title'

# POST (mutating — confirm first)
gh api repos/{owner}/{repo}/issues -f title="Bug report" -f body="Details..."

# Pagination
gh api --paginate repos/{owner}/{repo}/issues --jq '.[].number'

# Pagination into single array
gh api --paginate --slurp repos/{owner}/{repo}/issues
```

### GraphQL

```bash
gh api graphql -f query='query { viewer { login } }'

# With variables
gh api graphql -F owner='{owner}' -F name='{repo}' \
  -f query='query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { stargazerCount }
  }'

# Paginated GraphQL
gh api graphql --paginate -f query='
  query($endCursor: String) {
    viewer { repositories(first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes { name }
    }}
  }'
```

### Key flags

| Flag | Purpose |
|---|---|
| `-X, --method` | HTTP method (default GET; switches to POST if `-f`/`-F` present) |
| `-f, --raw-field k=v` | String parameter |
| `-F, --field k=v` | Typed parameter (auto-converts numbers, bools, `@file`) |
| `-H, --header k:v` | Custom HTTP header |
| `--input <file>` | Request body from file or stdin |
| `--paginate` | Fetch all pages |
| `--slurp` | Combine paginated results into one JSON array |
| `--cache <duration>` | Cache response (e.g., `1h`) |
| `-q, --jq` | Filter JSON response |
| `-t, --template` | Go template formatting |
| `--hostname` | Override GitHub host |
| `--verbose` | Full request/response debug output |

### Pitfalls

- **`-f`/`-F` silently switches to POST.** Adding any field parameter changes the HTTP method from GET to POST even without `--method`. Use `--method GET` explicitly when adding parameters to a read-only call.
- **`-f` sends strings; `-F` sends typed values.** This matters when an endpoint validates JSON types server-side. Canonical case: the sub-issues endpoint (`POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`) requires `sub_issue_id` as a JSON integer. `gh api -f sub_issue_id=123` URL-encodes it as a string and returns HTTP 422 `Invalid request — must be integer`; only `gh api -F sub_issue_id=123` (typed/raw) succeeds. Whenever a REST endpoint's payload schema specifies `integer`, `boolean`, or `null`, reach for `-F`, not `-f`. The failure mode for `-f` against typed fields is loud (422) when the call surfaces the error and silent when the call is best-effort and the error is discarded.
- **Placeholders resolve from git remote.** `{owner}`, `{repo}`, `{branch}` resolve from the current directory's git remote. They silently become empty if no remote is configured.
- **`--paginate` makes multiple API calls.** Can exhaust rate limits on large result sets. Always combine with `--slurp` when building a single JSON array.

## Authentication

### Methods

| Method | Use case |
|---|---|
| `gh auth login` (interactive) | Default — opens browser, stores token in OS credential store |
| `echo $TOKEN \| gh auth login --with-token` | Headless/scripted login |
| `GH_TOKEN` / `GITHUB_TOKEN` env var | CI and automation — overrides stored token |

### Scope management

Some operations require specific OAuth scopes:

| Operation | Required scope | How to add |
|---|---|---|
| `gh repo delete` | `delete_repo` | `gh auth refresh -s delete_repo` |
| `gh pr create --project` | `project` | `gh auth refresh -s project` |
| `gh secret set` | `admin:org` (org secrets) | `gh auth refresh -s admin:org` |

### Multi-account and enterprise

- `gh auth switch` toggles between logged-in accounts
- `--hostname <host>` targets GHES instances
- `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` for GHES auth in CI
- Can be authenticated to multiple hosts simultaneously

### Identity drift — `gh auth status` is not authoritative

`gh auth status` reads a config-file `active` flag. After a `gh auth switch` followed by a token refresh — or any session in which multiple accounts have been juggled — the flag and the *actual token sent on the wire* can disagree. Empirically observed in pi_config #217: `gh auth status` reported account A while `gh api /user --jq .login` returned account B in the same shell. The failure mode is silent: subsequent mutations land as account B and the operator never sees an error.

The authoritative answer to "who am I to GitHub right now?" is to ask GitHub:

```bash
gh api /user --jq .login
```

Before any mutating GitHub operation in a multi-account environment, verify the active account this way. The one-liner pattern:

```bash
test "$(gh api /user --jq .login)" = "$EXPECTED" || { echo "identity drift" >&2; exit 1; }
```

For non-pi consumers (setup scripts, hooks, CI shims), source the centralised helper instead of inlining the check:

```bash
. scripts/lib/gh-verify-user.sh
gh_verify_user "$EXPECTED" || exit 1
```

**Structural backstop:** inside a pi session the `gh-identity-guard` extension (`agent/extensions/gh-identity-guard/`, ADR-0022) intercepts mutating `gh`/`git push` calls and runs this probe automatically. The skill text above remains the source of truth for *why* the guard exists and is the fallback when the extension is disabled (`SKIP_GH_IDENTITY_GUARD=1`).

**No-expected-identity bootstrap (ADR-0025):** when neither identity source is configured, both guard halves fail closed — but with an operator present (a controlling terminal for the pre-push hook, `ctx.hasUI` for the extension) they first offer to create `<repo>/.pi/expected-identity`. The operator **re-types** the login; a suggestion is shown only when the active `gh api /user` login equals the remote owner and the remote is not a personal fork, and it is never auto-accepted. The file is written but the triggering operation still fails closed, so the operator commits the trust anchor and re-runs. Non-interactive contexts keep the original fail-closed behavior.

The structural enforcement layer — a tool-boundary extension that blocks mutating `gh` / `git push` invocations on drift — is tracked in pi_config #250.

## Environment Variables

| Variable | Purpose |
|---|---|
| `GH_TOKEN`, `GITHUB_TOKEN` | Auth token (overrides stored credentials) |
| `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | GHES auth token |
| `GH_HOST` | Override target GitHub hostname |
| `GH_REPO` | Set repo context as `[HOST/]OWNER/REPO` |
| `GH_CONFIG_DIR` | Override config file location |
| `GH_PROMPT_DISABLED` | Disable interactive prompts (scripting) |
| `GH_NO_UPDATE_NOTIFIER` | Suppress update notices |
| `GH_DEBUG` | Enable verbose stderr output |
| `GH_PAGER`, `PAGER` | Pager program |
| `GH_BROWSER`, `BROWSER` | Browser for `gh browse` |
| `GH_EDITOR`, `VISUAL`, `EDITOR` | Text editor preference |
| `GH_FORCE_TTY` | Force TTY output when piped |

## Extensions

Extensions are GitHub repositories named `gh-<name>` containing an executable. They extend `gh` with custom commands.

### Lifecycle

```bash
gh extension search <query>       # Search GitHub for extensions
gh extension browse               # Interactive TUI browser
gh extension install owner/repo   # Install
gh extension list                 # List installed
gh extension upgrade [--all]      # Upgrade
gh extension remove <name>        # Uninstall
```

### Notable extensions

| Extension | Status | Purpose |
|---|---|---|
| `gh copilot` | **Native command** (v2.86+) | Replaced deprecated `gh-copilot` extension |
| `gh-dash` | Active | TUI dashboard for PRs and issues |
| `gh-models` | Active | Interact with GitHub-hosted AI models |

Extensions cannot override core commands — use `gh extension exec <name>` if a conflict exists.

## Common Pitfalls

- **`gh api -f` switches method.** Adding `-f key=value` silently changes GET to POST. Always set `--method GET` explicitly for read-only calls with parameters.
- **`gh pr merge` uses repo default strategy.** Without `-m`, `-r`, or `-s`, the merge strategy depends on repository settings — behavior varies by repo.
- **`gh pr merge --delete-branch` deletes both local and remote.** Users sometimes only want remote deletion.
- **`gh pr checkout` modifies working tree.** Fails with uncommitted changes — not a pure API call.
- **`gh release delete` leaves the tag.** Without `--cleanup-tag`, the git tag remains. Next `gh release create` for that tag will fail.
- **`gh repo sync --force` overwrites diverged history.** Without `--force` it refuses to sync diverged branches.
- **`gh search` negation syntax.** Queries with `-qualifier:value` need `--` prefix on Unix to prevent shell flag interpretation: `gh search issues -- "repo:owner/repo -label:bug"`.
- **`--json` requires explicit field names.** No wildcard. Run with `--json` and no value to discover available fields.
- **Short flag collisions across commands.** `-f` means `--raw-field` in `gh api` but `--fill` in `gh pr create`. Context matters.
- **`gh run list -w` is case-sensitive.** Workflow name matching is case-sensitive; disabled workflows are excluded unless `-a` is also passed.
- **Exit codes:** 0 = success, 1 = failure, 2 = cancelled, 4 = auth required.

## Out of Scope

- **Git operations** (branching, merging, rebasing, commit management) — use `gitflow-expert`
- **Shell scripting patterns** (bash idioms, POSIX compatibility, process management) — use `shell-expert`
- **GitHub Actions YAML authoring** — the skill covers `gh run` and `gh workflow` for managing runs, not writing workflow files
