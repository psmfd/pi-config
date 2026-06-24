---
status: Accepted
date: 2026-06-23
---

# ADR-0046: migrate psmfd/pi `main` to a ruleset with an Admin bypass + detective guard

**Status:** Accepted
**Date:** 2026-06-23
**Related:** [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) (build-and-attest trust boundary `main` feeds), [ADR-0039](0039-mirror-sync-cadence-and-provenance.md) (the trusted `sync/upstream-*` bypass on the preventive guard), `psmfd/pi` `.psmfd/security-baseline.md` (mirror-side record)

## Context and Problem Statement

`psmfd/pi`'s `main` was governed by **classic branch protection** (require PR,
required check `enforce overlay path allowlist`, block force-push, block
deletion) with `enforce_admins` enabled — so the solo maintainer, an admin,
could not force-push `main`. The maintainer needs force-push as an operational
escape hatch while solo, but wants the standard PR-based process to apply
automatically to collaborators added later.

Classic protection offers only an all-or-nothing `enforce_admins` toggle; turning
it off exempts admins from *every* rule with no finer control and no
account-scoping. Repository **rulesets** offer per-actor bypass and are the
mechanism the rest of the ecosystem standardizes on. The question: how to grant
the owner force-push without weakening the zero-divergence guarantee that `main`
feeds into an attested release (ADR-0038).

## Considered Options

1. **Keep classic protection, set `enforce_admins: false`.** Rejected as the
   end state: it works (admins bypass) but is all-or-nothing, not account- or
   role-scoped, and diverges from the ruleset-based model. Used only as the
   interim step before migration.
2. **Single ruleset, Admin bypass actor, containing the required check.**
   Chosen for the branch rules, with eyes open: a ruleset bypass actor bypasses
   the *entire* ruleset including the required status check. Two independent
   reviews confirmed this means an admin force-push/direct-push can land
   non-overlay source on `main` without the preventive guard running.
3. **Split rulesets — required check in a no-bypass ruleset, force-push/PR in a
   bypassable one.** Considered and rejected: a non-bypassable required-check
   ruleset would block (or render meaningless) the maintainer's ability to
   force-push un-checked commits — i.e. it defeats the very capability being
   added. You cannot simultaneously have "owner can force-push to `main`" and
   "the content guard is absolutely enforced"; force-push *is* pushing content
   that never went through the guard.
4. **Named-user bypass instead of the Admin role.** Deferred. The role bypass
   is simplest while solo; the role-creep risk (a future Admin collaborator
   inheriting the bypass) is mitigated by the onboarding rule "never grant a
   collaborator Admin" and revisited when collaborators are added.

## Decision Outcome

Replace classic protection on `main` with the **`protect-main` repository
ruleset**: rules `deletion`, `non_fast_forward`, `pull_request`
(`required_approving_review_count: 0`, dismiss-stale, thread-resolution), and
`required_status_checks` (strict, `enforce overlay path allowlist`,
`integration_id` 15368), with a single **bypass actor = repository Admin role
(`actor_id` 5), `bypass_mode: always`**. The classic rule is deleted after the
ruleset is verified active (GitHub enforces the union during overlap, so no gap).
The inherited enterprise ruleset and the `protect-psmfd-release-tags` tag ruleset
are unaffected.

Because option 2's bypass gap is inherent to allowing force-push at all, it is
covered by a **detective control** rather than a preventive one:
`psmfd/pi` `.github/workflows/psmfd-divergence-detect.yml` runs on every push to
`main` and fails + opens a `divergence-alert` issue when a push introduced
non-overlay changes that did not arrive via a trusted same-repo `sync/upstream-*`
PR, or when the diff cannot be fully verified. It cannot block the push (the
bypass already happened) but makes it auditable and red-flags the next release.

### Consequences

- Good: the owner can force-push `main`; non-admin (write-role) collaborators are
  fully bound by the regular process the moment they are added — no further
  config. Bypass is role-scoped and auditable, not an all-or-nothing toggle.
- Good: the zero-divergence posture is preserved on the normal PR path (the
  required check still gates every non-bypassed merge) and the detective guard
  makes the force-push escape-hatch visible.
- Bad (accepted): an admin force-push/direct-push can still land divergence on
  `main` without the preventive guard; this is detected after the fact, not
  prevented. This is the irreducible cost of the force-push capability.
- Bad: the detective guard duplicates the preventive guard's overlay matcher
  (EXACT / SECURITY_PATCH_PATHS / REGEXES) — a new lockstep surface that must
  track patch retirements alongside the manifest, the allowlist, and the guard.
- Follow-up: when collaborators are added, switch the bypass to a named-user
  actor (or never grant Admin) to remove role-creep exposure; consider raising
  `required_approving_review_count` from 0.

## More Information

The mirror-side record lives in `psmfd/pi` `.psmfd/security-baseline.md`
("Branch protection") and the detective workflow's allowlist entry. The ruleset
itself is repository configuration, not tracked source.
