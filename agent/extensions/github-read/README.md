# github-read — typed read-only GitHub inspection

First-party pi extension implementing ADR-0123 and epic #875. It registers a small loader, `github_read`, plus dynamically activated domain tools for repository, issue, pull-request, Actions, Projects v2, security-alert, and notification inspection.

## Assurance boundary

Every operation executed **through this extension** is mechanically read-only:

- callers select a typed operation, never a CLI command, flag, HTTP method, endpoint, jq expression, or GraphQL document;
- package-owned operation builders emit fixed `gh` argv shapes;
- a second allowlist assertion rejects unknown command prefixes, mutation methods, body flags, and mutation verbs;
- `spawn("gh", argv, { shell: false })` executes the reviewed vector;
- REST operations explicitly use `GET`; Projects operations use fixed read-only `gh project` subcommands.

This is a tool boundary, not a process sandbox. An agent granted another general-purpose network or shell tool has that separate capability. The `gitflow-expert` integration closes that gap by replacing `bash` with the companion `git_read` tool (issue #881).

## Tools

| Tool | Operations | Default |
|---|---|---|
| `github_read` | Activates one or more domains | Active when selected by the parent/wrapper |
| `github_repo_read` | `view`, `branches`, `commits`, `tags`, `releases`, `rulesets` | Loader-activated |
| `github_issue_read` | `list`, `view`, `timeline`, `labels`, `milestones`, `assignees` | Loader-activated |
| `github_pr_read` | `list`, `view`, `files`, `diff`, `reviews`, `comments`, `checks` | Loader-activated |
| `github_actions_read` | `workflows`, `runs`, `run`, `jobs`, `artifacts`, `checks` | Loader-activated; metadata only |
| `github_project_read` | `list`, `view`, `fields`, `items` | Loader-activated |
| `github_security_read` | `code_scanning`, `dependabot`, `secret_scanning` | User-layer opt-in |
| `github_notification_read` | `list`, `thread` | User-layer opt-in |

The loader changes the active tool set additively and never grants itself to a wrapper that omitted `github_read`.

## Sensitive-domain opt-in

Security alerts and notifications are disabled unless the operator enables them in user-layer `~/.pi/agent/settings.json`:

```json
{
  "extensionSettings": {
    "githubRead": {
      "security": true,
      "notifications": true
    }
  }
}
```

Project-local settings cannot enable these domains. Notifications may expose cross-repository private metadata; security operations may require separately granted token permissions. Authentication is not authorization—GitHub remains the source of truth and permission failures are surfaced without credentials.

## Authentication and identity

The runner uses the existing `gh` authentication stack. It never requests or returns a token and never invokes `gh auth token`. Before every operation it probes `gh api /user --jq .login`, validates the login, and reports:

- identity observed immediately before the request;
- fixed host (`github.com`);
- auth source name (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh-config`), never its value.

The probe is observability, not cryptographic binding: an out-of-band auth switch can still occur between the probe and operation subprocesses. Read operations intentionally do not require `.pi/expected-identity` matching.

The subprocess environment retains only PATH/HOME/XDG auth discovery, GitHub token variables, and proxy variables. It fixes `GH_HOST=github.com`, disables prompting, pagers, colors, and TTY behavior, and excludes unrelated credentials and `GH_REPO`.

## Output and trust policy

All GitHub-originated text is untrusted data. Tool results use a JSON envelope containing `UNTRUSTED_GITHUB_CONTENT`; content is never injected as a system message.

Controls:

- explicit response-field projection per operation;
- sensitive-key omission and a final token-pattern redaction pass;
- issue/PR bodies and comments are opt-in via `includeBody`;
- result limit defaults to 30 and is capped at 100 (50 for sensitive/account-wide domains);
- callers request one bounded page at a time—no `--paginate` or automatic recursion;
- stdout hard cap 1 MiB, stderr cap 64 KiB, default timeout 15 seconds;
- model-visible output cap 50 KiB; oversized results return valid JSON with truncation metadata;
- raw stderr and raw API responses are never returned.

## Actions exclusions

The baseline is metadata-only. It reads workflows, runs, jobs, step status, conclusions, checks, and artifact metadata. It does **not** download logs, artifacts, caches, or archives. Bounded log/artifact download design is tracked in #882.

## Refusal policy (per-rule)

| Rule | Classification | Behavior |
|---|---|---|
| Unknown operation or command prefix | Hard refusal | Throw before identity/network execution |
| Caller-supplied mutation method/body flag | Hard refusal | Schema has no such field; argv assertion rejects any generated occurrence |
| Invalid repository/ref/number/path/control byte | Hard refusal | Validation error before spawn |
| Sensitive domain without user opt-in | Hard refusal | Loader and direct domain execution both reject |
| Identity probe/auth failure | Hard refusal | No operation runs |
| Timeout, cancellation, output overflow, malformed JSON | Hard refusal | Child is terminated; bounded diagnostic only |
| GitHub permission denial/rate limit | Hard refusal | No automatic retry; sanitized diagnostic |
| Model-visible result over 50 KiB | Continue-eligible | Return valid truncation envelope; caller may narrow the query |

There are no skip variables or repository allowlist overrides.

## Tests

```bash
./scripts/test-github-read.sh
./scripts/typecheck-extensions.sh
./scripts/lint-extensions.sh
./scripts/validate.sh
```

Required tests use fake `gh` executables and fixtures; they do not access GitHub. Coverage includes catalog-wide mutation invariants, argv injection, opt-in gating, identity failures, timeouts, token redaction, field projection, bounded output, and dynamic activation.
