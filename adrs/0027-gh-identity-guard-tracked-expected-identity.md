---
status: Accepted
date: 2026-06-07
---

# ADR-0027: `gh-identity-guard` only trusts git-tracked `.pi/expected-identity`

**Status:** Accepted
**Date:** 2026-06-07
**Related:** [ADR-0022](0022-gh-identity-guard-extension.md) (original guard design), [ADR-0025](0025-gh-identity-guard-interactive-bootstrap.md) (bootstrap write path), #306

## Context and Problem Statement

ADR-0022 chose `<repo>/.pi/expected-identity` as the primary source of truth because it is a repository trust anchor: changing who may write to a repo through pi should be visible in review and history. ADR-0025 later added an interactive bootstrap path that writes the file for a fresh clone, but deliberately left the read path unchanged and deferred the stronger tracked-file gate to #306.

That unchanged read path meant a local-only `.pi/expected-identity` became authoritative as soon as it existed on disk. A created-but-uncommitted file bypassed the PR-review control the threat model relies on. The bootstrap still failed the triggering push, but a subsequent operation could trust the untracked file.

## Considered Options

- **A. Keep trusting any on-disk `.pi/expected-identity`.** Rejected. It preserves compatibility for local-only pins, but contradicts the code-review-artifact rationale in ADR-0022 and leaves #306's security-review finding unresolved.
- **B. Trust only files tracked in Git's index (`git ls-files --error-unmatch -- .pi/expected-identity`).** Chosen. This is the least-disruptive interpretation of “git-tracked”: it blocks untracked local policy while preserving normal first-add/bootstrap workflows.
- **C. Trust only the version committed in `HEAD`.** Rejected for now. It is stronger, but would ignore staged first-add pins and worktree edits to an already-tracked pin until commit. That is a larger behavior change than #306 requires.
- **D. Add an opt-in compatibility flag for untracked local pins.** Rejected. It would preserve the exact local-only authority this ADR removes.

## Decision Outcome

Both guard halves now treat `<repo>/.pi/expected-identity` as authoritative only when Git reports the path as tracked:

```bash
git ls-files --error-unmatch -- .pi/expected-identity
```

If the file exists but is untracked, the guard ignores it, warns the operator, and falls through to the user-layer fallback (`~/.pi/agent/settings.json`). If no trusted source remains, the operation fails closed. If Git tracking cannot be verified from the extension, the extension also ignores the file and fails closed unless the user-layer fallback resolves.

This ADR defines “tracked” as **tracked in the index**, not necessarily already present in `HEAD`. A newly bootstrapped file must be `git add`ed before either guard half will treat it as policy. The existing bootstrap guidance already tells the operator to `git add .pi/expected-identity` and commit before rerunning.

### Scope

- `hooks/gh-identity-guard.sh` gates per-repo reads through `git ls-files`.
- `agent/extensions/gh-identity-guard/lib/identity.ts` gates per-repo reads through an argv-based Git subprocess with the same hardening flags used for remote resolution.
- Tests cover tracked, untracked, fallback, and tracking-indeterminate behavior.

### Non-scope

- No `HEAD`-only semantics in this ADR.
- No compatibility flag for untracked pins.
- No change to the user-layer fallback. `~/.pi/agent/settings.json` remains trusted as operator-local configuration.

## Consequences

- A local-only `.pi/expected-identity` can no longer silently authorize writes.
- Fresh-clone bootstrap remains ergonomic: create the file interactively, `git add` it, commit it, then rerun the operation.
- Operators who intentionally kept uncommitted local pins must either commit the policy or move the local exception to the user-layer fallback.
- The check is not a cryptographic integrity proof. It enforces review-surface membership: the file is in Git's index and therefore visible to normal Git review flows.

## Verification

- `./scripts/test-gh-identity-hook.sh` covers untracked hook pins being ignored and user-layer fallback still working.
- `./scripts/test-gh-identity-guard.sh` covers extension identity resolution and UI warning behavior.
- `./scripts/typecheck-extensions.sh` and `./scripts/lint-extensions.sh` cover the TypeScript implementation.
