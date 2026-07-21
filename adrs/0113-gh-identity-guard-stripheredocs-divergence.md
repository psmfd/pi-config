---
status: Accepted
date: 2026-07-20
---

# ADR-0113: gh-identity-guard keeps its own stripHeredocs — a deliberate divergence from shared/shell-lex.ts

**Status:** Accepted
**Date:** 2026-07-20
**Related:** [ADR-0065](0065-inline-shared-modules-for-coupled-extension-mirrors.md) (the shared/ import + mirror-inline mechanism a migration would have used), [ADR-0088](0088-cross-extension-import-boundary.md) (deliberate-duplicate policy this decision applies), [ADR-0072](0072-guardfall-shell-injection-hardening.md) (shared/shell-lex.ts origin), pi_config #789 (the migration issue this resolves), #801 (the review that surfaced the incompatibility)

## Context and Problem Statement

The #788 shared/ review filed #789 to migrate
`gh-identity-guard/lib/classifier.ts`'s local `stripHeredocs` onto
`shared/shell-lex.ts`'s exported primitive — the exact sibling-guard
duplication shell-lex's module header says it exists to prevent. #789
deferred the migration to gh-identity-guard's own review (epic #780 item 8,
issue #801) because the classifier copy carries documented CRITICAL-bypass
fixes that had to be shown equivalent before the local copy could be deleted.

The #801 review adversarially verified the two implementations and found
they are **not** equivalent — and cannot be, because they serve different
downstream models:

- `shared/shell-lex.ts:stripHeredocs` **keeps** the `<<DELIM` operator on
  the introducing line. It is designed to be paired with the module's own
  `lex()`, which treats `<` as a redirect operator and flags a
  heredoc-reading interpreter via the stdin-redirect check.
- `classifier.ts:stripHeredocs` **excises** the `<<DELIM` operator from the
  introducing line, because gh-identity-guard's `tokenize` /
  `splitSegments` / `parseGitPush` are argv-position matchers with no `<`
  awareness.

Concretely, for the valid-bash input `git<<EOF push origin main` (a `<`
breaks a word with no preceding whitespace):

- Current classifier → `git push origin main` → argv `["git","push",…]` →
  `mutating = true` (correct).
- Naive swap to shared's primitive (keeping the classifier's own
  tokenizer) → `git<<EOF push origin main` unmodified → `git<<EOF` glues as
  argv[0] → `argv0 === "git"` fails → **misclassified non-mutating (a live
  git-push identity bypass)**.
- Full shared `lex()` pipeline → argv `["git","EOF","push",…]` →
  `parseGitPush` finds `"EOF" !== "push"` → returns null → **also
  misclassified non-mutating**.

## Considered Options

1. **Migrate to shared, adapting first.** Either add an operator-excising
   `stripHeredocs` variant to shared, or rewrite the classifier off its own
   `tokenize`/`splitSegments`/`parseGitPush` onto shared's `Segment` model.
2. **Keep the local copy and document the divergence** as a deliberate
   duplicate under ADR-0088, with a locking regression test.
3. Migrate naively (delete the local copy, import shared). Rejected outright
   — the review proved this reopens a git-push bypass.

## Decision Outcome

**Option 2 — keep gh-identity-guard's own `stripHeredocs`; document the
divergence in both files; do not migrate.**

Option 1's sub-variants both cost more than the duplication they remove.
Adding a second, operator-excising heredoc function to shared that only
gh-identity-guard uses trades one duplicate for a shared module with two
near-identical primitives and a footgun (a future consumer picking the
wrong one). Rewriting the classifier's 700-line argv-position engine onto
the `Segment` model is a large, security-critical refactor disproportionate
to a review-driven cleanup, with its own regression risk on a guard that
already works. The duplication is small (one well-tested function), the
contracts genuinely differ, and ADR-0088 already sanctions deliberate
duplicates where independence is the point.

Concretely:

1. `classifier.ts:stripHeredocs` gains a doc-comment explaining why it
   excises the operator and must not import shared's; it cross-references
   shared, ADR-0088, and this ADR.
2. `shared/shell-lex.ts:stripHeredocs` gains the reciprocal note: it keeps
   the operator for `lex()` downstream, and argv-position consumers must
   not use it directly.
3. A regression test (`git<<EOF push origin main` → mutating) locks the
   classifier's current-correct behavior so the divergence cannot silently
   regress.
4. #789 is closed as resolved-by-documentation — its own scope explicitly
   permitted this outcome ("if the two genuinely need different semantics,
   document why in both files instead").

### Consequences

- Good: no bypass introduced; the classifier's hardened behavior is now
  test-locked; a future maintainer reading either `stripHeredocs` learns
  immediately why the duplication is intentional.
- Good: the `pi-gh-identity-guard` mirror target stays `inline: []` — no
  shared-module coupling to maintain for this extension.
- Neutral: the small duplication persists by design; `GIT_HARDENING` (a
  separate #801 finding) was still deduped *within* the extension into
  `lib/git-hardening.ts`, because those three copies had one contract, not
  two.
- Accepted gap (unchanged): both `stripHeredocs` copies remain pragmatic
  string transforms, not POSIX parsers; adversarial obfuscation is out of
  scope per ADR-0022 / ADR-0072, now documented in the README threat model.
