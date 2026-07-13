---
status: Accepted
date: 2026-07-12
---

# ADR-0095: Deterministic expertise consumption — fanout gate extension, shared client stack, code-enforced approval

**Status:** Accepted
**Date:** 2026-07-12
**Related:** [ADR-0028](0028-agent-expertise-api-client.md) (the loopback expertise-api client and its trust boundary), [ADR-0029](0029-expertise-client-coexistence.md), [ADR-0065] / [ADR-0088](0088-cross-extension-import-boundary.md) (the `shared/` inline mechanism and the #635 cross-extension-import precedent this extends), [ADR-0019] (per-extension data subtree the telemetry follows), #595 (epic), #613 (this trigger), #605 (approval loop, layered on this design), #601 (CI audit consuming the telemetry)

## Context and Problem Statement

The canonical-expertise pipeline (#595) shipped its pure library (#598/#608),
collector primitives, and subagent runtime wiring (#611) — but the two acts
that make it a *pipeline* remained orchestrator-model discipline: running the
canonical `expertise_search` when a research fanout starts, and gating
`expertise_create` on human approval. `agent/rules/expertise-canonical-fanout.md`
said MUST; nothing enforced it. The operator's directive for this arc:
"Subagents surface expertise, the orchestrator writes it with approval;
research starts, expertise is searched" — **deterministically**.

A 3-agent design fan-out plus a security advisory established: (a) the pi
SDK's `tool_call`/`tool_result` hooks are the right seam (mutable `input`,
block-capable result), with a load-bearing asymmetry — the runtime does NOT
catch `tool_call` handler exceptions but DOES catch `tool_result` handlers;
(b) `expertise_create` today verifies no approval record at all — the UI
choice matters less than the binding; (c) a transcript-scan CI audit is
forgeable because `canonical_blob_sha` is attacker-computable from public
repo state.

## Decision Outcome

A new **first-party, config-mirror-shipped extension `expertise-fanout-gate`**
owns determinism; the patch-tracked vendored `subagent/index.ts` is untouched
(no new LOCAL PATCH).

1. **Deterministic trigger (#613, this change).** A `tool_call` hook on
   `subagent` fires on a *mechanical* research-shape test
   (`expertise-indexer/fanout-derive.ts`, pure): parallel `tasks`, length ≥ 3
   (the `research-parallelism.md` divergence minimum), and not review-only
   (closed agent set `checkmarx-expert`/`code-review-expert`/`linter`/
   `security-review-expert` — the multi-reviewer `/review` shape). It derives
   the canonical query (sorted agent names + `research` + first task), the
   anchoring blob (repo origin + HEAD + exact task list, `files` empty by
   contract), runs ONE `expertise_search` (limit 5), and injects the rendered
   block into every task by mutating the tool input. The subagent extension's
   existing LOCAL PATCH #6 wiring does the rest.
2. **Shared client stack.** `expertise-client/lib/{config,http,health,search}.ts`
   (plus the pure `.env.local` parse helpers) move to
   `agent/extensions/shared/expertise-api-*.ts` — the exact ADR-0088 move,
   for the exact #635 reason: the client is mirror-excluded, so the gate
   could never import it on a distributed install. `.env.local` path
   ANCHORING stays consumer-local; the gate resolves the client's sibling
   `.env.local` (`../expertise-client/.env.local`) and parses it through the
   one shared parser with the same loopback-only + key-required invariants.
3. **Failure postures are directional.** The pre-fetch hook is **fail-open
   and self-caught** (uncaught `tool_call` exceptions would break the turn;
   an unreachable API must degrade to an uninjected fanout). The forthcoming
   `expertise_create` gate (#605, layered on this extension) is **fail-closed**:
   an unverifiable approval blocks the write. One search per fanout; a 429
   arms a session backoff (`Retry-After` when sent, else 60 s); no in-handler
   retries.
4. **Visibility stand-in (security advisory).** An extension-autonomous
   search has no model-visible tool-call frame — the named defense-in-depth
   pattern in `no-mcp-servers.md`. Compensating control: every automatic
   search emits one stderr audit line (+ `ctx.ui.notify` when interactive)
   and one JSONL telemetry record (query, result count, anchor sha) under
   `~/.pi/agent/extensions/expertise-fanout-gate/telemetry/` (ADR-0019
   subtree; secret-scanned + redacted, length-bounded, local-only). The
   injection itself remains user-role `Task:` content — the rule's core
   prohibition (system-context injection) is untouched.
5. **Telemetry is the audit artifact (#601 re-definition).** The CI audit's
   primary input becomes this first-party log — written by extension code,
   not model output — with transcript-marker scanning as defense-in-depth.
   The audit recomputes the expected sha via the SAME pure derivation
   (`fanout-derive.ts`) from the recorded task list plus its own checkout
   state, never trusting embedded values.

### Approval design (decided here, lands with #605)

`expertise_create` stays **model-invoked** ("the orchestrator writes it") but
becomes **code-gated**: each human approval — `ctx.ui.confirm` (the
gh-identity-guard dialog pattern; no dialog timeout) — records a
**full-field canonical hash** in an in-session, single-use ledger. A
`tool_call` gate on `expertise_create` recomputes the hash over the actual
call params: match → allow (consumed); mismatch or absent → block. Binding
to the `{domain,title}` coalesce fingerprint is explicitly rejected — it
would let one approval authorize any of N divergent bodies (the
body-smuggling vector `bodyHashesByProposer` exists to prevent). Headless
sessions (`!ctx.hasUI`) fail closed: candidates queue to a pending file for
a later interactive session. File-drop and webhook approval mechanisms were
rejected as model-spoofable / heaviest-weight respectively.

**Implementation refinements (landed with the #605 PR):**

- The hash covers the **create-relevant subset** (domain/title/body/
  entryType/severity + optional source/tags/sourceVersion, tag order
  significant) — `justification` is an `EXPERTISE_CANDIDATES` review field,
  not a create param; it is displayed at approval time and excluded from
  the hash, since the create call could never reproduce it.
- Groups with `variantCount > 1` are **queued, never approved in-dialog** —
  the coalesce library retains only the representative body, so the
  per-proposer inspection invariant cannot be satisfied in a single
  confirm; the pending queue carries `bodyHashesByProposer` for the later
  manual review.
- **Inline interactive fallback:** a direct `expertise_create` with no
  prior fanout approval (the operator personally asked for an entry) is
  not dead — the gate itself raises `ctx.ui.confirm` over the exact params
  (secret-scanned before display). Headless remains a hard block. Every
  create therefore passes a real human dialog exactly once.

### Considered and rejected

- **Search calls inside `subagent/index.ts`** (#613 as originally filed) —
  expands the patch-tracked vendored surface (new LOCAL PATCH, GNU-diff
  manifest churn) and couples the hot spawn path to the expertise API. The
  sibling-extension hook achieves the same with zero vendored churn.
- **An LLM-judged "is this research?" trigger** — unauditable and
  non-deterministic; the mechanical shape test is reproducible by CI.
- **Duplicating a minimal fetch wrapper in the gate** instead of relocating
  the client stack — a fourth lockstep-comment site; the relocation serves
  the gate, the client, and the #601 audit runner from one source.
- **Transcript-scan-first CI audit** — forgeable by construction (see
  Context); demoted to defense-in-depth.

### Consequences

- **Accepted gap:** single-agent and chain-mode research calls get no
  automatic pre-fetch — the trigger is fanout-shaped by design (the rule's
  own scope). An orchestrator can still inject manually via
  `expertiseInjection`; a caller-supplied injection makes the gate stand
  down entirely (no mixed anchors within one fanout).
- **Accepted coupling:** the gate reads the expertise-client extension's
  `.env.local` by sibling path. Same trust domain (operator-installed
  extension tree, never repo content); absent sibling degrades to
  "no config → skip". On installs without expertise-client, the gate is
  inert.
- The `REVIEW_ONLY_AGENTS` set is closed and hand-maintained; adding a
  review agent to the catalog requires updating it (test-pinned).
- Telemetry lives under the ADR-0019 subtree rather than #605's proposed
  `$PI_CODING_AGENT_DIR/expertise-telemetry/` — one convention, not two.
- `SearchResult`'s failure variant gains `rateLimited`/`retryAfterSeconds`
  (additive) so programmatic callers stop sniffing prose.
- **Scope of the create-gate invariant (post-arc review amendment):** the
  code-enforced approval holds only where this gate extension is loaded.
  The standalone `pi-expertise-client` mirror ships no gate — an install
  of just that extension falls back to the ADR-0028 guards (write opt-in +
  secret scan) and prompt discipline. Accepted: the mirror's charter is
  the client tool surface; bundling the gate would drag the subagent/
  indexer dependency graph into it. The rule doc carries the same caveat.
- **Post-arc review hardening (same PR):** one-search-in-flight guard
  (concurrent fanouts skip rather than double-spend the budget); telemetry
  `agents` values sanitized like every other free-text field; the
  `secret-detected` pending-queue path persists a field-wise REDACTED
  candidate copy (fingerprint + body hashes still identify it); the
  create gate's inline confirm is capped at 3 per session
  (approval-fatigue guard); the CI audit artifact's embedded search body
  is redaction-scanned; the workflow scopes `PI_EXPERTISE_API_KEY` to the
  dedicated audit step instead of the whole validator process tree.
