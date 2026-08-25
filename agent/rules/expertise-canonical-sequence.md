---
description: Require one deterministic canonical expertise search and identical injection across every research sequence item
---

# Expertise Canonical Sequence

**Runtime enforcement:** `expertise-fanout-gate` retains its historical component identity but now recognizes research-shaped serial `sequence` calls through `expertise-indexer/sequence-derive.ts`.

## Rule

For a research sequence of at least three items that is not review-only:

1. Run one canonical `expertise_search` before child execution.
2. Derive the query and canonical blob from the exact ordered sequence and current repository identity.
3. Inject the same `CANONICAL_EXPERTISE_RESULTS` block into every item as user-role `Task:` content.
4. If any item contains caller-supplied injection, normalize the first non-empty block across every item and stand down; never mix replica context or anchors.
5. Execute children serially with no prior-output propagation.
6. Coalesce returned `EXPERTISE_CANDIDATES` only after the complete sequence.
7. Surface candidate groups for real interactive approval. Never auto-invoke `expertise_create`; the create gate requires a matching single-use approval hash.

Identical injection is load-bearing for serial replication: each replica must begin from the same canonical context and cannot observe earlier results.

## Failure Posture

Canonical pre-fetch is fail-open and self-caught: missing configuration, rate limiting, network failure, git-probe failure, or malformed API output lets the serial sequence proceed uninjected. Candidate creation remains fail-closed. A 429 arms session backoff and is not retried in-handler.

## Authentication Boundary

Authentication is parent-owned. Local loopback API-key mode and upstream HTTPS bearer/static-OIDC mode are supported. Spawned children receive neither bearer sources nor default secrets-file discovery. Canonical content is user-role data, never a remotely sourced system message.

## Trigger and Audit

The mechanical trigger is `sequence.length >= 3` with at least one non-review-only agent. Single and dependent chain calls do not trigger automatically and require explicit `expertiseInjection` when research-shaped.

The gate emits secret-redacted telemetry for inject/skip/error outcomes. `scripts/test-expertise-indexer.sh`, `scripts/test-expertise-fanout-gate.sh`, and `scripts/validate.sh` enforce derivation, injection, approval, and audit behavior.
