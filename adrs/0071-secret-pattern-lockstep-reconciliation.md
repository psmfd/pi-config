---
status: Accepted
date: 2026-07-04
---

# ADR-0071: reconcile the secret-detection pattern set across all three copies + enforce lockstep

**Status:** Accepted (amended by [ADR-0088](0088-cross-extension-import-boundary.md) — the TS lockstep copy moved from `expertise-client/lib/secret-scan.ts` to `shared/secret-scan.ts`; the three-copy lockstep model is unchanged)
**Date:** 2026-07-04
**Closes:** #499 (sync the pattern set with agent-framework-claude ADR-095).
**Related:** [ADR-0037](0037-secret-scanner-tooling-strategy.md) (the complementary gitleaks scanner), agent-framework-claude ADR-095 (the JWT + Authorization-Bearer detectors this adopts) and its ADR-053 (in-session-layer / lockstep-by-duplication precedent).

## Context and Problem Statement

pi_config carries the secret-detection pattern set in **three** independent copies
that are kept in lockstep by comment discipline (no shared source — the bash hook
installs standalone; the two TypeScript extensions are separate modules):

- `hooks/secrets-guard.sh` (pre-commit hook, combined `grep -E` string)
- `agent/extensions/secrets-guard/index.ts` (in-session guard)
- `agent/extensions/expertise-client/lib/secret-scan.ts` (create-body guard)

Two problems surfaced together (#499):

1. **The copies had silently drifted.** `secrets-guard/index.ts` and
   `hooks/secrets-guard.sh` lagged the canonical set on three axes:
   no `ENCRYPTED` PKCS#8 PEM form, the narrow `ghp_[…]{36}` instead of the
   five-prefix `gh[oprsu]_[…]{36,}`, and a fixed-length fine-grained PAT
   (`{82}` not `{82,}`). `expertise-client` had already advanced past them.
   Additionally, the bash PEM alternation used the empty-alternation form
   `(RSA |…|)PRIVATE KEY`, which BSD grep rejects (framework #201).
2. **The framework added two detectors** (its ADR-095): a signed-JWT shape and
   an `Authorization: Bearer <20+>` literal. None of pi_config's copies had them.
3. **Nothing enforced parity**, which is why the drift went unnoticed.

## Decision Outcome

**Reconcile all three copies to the framework's canonical set** and **add an
automated lockstep gate**.

The canonical set (six categories): `pem-private-key` (with `ENCRYPTED`,
optional-group form for BSD grep), `aws-access-key`, `github-token`
(`gh[oprsu]_[A-Za-z0-9]{36,}`), `github-pat-fine-grained`
(`github_pat_[A-Za-z0-9_]{82,}`), `signed-jwt`
(`eyJ…\.eyJ…\.…` three segments, signed tokens only), and `authorization-bearer`
(`[Aa]uthorization: [Bb]earer [A-Za-z0-9._~+/=-]{20,}`; the length bound skips
`%s`/`<key>`/`$VAR` placeholders).

**JWT segment upper bound (`{10,4000}`, hardening beyond the framework's
unbounded `{10,}`).** The signed-JWT shape chains three `{n,}` quantifiers each
followed by a literal `\.` the class excludes; a backtracking engine (V8, both
TS copies) does O(n²) work on adversarial ~512 KB non-dot input — a polynomial
availability risk for the guards, not classic exponential ReDoS. Bounding each
segment to `{10,4000}` caps it with no false-negative cost (real JWT segments are
far under 4000 chars). GNU grep's DFA (the bash copy) is linear regardless; the
bound is applied there too only to keep the three copies identical. This is a
deliberate, safer divergence from agent-framework-claude ADR-095's unbounded
form, filed upstream (agent-framework-claude#73) so the ecosystems re-converge.

`scripts/validate.sh` gains the secret-pattern lockstep gate: it asserts every
canonical fragment is present, verbatim (`grep -F`), in the **active
(non-comment) lines** of all three files. Comment lines are stripped first so a
stale-comment fragment cannot mask a regressed live pattern, and the fragments
are complete enough to encode each detector's invariant (the JWT fragment
carries all three segments and both literal dots; the bearer fragment carries the
`Authorization:` prefix). None matches its own detection regex, so listing them
in the validator is safe. This is the enforcement that was missing.

### Considered alternatives

- **Update only `expertise-client` (issue-literal scope).** Rejected: it ships
  the `pi-secrets-guard` mirror with a strictly weaker guard than expertise-client
  and leaves the drift + missing enforcement in place.
- **Extract a single shared pattern source.** Rejected for the same reason
  ADR-053 (framework) keeps them duplicated: the bash hook installs standalone
  outside any module system, so there is no shared-source seam. Lockstep-by-
  duplication stands; the new validate gate replaces comment-only discipline.

### Consequences

- **Positive:** all three guards detect the same set, including JWT/Bearer; the
  bash PEM form is now BSD-grep-safe; drift is caught mechanically at
  `validate.sh` time.
- **Neutral:** the set stays duplicated (by design). The gate keeps it honest.
- **Discipline:** committed content (tests, docs, this ADR) must avoid literal
  JWT/bearer tokens — tests assemble fixtures by concatenation, and the pattern
  text itself does not match its own regex.
