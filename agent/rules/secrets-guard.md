---
description: Specification for a pre-commit secrets guard — patterns to block, override mechanisms, and skip conditions
---

# Secrets Guard

This rule is the **specification** for the secrets guard. The implementation is delivered in two layers: the pi extension under `agent/extensions/secrets-guard/` (in-session, blocks before a write reaches disk) and the git pre-commit hook `hooks/secrets-guard.sh` that `setup.sh` installs (both originally Phase C of [ADR-0001](../../adrs/0001-subagent-orchestration-substrate.md), delivered via #12; pattern reconciliation in ADR-0111/#796). Pre-commit prevention is significantly cheaper than post-push detection — once a secret reaches a remote, rotation is the only remediation.

## What the guard blocks

The guard scans every staged file (via `git diff --cached --name-only --diff-filter=ACM`), skips binary files (detected via `git diff --numstat`), and caps each scan at 512 KB. It then applies these checks:

- **Vault-naming pattern + missing header** — files whose basename contains `vault` and ends `.yml`/`.yaml` (`**/*vault*.yml`, `**/*vault*.yaml` — 'vault' anywhere in the basename, ADR-0111), plus `**/host_vars/*/vault*` and `**/group_vars/*/vault*`, whose first line does not match `^\$ANSIBLE_VAULT;[0-9]+\.[0-9]+;[A-Z0-9]+` (covers vault format 1.1 and 1.2 with vault IDs)
- **PEM private-key headers** — `-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED |)PRIVATE KEY` (the `ENCRYPTED` alternative covers PKCS#8, RFC 5958)
- **AWS access key IDs** — `AKIA|ASIA|ABIA|ACCA` followed by 16 uppercase alphanumerics
- **GitHub tokens** — `gh[oprsu]_[A-Za-z0-9]{36,}` (all five documented prefixes, open-ended body) and `github_pat_[A-Za-z0-9_]{82,}` (fine-grained PAT)
- **Signed JWTs** — three dot-separated base64url segments, header and payload both starting `eyJ` (ADR-095/#64; unsigned/alg:none deliberately out of scope)
- **`Authorization: Bearer` literals** — 20+ contiguous token characters after the scheme (format placeholders like `%s`/`$VAR` never reach the bound)
- **Sensitive file basenames** — `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, the FIDO2 hardware-backed `id_ecdsa_sk`/`id_ed25519_sk` (OpenSSH 8.2+; ADR-0111), plus `.pem` variants; also any `*.pem` or `*.key` file outside skip patterns

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
2. **Pi extension `tool_call` handler** — one handler branching on `toolName` (`write`/`edit`/`artifact_review` content scans; `bash` command scans), plus a `session_start` handler that announces the `SKIP_SECRETS_GUARD=1` bypass. Same patterns applied to model-driven writes and bash invocations, blocking before the write reaches disk. Scoped at the session level.

Both layers must agree on patterns, overrides, and skip rules. The pattern copies are deliberate lockstep duplicates (ADR-0071/0088 — the extension must stay import-free for standalone mirroring); `validate.sh` gates parity of the six content patterns across all three copies (§6b-bis) and of the vault-naming/sensitive-basename set across the two enforcement layers (§6b-ter, ADR-0111).

## When this rule applies

- Commits in this repo (`pi_config`) — `setup.sh` installs the hook
- Pi sessions running anywhere — the extension is global
- Any other repo that opts in by symlinking the hook script

## When this rule does not apply

- Repos that have not opted into the git hook AND where pi is not the agent making the commit
- Files that match the skip patterns above
