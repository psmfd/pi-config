# git-read — typed local Git inspection

First-party pi extension implementing the Git-side isolation required by #881 and ADR-0123. It registers `git_read`, a fixed-operation replacement for general-purpose `bash` in read-only Git specialists.

## Operations

| Operation | Fixed behavior |
|---|---|
| `status` | Short branch/status report |
| `log` | Bounded decorated graph |
| `diff` | Bounded diff or stat, optional validated revision/path |
| `show` | Commit/object display, stat by default |
| `branches` | List local and remote branches; no create/delete forms |
| `tags` | List tags with object and date; no create/delete forms |
| `remotes` | List remotes; no add/set/remove forms |
| `worktrees` | List worktrees; no add/move/remove forms |
| `reflog` | Bounded reflog display; no expire/delete forms |

The tool never accepts arbitrary subcommands or flags. Revisions and repository-relative paths are validated, paths follow an explicit `--` separator, and all commands include hardened config arguments plus `--no-optional-locks`.

## Assurance boundary

`git_read` executes `spawn("git", argv, { shell: false })` with a package-owned argv vector. Its child environment deliberately excludes GitHub tokens, `SSH_AUTH_SOCK`, credential helpers supplied through environment variables, and terminal prompting. It therefore cannot fetch, push, sign, create/delete refs, modify worktrees, or run hooks through its exposed operations.

Repository output is returned as untrusted data, stripped of control sequences, with a 1 MiB process ceiling, 10-second timeout, and 50 KiB model-visible cap.

## Refusal policy (per-rule)

| Rule | Classification | Behavior |
|---|---|---|
| Unknown operation or arbitrary flag | Hard refusal | Schema/operation switch rejects before spawn |
| Invalid revision or unsafe path | Hard refusal | Reject option prefixes, controls, absolute/traversal paths |
| Timeout, cancellation, or output overflow | Hard refusal | Terminate child and return an error |
| Git command non-zero exit | Hard refusal | Return only a bounded diagnostic |
| Model output over 50 KiB | Continue-eligible | Truncate with explicit metadata |

No override exists; callers needing mutations must route them to the orchestrator or appropriate interactive specialist.

## Tests

`./scripts/test-github-read.sh` runs both GitHub and Git read suites without network access. Tests pin every operation's fixed read-only form, hostile revision/path handling, credential removal, tool registration, and output bounds.
