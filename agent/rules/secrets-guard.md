---
description: Specification for a pre-commit secrets guard — patterns to block, override mechanisms, and skip conditions
---

# Secrets Guard

This rule is the **specification** for a pre-commit secrets guard. The implementation lives in a pi extension under `agent/extensions/secrets-guard/` (Phase C of [ADR-0001](../../adrs/0001-subagent-orchestration-substrate.md), tracked in #12) plus an installable git pre-commit hook script. Pre-commit prevention is significantly cheaper than post-push detection — once a secret reaches a remote, rotation is the only remediation.

## What the guard blocks

The guard scans every staged file (via `git diff --cached --name-only --diff-filter=ACM`), skips binary files (detected via `git diff --numstat`), and caps each scan at 512 KB. It then applies these checks:

- **Vault-naming pattern + missing header** — files matching `**/vault*.yml`, `**/vault*.yaml`, `**/host_vars/*/vault*`, `**/group_vars/*/vault*` whose first line does not match `^\$ANSIBLE_VAULT;[0-9]+\.[0-9]+;[A-Z0-9]+` (covers vault format 1.1 and 1.2 with vault IDs)
- **PEM private-key headers** — `-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |)PRIVATE KEY`
- **AWS access key IDs** — `AKIA|ASIA|ABIA|ACCA` followed by 16 uppercase alphanumerics
- **GitHub personal access tokens** — `ghp_[A-Za-z0-9]{36}` and `github_pat_[A-Za-z0-9_]{82}`
- **Azure DevOps PATs** — 52-character base32-like tokens in `AZURE_DEVOPS_*` env-var contexts (heuristic, low-confidence)
- **Sensitive file basenames** — `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` (plus `.pem` variants); also any `*.pem` or `*.key` file outside skip patterns

The guard does NOT detect inline `!vault |` scalars in partially-encrypted YAML files — that gap requires semantic YAML parsing and is out of scope.

## Override mechanisms

Use the lowest-blast-radius override that fits the situation:

| Override | Scope | Visibility |
|---|---|---|
| `SKIP_SECRETS_GUARD=1 git commit ...` | One-shot | Visible in shell history; auditable |
| `.secrets-guard-allowlist` at repo root | Persistent (per-path glob) | Version-controlled; visible in PR review |
| `git commit --no-verify` | One-shot, all hooks | Reserved for emergencies; document in commit body |

The allowlist file accepts one path glob per line. Lines starting with `#` and blank lines are ignored. Use it for known false positives such as `tests/fixtures/fake_key.pem` — never to suppress a real finding.

## Skip patterns (the guard does not scan)

- Files matching `*.example`, `*.sample`, `*.template`, `*.j2`
- Paths under `molecule/`, `tests/`, `spec/`, `fixtures/`
- Binary files (detected via `git diff --numstat`)
- Files staged for deletion (excluded by `--diff-filter=ACM`)

## Two layers of enforcement

1. **Git pre-commit hook** — a `hooks/secrets-guard.sh` (delivered by Phase C) that `setup.sh` symlinks into `.git/hooks/pre-commit` for opt-in repos. Runs on every `git commit` regardless of pi.
2. **Pi extension `tool_call_start` and `bash spawnHook`** — same patterns applied to model-driven file writes and bash invocations during a pi session, blocking before the write reaches disk. Scoped at the session level.

Both layers must agree on patterns, overrides, and skip rules. The extension reads its pattern set from a shared source so the two stay in sync.

## When this rule applies

- Commits in this repo (`pi_config`) once Phase C lands and `setup.sh` installs the hook
- Pi sessions running anywhere — the extension is global
- Any other repo that opts in by symlinking the hook script

## When this rule does not apply

- Repos that have not opted into the git hook AND where pi is not the agent making the commit
- Files that match the skip patterns above
