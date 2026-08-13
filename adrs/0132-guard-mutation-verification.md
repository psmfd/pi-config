---
status: Accepted
date: 2026-08-11
---

# ADR-0132: security-guard regression tests are verified by mutation

**Status:** Accepted — the operator approved the harness on 2026-08-11 (#931).

## Context and Problem Statement

The #916 review round found both of its Error-severity defects in `index.ts`,
the one module with no test coverage at the time. The lesson recorded then was
narrower than it should have been: the gap was not merely *untested code*, it
was that **a passing test proves nothing about a guard it does not actually
exercise**. A regression test that stays green when its guard is deleted is
worse than no test, because it converts an unguarded boundary into one that
reports as guarded.

Nothing in this repo distinguished the two. Every suite asserted behaviour on
correct code; none demonstrated that it would fail on incorrect code. The
distinction is not academic — writing #931's TOCTOU suites surfaced two live
instances:

- The 657-line `approve-flow.test.ts` passed **with the display-to-commit
  digest comparison disabled**. The guard was real, the coverage was assumed,
  and the assumption was wrong until it was measured.
- Making the dispatch authority-lock callback `async` and inserting an `await`
  inside the protected span — the exact change that silently widens the
  verify-then-exec window ADR-0131 Decision 9 bounds — left **every one of the
  20 behavioural test files green**.

The second case also shows why the problem cannot be solved by writing more
behavioural tests: a widened window changes no output. Some security properties
are only checkable structurally, and structural assertions are precisely the
ones most likely to be quietly satisfied by a test that never runs the branch
it claims to protect.

## Considered Options

1. **Convention only.** Require authors to hand-verify each guard test against
   a reverted fix and note it in the PR body. Rejected: this is what #931
   already asked for, and a convention that produces no artifact cannot be
   re-checked. It decays silently on the first refactor, which is exactly when
   it matters.

2. **A general mutation-testing tool** (Stryker or similar). Rejected for now:
   these mutate broadly and score a percentage, optimising for aggregate
   coverage rather than for *named security properties*. The output — a
   mutation score — is not the question being asked. The question is "does the
   test that claims to guard property X fail when X is removed," and a
   percentage cannot answer it. They are also a substantial dependency for a
   repo whose extension deps are exact-pinned and hydrated from a cache.

3. **A registry of hand-authored mutations, each paired with the test(s) it
   must break.** Chosen.

## Decision Outcome

`scripts/verify-guard-mutations.sh` reads `scripts/guard-mutations.json`. Each
entry names a guard, the surgical edit(s) that disable it, the suite to run,
and the **specific test names** that must then fail. The harness applies the
edits, runs the suite, asserts those named tests are among the failures, and
restores the file.

Four properties make it evidence rather than ceremony:

- **The named tests are checked, not just a non-zero exit.** A mutation that
  breaks the build would otherwise satisfy the harness while proving nothing —
  the suite would have failed for the wrong reason. This is a real failure mode,
  not a hypothetical: the natural way to disable a guard is to delete it, and
  deleting an `if` condition usually does not compile.
- **Drift is an error, never a skip.** An anchor that no longer matches (or
  matches more than once) fails the run. Silently skipping a drifted mutation is
  how a harness like this rots into a green rubber stamp — the same failure
  class it exists to prevent, one level up.
- **It refuses to run on a dirty target.** The harness edits tracked files in
  place and restores them with `git checkout --`; running against uncommitted
  work would discard it.
- **The harness itself is tested.** `tests/guard-mutations/run-tests.sh` drives
  three fixture manifests that each must be rejected (drifted anchor,
  undetected guard, build-breaking mutation) plus the dirty-tree refusal, and
  asserts the tree is pristine afterwards. An unverified verifier would be the
  original problem restated.

The manifest is **repo-level** so any boundary can register without relocating
anything. It is deliberately registered today only for the #931 active-grant
boundary: the shape is general, the coverage is not, and claiming otherwise
would overstate what has been verified.

Both the harness and its self-tests are wired into `validate.sh` as required
checks. The cost is roughly one suite run per registered mutation (~4s each for
the broker suite), which is affordable precisely because the registry is small
and curated rather than exhaustive.

### Consequences

- A guard test that stops exercising its guard now fails CI instead of passing
  quietly. This is the entire point, and it will occasionally fire on a
  legitimate refactor that moves an anchor — that is the intended cost, and the
  fix (update the manifest) forces a re-read of the guard.
- Adding a guard without registering a mutation is still possible, and the
  harness cannot detect the omission. Registration is a review-time obligation,
  not a mechanical one. Making it mechanical would require enumerating "what is
  a security guard," which is not a decidable property.
- The registry is a maintenance surface: each entry couples to source anchors
  and to test names. Both are checked mechanically, so the coupling fails loudly
  rather than silently.
- Structural assertions (source-reading tests such as `toctou.test.ts`) become
  first-class: they are the only expressible form for properties like "no
  `await` in this span," and this harness is what proves they work.

## Related

- ADR-0131 Decision 9 — the verify-then-exec residual these mutations pin
- ADR-0128, ADR-0129 — the review-draft and active-grant contracts under test
- #916 — the review round whose lesson this encodes
- #931 — the adversarial conformance suite for the active-grant boundary
