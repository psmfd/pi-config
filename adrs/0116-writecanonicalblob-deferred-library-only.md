---
status: Accepted
date: 2026-07-21
---

# ADR-0116: writeCanonicalBlob cache-write path is deferred, library-only

**Status:** Accepted
**Date:** 2026-07-21
**Related:** [ADR-0028](0028-agent-expertise-api-client.md) (superseded by ADR-0103; its delivery list is where the ambiguity this ADR resolves originates), [ADR-0103](0103-upstream-expertise-static-oidc-consumption.md), [ADR-0095](0095-deterministic-expertise-fanout-gate.md) (the fanout-gate that consumes the read half), pi_config #818 (this reconciliation), #817 (the item-14 review that surfaced it), #598 (the canonicalizer + cache deliverable), #604 / #601 (tracked future consumers).

## Context and Problem Statement

`agent/extensions/expertise-indexer/canonicalize.ts` (#598, epic #595) ships two halves:

- **Read/compute half** — `computeCanonicalBlob()`: pure, and **wired**: `expertise-fanout-gate/index.ts` calls it for `blob.sha`, and `audit-cli.ts` uses it for the CI audit path.
- **Write/persist half** — `writeCanonicalBlob()`, `resolveCacheDir()`, `CanonicalBlobSecretError`: the gzip blob cache at `${PI_CODING_AGENT_DIR:-$HOME/.pi}/expertise_cache/<sha>.json.gz` (parent 0700 / file 0600, atomic temp-sibling rename, leaf-symlink refusal, fail-closed secret scan before any file open). A repo-wide search finds **zero runtime callers** — only `test/canonicalize.test.ts` exercises it.

ADR-0028 (now superseded by ADR-0103) lists #598 — "canonicalizer + cache" — as delivered. The cache-write half being unreachable in production leaves an ADR-vs-reality gap: either an incomplete deliverable or a deliberate deferral, with nothing recording which. Superseded ADRs are never edited (adr-required), so the reconciliation must be a new record.

## Considered Options

1. **Wire it now** — have `expertise-fanout-gate` or `audit-cli` persist the blob on each computation. Rejected for now: no consumer *reads* the cache today, so wiring the write side alone would add runtime disk writes (and 0600/0700 artifacts to manage) with zero functional benefit — a cache with no reader is dead weight, not delivery.
2. **Remove the write path** — delete `writeCanonicalBlob`/`resolveCacheDir` and their tests. Rejected: the code is pure, regression-hardened (persistence, gzip round-trip, secret-scan refusal, symlink handling are all pinned by tests), secret-safe by construction, and the tracked consumers that motivated it (#604 pre-push hook, #601 CI expertise-audit) remain open. Deleting shipped, mirrored, tested code to re-add it later is churn without risk reduction.
3. **Formally record the deferral** — keep the write path as tested library surface; record its status explicitly here and in the extension README. **Chosen.**

## Decision Outcome

**Option 3.** `writeCanonicalBlob` / `resolveCacheDir` / `CanonicalBlobSecretError` are **deliberately library-only until a tracked consumer lands**. The intended first consumers are the open #604 (pre-push hook) and #601 (CI expertise-audit) integrations; whichever lands first wires both the write and a read of the cache in the same change, so the cache never exists write-only in production.

This ADR — not ADR-0028's delivery list — is the authoritative status record for the #598 cache half. The extension README's `writeCanonicalBlob` section carries a matching status note, and its Non-goals section already excludes consumer wiring from this library dir's scope.

## Consequences

- **Positive:** the ADR-vs-reality ambiguity #818 flagged is closed; a future reader finds an explicit deferral decision instead of an unexplained dead path; the tested, secret-safe implementation stays ready for #604/#601.
- **Neutral:** the cache-write path remains unreachable in production until a tracked consumer lands; its test suite continues to run as the only exerciser.
- **Accepted:** if #604 and #601 are ever retired without adopting the cache, a follow-up ADR should supersede this one and remove the write path (Option 2 becomes correct at that point) — deferral is not an indefinite exemption.
