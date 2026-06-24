---
status: Accepted
date: 2026-05-29
---

# ADR-0023: `gh-identity-guard` — host-scope the in-session `git push` classification

**Status:** Accepted
**Date:** 2026-05-29
**Tracking issue:** [#265](https://github.com/TheSemicolon/pi_config/issues/265)
**Supersedes (in part):** [ADR-0022 § Q2.C](0022-gh-identity-guard-extension.md#considered-options) (`git push` blanket match) and the SSH-asymmetry note in its Threat Model.
**Related:** [ADR-0022](0022-gh-identity-guard-extension.md) (the guard's design), [ADR-0019](0019-compaction-optimizer-extension.md) (project-layer-untrusted trust boundary)

## Context and Problem Statement

ADR-0022 § Q2.C defined the `git push` matcher as a **blanket**: any `git push` is treated as an identity-tied mutation, and the in-session extension (`agent/extensions/gh-identity-guard/`) demands a configured GitHub identity before allowing it. The pre-push hook (`hooks/gh-identity-guard.sh`) — added later — correctly scopes to `github.com` only, because git's pre-push contract hands it the resolved remote URL as an argument.

The two layers diverged. The in-session layer never resolved the remote, so it blocked `git push origin dev` in an **Azure DevOps** repo (remote `git@ssh.dev.azure.com:v3/...`), demanding a `github.com` identity that is irrelevant to the push (#265). This contradicts the guard's own documented scope ("github.com remotes only; ADO/GitLab/Bitbucket/self-hosted pushes pass through") and forces operators into spurious overrides or `.pi/expected-identity` files in non-GitHub repos.

The guard's security property is narrow and must be preserved: **a wrong-identity push to a `github.com` repo must be blocked.** Relaxing the blanket introduces a new *allow* path (non-`github.com` → pass through), and that path must not become a bypass for a real `github.com` push.

## Considered Options

- **A. Leave the blanket; document the override.** Operators set `SKIP_GH_IDENTITY_GUARD` or an allowlist per ADO repo. Rejected: pushes friction onto every non-GitHub repo, encourages disabling the guard, and contradicts the documented scope.
- **B. String-match the remote host from the command.** Parse `git push <remote>` and compare. Rejected alone: the command string is not the effective target — named remotes need resolution, and `insteadOf`/`pushInsteadOf` rewrites change the real URL (ADR-0022 § Q1.E already rejected remote-URL parsing as a *source of truth* for exactly this reason).
- **C. Resolve the effective push host at the tool boundary, fail closed.** Run git to resolve the post-rewrite push URL(s), classify the host, and gate `github.com`/indeterminate while passing positively-confirmed non-`github.com`. **Chosen.**

## Decision Outcome

Host-scope the in-session `git push` classification (option C). The classifier continues to flag every `git push` as a candidate (it only sees the string), but now returns the parsed push invocation(s) and an `unconditional` discriminant; `index.ts` resolves the effective host before gating.

### Resolution algorithm (per `git push` invocation)

1. **Inline rewrite → fail closed.** If the command carries an inline `-c url.*.(push)insteadOf=` flag (direction-agnostic), the effective URL is rewritten in a way an out-of-band subprocess cannot observe → `indeterminate` (gate).
2. **Effective working directory.** Each `-C <dir>` chains against `ctx.cwd` (git applies them sequentially); all resolution git commands run there via `git -C <dir>`. The pi extension process cwd is not assumed to equal `ctx.cwd`.
3. **Candidate URLs.** If the `<repository>` arg is an explicit URL, use it directly. If it is a named remote (or omitted), resolve: omitted → `git rev-parse --abbrev-ref @{push}` → remote name; then `git remote get-url --push --all <remote>` — `--all` because a remote may have multiple `pushurl` entries and git pushes to all of them; `get-url --push` applies both `insteadOf` and `pushInsteadOf`.
4. **Host classification.** Extract the host (mirroring the pre-push hook's `extract_host`: strip scheme, authority after the last `@`, strip `:port`/trailing `.`, lowercase) and compare **exactly** to `github.com` (never substring). For an SSH-form URL whose host ≠ `github.com`, resolve `ssh -G <host>` and re-check the canonical `HostName` — closing the `~/.ssh/config` `Host alias → HostName github.com` bypass.
5. **Verdict.** `github` or `indeterminate` → gate (proceed to the identity check). Positively-confirmed `non-github` → pass through. For a compound command, gate if **any** push is `github`/`indeterminate`; pass only when **every** push is `non-github`.

The scope check runs on **both** the standard path and the `GH_IDENTITY_OVERRIDE` path. `gh` mutations and bypass-DENY-net shapes are `unconditional` — they never host-scope (a `gh` call is inherently `github.com`; a push hidden inside `bash -c`/`eval`/`$(...)` cannot be resolved → gate).

### Fail posture and security hardening

- **Fail closed** is the invariant: every indeterminate state (detached HEAD, no upstream, subprocess error, `ssh -G` failure, inline `-c …insteadOf=` rewrite, `--git-dir`/`--work-tree` override, empty/ambiguous resolution) gates. The ADR-0022 cost model holds — a false block costs one `gh auth switch`/override; a false allow is a wrong-account push. In particular, `git --git-dir=<other> push` targets a repo whose config differs from `cwd`; a `cwd`-based resolution could misclassify it (and could even mask a wrong-identity `github.com` push when `cwd`'s same-named remote is non-github), so any such command is gated regardless of the resolved host.
- Resolution git subprocesses run with `-c core.fsmonitor= -c core.hooksPath=/dev/null` so a hostile working directory's config cannot execute code when the guard merely resolves a remote (CVE-2026-45033 class; security-review #265).

### Accepted gaps

- **GHES.** GitHub Enterprise Server uses operator-defined hostnames; exact `github.com` does not gate them, and the probe targets `github.com`. Per-host GHES identity verification (reading `~/.config/gh/hosts.yml`, per-host probes) is a separate feature, deferred.
- **IDN / homograph hosts** are not Unicode-normalised (a look-alike that actually resolves to github.com would require attacker-controlled DNS — out of model).
- **`GIT_CONFIG_*`-env rewrites** that repoint a `github.com` remote *away* from github.com are an integrity concern downstream of the guard, not a wrong-identity bypass. The inverse (env rewrite pointing at github.com) is reflected by `get-url --push` because the subprocess inherits the same environment, so it gates correctly.
- **Per-command inline `SKIP_GH_IDENTITY_GUARD=1`** (inside a running session) is not honored — the env var is read once at extension load. Documented in the README; per-command inline-skip support tracked as a follow-up.

## Consequences

- **Positive:** the two layers now share one scope; ADO/GitLab/self-hosted pushes work in-session without overrides; the SSH-alias bypass is closed; resolution is hardened against hostile-repo config execution.
- **Negative:** each in-session `github.com`-candidate push incurs 1–3 extra short-lived git subprocesses (and one `ssh -G` for SSH-form non-github hosts) before the existing identity probe. Bounded and only on mutating pushes.
- **Testing:** `lib/remote.ts` is unit-tested for host extraction, alias resolution, and fail-closed paths; `index.ts` tests cover github→gate, ADO(https/ssh)→pass, alias→gate, no-upstream→gate, explicit-URL, `-C` dir, inline-rewrite, and compound pushes.
