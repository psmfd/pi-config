# expertise-fanout-gate — deterministic canonical-expertise pre-fetch

Pi extension that makes the canonical-expertise pipeline's "research starts →
expertise is searched" rule ([`agent/rules/expertise-canonical-fanout.md`](../../rules/expertise-canonical-fanout.md))
a **runtime property** instead of orchestrator prompt discipline
([ADR-0095](../../../adrs/0095-deterministic-expertise-fanout-gate.md), #613, epic #595).

## What it does

A `tool_call` hook on the `subagent` tool:

1. **Trigger** (mechanical, no LLM judgment — `expertise-indexer/fanout-derive.ts`):
   parallel mode (`tasks`), `tasks.length >= 3`, and NOT review-only (the
   closed set `checkmarx-expert` / `code-review-expert` / `linter` /
   `security-review-expert` — a fanout composed entirely of those is the
   multi-reviewer `/review` shape, not research). Single-agent and chain
   calls never trigger (accepted gap, ADR-0095). A fanout where the caller
   already supplied any `expertiseInjection` stands down entirely.
2. **Derive**: canonical query from the agent names + first task
   (`buildCanonicalQuery` template), and the anchoring `canonical_blob_sha`
   from repo origin + HEAD + the exact task list (`computeCanonicalBlob`,
   empty `files` by contract — a live fanout has no changed-set).
3. **Search**: ONE `expertise_search` (limit 5) against the loopback
   agent-expertise-api, through the shared client stack
   (`shared/expertise-api-{config,http,health,search}.ts`) with the same
   loopback-only + key-required invariants as the tool surface.
4. **Inject**: renders `CANONICAL_EXPERTISE_RESULTS` via
   `renderCanonicalResultsBlock` and mutates every task's
   `expertiseInjection` in place. The vendored subagent extension prepends it
   to each child's user-role `Task:` framing (LOCAL PATCH #6) — never
   `--append-system-prompt`, per [`no-mcp-servers.md`](../../rules/no-mcp-servers.md).

## Approval loop + `expertise_create` gate (#605)

A `tool_result` hook on `subagent` surfaces coalesced
`EXPERTISE_CANDIDATES` groups (attached by LOCAL PATCH #6) to the operator
**one at a time via `ctx.ui.confirm`** — no dialog timeout (RPC
auto-resolve hazard), first-seen order. A real confirm(true) records a
**full-field approval hash** (`expertise-indexer/approval.ts`: the
create-relevant subset, byte-locked serialization — never the
`{domain,title}` coalesce fingerprint) in an in-session, single-use
ledger, and appends a guidance note to the tool result with the EXACT
params the model must pass to `expertise_create`.

A `tool_call` gate on `expertise_create` recomputes the hash over the
actual call params: ledger match → allow (consumed); anything else →
**block, fail-closed** — including internal gate errors. Interactive
sessions get an inline fallback: a direct create with no prior fanout
approval triggers its own `ctx.ui.confirm` over the exact params (secret-
scanned before display). Headless sessions never approve: candidate
groups queue to
`~/.pi/agent/extensions/expertise-fanout-gate/pending/<date>.jsonl`, and
creates without a ledger match are blocked outright.

Divergent-variant groups (`variantCount > 1`) are queued, never approved
blind — the library retains only the representative body, so the
per-proposer inspection invariant (`bodyHashesByProposer`) cannot be
satisfied in a single dialog.

## Failure posture

**Fail-open, self-caught.** The pi runtime does not wrap `tool_call`
handlers in try/catch, so every failure path (missing key, unreachable API,
429, git probe failure, internal bug) is caught inside the handler and
degrades to "fanout proceeds without canonical context". One search per
fanout; a 429 arms a session-wide backoff (`Retry-After` when sent, else
60s); no in-handler retries.

## Visibility & telemetry

Each automatic search — precisely because it is not a model-visible tool
call — emits one audit line (stderr always, `ctx.ui.notify` when
interactive) and a JSONL record under
`~/.pi/agent/extensions/expertise-fanout-gate/telemetry/<YYYY-MM-DD>.jsonl`
(ADR-0019 data subtree; local-only). The telemetry log is the first-party
artifact the #601 audit
consumes: approval-loop rows carry the candidate's `candidateBlobSha`, which
the audit cross-checks against an earlier `inject` row's anchor in the same
file — a forged or displaced anchor fails the audit. Free-text fields are
secret-scanned (shared pattern set) and redacted to category names on match.

## Configuration

Same sources as expertise-client, resolved through the shared parser:
`process.env` > the expertise-client extension's `.env.local` (sibling path
`../expertise-client/.env.local` — extensions co-live under
`~/.pi/agent/extensions/`). No config → the gate logs one warning per
session and skips. Read-only by construction: no create-capable module is
imported.

## Files

- `index.ts` — hook wiring, config resolution, backoff, injection, approval
  loop, create gate.
- `lib/git-info.ts` — bounded `git` probes (origin, HEAD), injectable executor.
- `lib/telemetry.ts` — JSONL appender + secret-redaction.
- `lib/approval-ledger.ts` — in-session single-use ledger + pending queue.
- `test/index.test.ts` — fake-pi harness tests (trigger boundaries, round-trip
  sha, every fail-open path, 429 backoff).
- `test/approval.test.ts` — approval loop + create gate (ledger single-use,
  TOCTOU, headless fail-closed, divergent-variant queueing, inline confirm).

Run tests: `./scripts/test-expertise-fanout-gate.sh` (wired into
`validate.sh`).

## Distribution

Config-mirror-shipped (like `subagent` and `expertise-indexer`; NOT a
standalone mirror) — its imports of `../expertise-indexer/…` and
`../shared/…` resolve on a distributed install because all three ship
together in the pi-config mirror.
