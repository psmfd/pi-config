---
status: Accepted
date: 2026-05-25
---

# ADR-0019: Compaction-optimizer extension

**Status:** Accepted
**Date:** 2026-05-25
**Tracking issue:** #208
**Related:** [ADR-0001](0001-subagent-orchestration-substrate.md) (substrate for `agent/extensions/`), [ADR-0004](0004-consensus-by-replication.md) (fan-out shape used for pre-verification), [ADR-0015](0015-network-capable-extensions-and-the-first-party-docs-allowlist.md) (precedent for ADR-eligible new extension)

## Contents

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [Contracts We Rely On](#contracts-we-rely-on)
- [Threat Model and Security Posture](#threat-model-and-security-posture)
- [Consequences](#consequences)
- [Staged Delivery](#staged-delivery)
- [Dissent Recorded](#dissent-recorded)
- [Open Questions Resolved Before Merge](#open-questions-resolved-before-merge)
- [Design Discussion (verbatim)](#design-discussion-verbatim)
- [Pre-implementation Verification (Agent Efficacy)](#pre-implementation-verification-agent-efficacy)
- [More Information](#more-information)

## Context and Problem Statement

Pi's `/compact` command (auto-triggered or user-invoked) summarizes older session entries into a `CompactionEntry` and replaces them in the working context. The default implementation has three properties that are load-bearing problems for an agent-orchestration-heavy workflow like ours:

1. **Opaque.** The summarized turns are replaced; no archive of what was discarded is retained on disk. If the summary loses a detail, the only recovery is re-reading the raw session JSONL.
2. **Unbounded cumulative file-tracker.** Per `docs/compaction.md`, `CompactionDetails.readFiles` / `modifiedFiles` accumulate across compactions and across nested branch summaries. On long sessions the list grows without bound, carrying stale exploratory reads forward indefinitely.
3. **Always LLM-mediated.** Every compaction round-trips through a model. For sessions dominated by subagent orchestration — where the high-signal content is structured tool-call metadata, subagent verdicts (per [`rules/structured-review-format.md`](../agent/rules/structured-review-format.md)), and short user directives — the LLM is paraphrasing data that was already structured. The cost is real, the latency is visible, and paraphrase-induced fidelity loss is the dominant defect mode (the user often discovers post-compaction that a specific decision or constraint was elided).

Pi exposes `session_before_compact` and `session_compact` events to extensions, with documented hooks to override summarization, attach opaque `details`, or fall through to default behavior. No extension in `agent/extensions/` currently uses these hooks. The decision recorded here is how we structure the first extension to do so, what modes it offers, what defaults it picks, and what contractual guarantees it depends on from pi v0.75.5.

## Considered Options

### Mode shape

1. **Single deterministic-only mode.** LLM-free summary always. Simplest implementation; loses on chatty/exploratory sessions where assistant prose is the high-signal content.
2. **Single LLM-with-archive mode.** Default LLM summarizer plus an on-disk archive. Solves opacity, does not address cost/fidelity for the orchestration-heavy case.
3. **Three modes with hybrid default** — `deterministic`, `hybrid`, `llm-only-with-dump`. Most flexible; users opt into the cost/fidelity trade explicitly; hybrid mode falls through to the LLM path on heuristic miss. Higher complexity, requires a clear fall-through contract.
4. **No extension; configure pi's built-in `compaction.*` settings only.** Adjusts thresholds but cannot address opacity, file-tracker growth, or LLM-free summarization. Out of scope of the actual problem.

### Archive default location

A. `~/.pi/agent/extensions/compaction-optimizer/archive/<session-id>/<timestamp>.md` — namespaced under the extension's own subtree, consistent with pi's existing `~/.pi/agent/extensions/<name>.json` config-file convention.
B. `~/.pi/compaction-archive/<session-id>/<timestamp>.md` — top-level under `~/.pi/`, more discoverable for casual inspection (`ls ~/.pi/compaction-archive/`).
C. `<repo>/.compaction-archive/` — per-repo, gitignored, follows the session to the project. Rejected: archives are session-scoped, not repo-scoped, and the per-repo path produces orphaned directories for transient cwd sessions.

### Handler placement

i. **`session_before_compact` only** — handle both pruning and archiving in the pre-compact handler. Simpler. Risk: an archive-write failure blocks compaction; the archive captures the pre-cut entry set rather than the actually-committed boundary.
ii. **`session_compact` only** — handle everything post-commit. Cannot prune `details` (the entry is already written).
iii. **Dual handler** — `session_before_compact` for `details` pruning (must run pre-commit to influence the written entry), `session_compact` for archive write (post-commit; archive reflects what actually committed; write failure cannot block compaction). Most correct; two handlers to maintain.

## Decision Outcome

**Chosen: Option 3 (three modes, hybrid default) × Location A × Handler placement iii.**

The extension registers two handlers:

- `session_before_compact` — runs file-tracker pruning in all modes; in `deterministic`/`hybrid` modes additionally builds the LLM-free summary (or returns `undefined` to fall through to pi's default LLM path per the hybrid heuristics).
- `session_compact` — runs archive write in all modes (post-commit, so the archive reflects the actually-committed `firstKeptEntryId`; write failures are logged via `ctx.ui.notify` but never re-raised).

The dual-handler design requires the `session_before_compact` handler to capture `preparation.messagesToSummarize` before returning — the post-commit `session_compact` event surfaces only `{compactionEntry, fromExtension}` and does not carry the raw message payload the archive writer needs. Implementation: an in-memory `Map<sessionId, MessageSnapshot>` in the extension module scope, populated in the pre-commit handler and consumed-and-cleared in the post-commit handler. Map size is bounded to 1 entry per session (any stale capture from a previously-cancelled compaction is overwritten). Cleared on `session_end` and on process exit. If the archive write fails, the captured turns are lost — archive is **best-effort**; failure degrades to behavior identical to pi-with-no-extension-installed. This caveat applies equally to the "decisioning provenance preserved" claim in [Consequences](#consequences) below.

Modes (user-selectable via settings; default `hybrid`):

| Mode | Summary source | Archive | File-tracker pruning |
|---|---|---|---|
| `deterministic` | LLM-free, built from tool-call metadata + user turns verbatim + subagent verdicts | yes | yes |
| `hybrid` (default) | deterministic when heuristics permit; otherwise return `undefined` to fall through to pi's default LLM summarizer | yes | yes |
| `llm-only-with-dump` | pi's default LLM summarizer (handler returns `undefined` immediately for the summary decision) | yes | yes |

Hybrid fall-through heuristics (all configurable, defaults shown):

| Trigger | Default | Rationale |
|---|---|---|
| `event.customInstructions?.trim()` non-empty | always fall through | User-supplied `/compact <instructions>` cannot be honored deterministically; LLM must receive them |
| Tool-call-to-message ratio < `minToolCallRatio` | `0.3` | Heavily conversational sessions have insufficient structured content for the deterministic builder |
| Any single orphan assistant text > `maxOrphanAssistantTokens` | `2000` | Long explanatory prose without a follow-up tool call is unsummarizable structurally |

Settings namespace: `extensionSettings.compactionOptimizer.*` in `~/.pi/agent/settings.json` (user) and `<cwd>/.pi/settings.json` (project; project overrides user). The original draft used `extensions.compactionOptimizer.*`; pre-implementation verification (see [Pre-implementation Verification](#pre-implementation-verification-agent-efficacy)) surfaced that `extensions` is already a documented core settings key holding `string[]` of extension paths (`docs/settings.md:188-197`), so a `extensions.<name>` object map would type-collide. `extensionSettings.*` is currently vacant in `settings.json` and mirrors the naming used in the upstream proposal tracked at #210.

Archive path: default `~/.pi/agent/extensions/compaction-optimizer/archive/<session-id>/<timestamp>.md`. The default may be overridden via `extensionSettings.compactionOptimizer.archive.path` from `~/.pi/agent/settings.json` (user-layer; supports `~` and absolute paths). From `<cwd>/.pi/settings.json` (project-layer; **untrusted** — see [Threat Model and Security Posture](#threat-model-and-security-posture)) the value MUST be relative and MUST resolve under `<cwd>/.pi/compaction-archive/`; project-layer values that fail this check are rejected with a `ctx.ui.notify` warning naming the rejected key. Ephemeral sessions (`ctx.sessionManager.isPersisted() === false`) default to `extensionSettings.compactionOptimizer.archive.ephemeralBehavior: "skip"`; alternative is `"tmp"` — a randomly-named directory under `$TMPDIR` created via `mkdtemp` with `mode: 0o700` (the original draft's `pi-compaction-archive/ephemeral-<pid>-<timestamp>/` form is superseded by [Threat Model § File-system posture](#file-system-posture); the PID-based name is unsafe).

### Why ADR-eligible despite extension-shape precedent

The pattern-following exemption in [`rules/adr-required.md`](../agent/rules/adr-required.md) applies to extensions whose shape mirrors existing ones. `compaction-optimizer` mirrors the local-only shape of `artifact-handoff` and `secrets-guard` (no new network egress per ADR-0015) but introduces three new substrate properties:

1. **First extension that mutates pi's compaction lifecycle.** Future compaction-touching extensions will reference the contract surface and fall-through semantics codified here.
2. **First extension that writes per-session artifacts to disk under `~/.pi/agent/extensions/<name>/`.** That directory convention is invented by this ADR; no pi-side convention exists (verified via fan-out — see [Pre-implementation Verification](#pre-implementation-verification-agent-efficacy)). It will be referenced by every future extension that needs persistent per-session storage.
3. **First extension to introduce a deterministic-vs-LLM mode selector.** The hybrid-fall-through pattern (`return undefined` from the handler as the only contractually-safe path to pi's default behavior) is non-obvious from the API surface and becomes a reusable idiom.

## Contracts We Rely On

The following are first-party-verified against pi v0.75.5 (the version pinned in `agent/vendor/pi/VERSION`). Three replications of `pi-agent-expert` corroborated each. Citations are to the local pi runtime at `~/.cache/pi_config/pi-v0.75.5/pi/`.

| # | Contract | Source |
|---|---|---|
| 1 | `customInstructions` is a field on `SessionBeforeCompactEvent` (the event), **not** on `CompactionPreparation`. The `examples/extensions/custom-compaction.ts` example silently omits it. | `docs/compaction.md:278-279`, `docs/extensions.md:413-414` |
| 2 | `CompactionPreparation` fields: `messagesToSummarize`, `turnPrefixMessages`, `previousSummary`, `fileOps`, `tokensBefore`, `firstKeptEntryId`, `settings`. Event-level fields: `preparation`, `branchEntries`, `customInstructions`, `signal`. | `docs/compaction.md:280-289` |
| 3 | Return contract: `{ cancel: true }` skips; `{ compaction: { summary, firstKeptEntryId, tokensBefore, details? } }` writes a `CompactionEntry`. `undefined` is the canonical fall-through-to-default-LLM trigger — **inferred** from the handler API shape; no contradicting documentation exists in v0.75.5, but `undefined` is not explicitly named as a fall-through path in `docs/compaction.md`. Empty-string summary is similarly undocumented and SHOULD NOT be used. Upstream documentation request tracked at #211; Contract #3 is updated to cite the documented surface once the upstream lands. | `docs/compaction.md:295-308` |
| 4 | `details` is opaque generic `T = unknown`, not shape-validated. Restrict our payload to pure JSON-serializable values (no Dates, Maps, BigInts, `undefined`). | `docs/compaction.md:148-168` |
| 5 | `firstKeptEntryId` is trusted-not-validated at write time. Safe pattern: always echo `preparation.firstKeptEntryId` unchanged. | `docs/compaction.md:158-167` |
| 6 | `event.signal: AbortSignal` MUST be forwarded to any LLM/IO. v0.75.5 (per `CHANGELOG.md:65`) made the handler await block turn settlement — ignoring the signal leaves `/compact` cancellation (Esc) unresponsive. | `docs/compaction.md:286`, `CHANGELOG.md:65` |
| 7 | No `pi.settings.get()` / `ctx.settings` API exists. Extensions self-load from `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json` (project precedence). Pattern in `examples/extensions/preset.ts` and `examples/extensions/sandbox/index.ts`. | `docs/extensions.md` (no settings accessor documented), `examples/extensions/preset.ts:8-10` |
| 8 | No `ctx.sessionId` accessor. Use `ctx.sessionManager.getSessionId()` (per `docs/session-format.md:410`), falling back to `path.basename(ctx.sessionManager.getSessionFile(), '.jsonl')` for compatibility. Handle the ephemeral-session case where `isPersisted() === false`. | `docs/session-format.md:410`, `docs/extensions.md:875-878` |
| 9 | `session_compact` (post-commit) event exists and fires after the entry is written. Used here for archive writes so failures cannot block compaction. | `docs/extensions.md:430-435` |
| 10 | No known `session_before_compact`-specific defects in v0.75.5 analogous to the parallel-output truncation defect in the subagent extension. Closely-related fixes (#2617 `ctx.compact()` UI rebuild, #2608 repeated-compaction boundary, #4276 `ctx.abort()` preflight, #4484 custom-agent stream functions) all landed pre-0.75.5. | `CHANGELOG.md:65,977,1619,2617` |
| 11 | Pinned pi version `v0.75.5` matches the documented API surface exactly. No snapshot bump required. | `agent/vendor/pi/VERSION` |

## Threat Model and Security Posture

This section is asserted by this ADR rather than verified against pi v0.75.5. It enumerates trust boundaries and obligations the implementation MUST honor. Pre-implementation `/full-review` (security-review-expert verdict NEEDS_CHANGES, code-review-expert NEEDS_CHANGES) surfaced the design defects motivating these requirements; all are PR1 acceptance criteria, also enumerated at the #208 acceptance-criteria comment.

### Trust boundary — project-layer settings are untrusted input

`<cwd>/.pi/settings.json` is, by the project-overrides-user precedence convention codified in [Contract 7](#contracts-we-rely-on), attacker-controlled the moment a user `cd`s into a cloned repository. A hostile project shipping a `.pi/settings.json` with `extensionSettings.compactionOptimizer.archive.path = "/Users/<u>/.ssh/authorized_keys"` (or `~/.zshrc`, `/etc/cron.d/foo`, `~/Library/LaunchAgents/com.attacker.plist`, etc.) would, in the absence of mitigation, cause the next `/compact` while `cwd` is that repo to write attacker-influenced session content to that path with the user's UID. This is an arbitrary-file-write primitive triggered by `cd` and `/compact`.

**Mitigation (PR1):** `lib/settings.ts` enforces a project-layer allowlist. The keys an untrusted project layer MAY override:

- `extensionSettings.compactionOptimizer.mode`
- `extensionSettings.compactionOptimizer.hybrid.*` (heuristic thresholds)
- `extensionSettings.compactionOptimizer.fileTracker.*` (pruning caps)
- `extensionSettings.compactionOptimizer.archive.enabled` (boolean opt-out)

The keys an untrusted project layer MUST NOT override (project value rejected with a `ctx.ui.notify` warning naming the rejected key):

- `extensionSettings.compactionOptimizer.archive.path`
- `extensionSettings.compactionOptimizer.archive.ephemeralBehavior`
- `extensionSettings.compactionOptimizer.archive.redactPatterns`

A project-layer `archive.path`, if present, MAY only be relative and MUST resolve under `<cwd>/.pi/compaction-archive/` (a project that legitimately wants per-repo archives opts in via a project-local relative path, never an absolute redirect). User-layer `archive.path` is unrestricted.

Note on the trade-off implied by allowing project-layer `archive.enabled: false`: a hostile project can silently disable on-disk archiving while `cwd` is in that repo, denying forensic capture for sessions in that repo. This is a deliberate trade — a legitimate project may want no archives for highly sensitive repos — but it means "a session was archived" is not a universal guarantee, only a per-session-and-per-project one.

### Content sensitivity — archives are secret-bearing

Archives by construction contain the full pre-compaction transcript: tool-call inputs and outputs, file contents from `read`, `bash` stdout/stderr (which routinely contains tokens, env dumps, `aws sts` output, `kubectl config view` output, etc.), `web_fetch` bodies, and any secret material the session touched. **No redaction is performed by default; no no-secrets guarantee is claimed.** The archive directory is at least as sensitive as the live session JSONL files and MUST be treated as such by users.

**Mitigations (PR1):**

- Per-mode opt-out: `extensionSettings.compactionOptimizer.archive.enabled: false` skips archive writes entirely.
- Optional redact-pattern hook: `extensionSettings.compactionOptimizer.archive.redactPatterns: string[]` (regex list); matched substrings replaced with `[REDACTED]` before write. PR1 ships the hook with an empty default and no curated default-redaction-set in v1 (explicit non-goal — users wanting redaction opt in). Pattern compilation and matching is best-effort: pathological user-supplied patterns can cause regex backtracking that stalls compaction; PR1 SHOULD apply a per-pattern execution timeout (or `RegExp` engine guard) and on timeout emit a `ctx.ui.notify` warning identifying the offending pattern index, then skip redaction for that pattern. Project-layer cannot override this key (see Trust boundary above), so ReDoS risk is bounded to self-DoS via the user's own settings.
- README states the sensitivity stance verbatim.

### `secrets-guard` interaction — accepted non-coverage with rationale

`agent/extensions/secrets-guard/` only intercepts the `write`, `edit`, and `artifact_review` tool-call events. The archive writer in `lib/archive.ts` uses `fs.writeFile` directly (not a tool call) and is therefore invisible to `secrets-guard`. This is **deliberate**: routing archive writes through `artifact_review` would (a) populate `.review/` with non-handoff content, violating ADR-0007, and (b) interrupt every compaction with a pre-write secret-scan UI prompt the user does not want at compaction time. The `archive.redactPatterns` hook above is the substitute mitigation. The README states this as accepted risk.

### File-system posture

PR1 acceptance criteria for `lib/archive.ts`:

| Concern | Specification |
|---|---|
| Per-session directory creation | `mode: 0o700` |
| Archive file creation | `mode: 0o600` |
| Symlink components | Refused. Walk path components with `realpath` + ancestor-ownership check; if any component is a symlink whose target is outside the resolved-prefix tree, abort the write and `ctx.ui.notify`. |
| Pre-existing target | Refuse, do not follow. |
| Atomic write | Write to sibling tempfile (`<target>.tmp-<random>`) created with `O_NOFOLLOW \| O_EXCL`, then `rename(2)` over target. |
| Ephemeral `"tmp"` mode path | `mkdtemp` (random suffix, NOT PID-based) under `$TMPDIR`, with `mode: 0o700`. Cleanup on process exit (atexit hook) and sweep-on-next-start of stale directories older than 24h. |
| Failure observability | In addition to the transient `ctx.ui.notify`, append a one-line JSON record to `~/.pi/agent/extensions/compaction-optimizer/failure.log` (append-only; `mode: 0o600`) so failures are post-hoc inspectable. The `failure.log` write inherits the same posture rules as the archive writer above: symlink-component refusal via `realpath` + ancestor-ownership check, `O_NOFOLLOW \| O_APPEND` on the file handle, refuse to create if a non-regular-file is present at the target. The parent directory (`~/.pi/agent/extensions/compaction-optimizer/`) is extension-owned and not user-configurable, narrowing the attack surface. |

### Integrity posture (non-claim)

Archives are plain markdown with no signing, hashing, or append-only filesystem guarantee. The "decisioning provenance preserved" benefit (Consequences → Positive) is qualified accordingly: provenance is preserved against accidental loss (the original motivation), not against tampering by any process running as the same user. Tamper-resistance is an explicit non-goal of v1.

## Consequences

### Positive

- **Decisioning provenance preserved against accidental loss.** Pre-compaction archive on disk ensures every discarded turn is recoverable when the archive write succeeds. The opacity problem is structurally solved for the accidental-loss case. Qualifications: archive write is best-effort (write failures degrade silently to pi-default behavior — see handler hand-off paragraph in [Decision Outcome](#decision-outcome)); archives are unsigned and unhashed (tamper-resistance is a non-goal — see [Threat Model § Integrity posture](#integrity-posture-non-claim)).
- **Bounded file-tracker.** Pruning rules cap `readFiles` (configurable, default 50), drop files stale beyond N compactions (default 3), and filter ephemeral path patterns. `modifiedFiles` is never silently dropped.
- **Lower cost / lower latency in hybrid mode** for orchestration-heavy sessions, where the deterministic builder produces a summary at zero LLM cost and zero round-trip latency.
- **Higher fidelity for our workflow specifically.** User messages are preserved verbatim in the deterministic summary; subagent verdicts are extracted directly from `subagent` tool-call results without LLM paraphrase; review-finding tables (per [`rules/structured-review-format.md`](../agent/rules/structured-review-format.md)) survive intact because their structure is the source of truth.
- **Graceful fall-through.** Three failure modes (heuristic miss, custom instructions present, archive write failure) all degrade safely to pi's default behavior. No mode produces worse behavior than pi without the extension.
- **Establishes `~/.pi/agent/extensions/<name>/` as the canonical per-extension data subtree** for this codebase. Future extensions needing persistent per-session storage have a precedent.

### Negative

- **Two handlers to keep in sync.** A future pi change to either event signature requires touching both.
- **Deterministic summary loses orphan assistant prose.** The hybrid heuristic mitigates by falling through, but on edge cases (assistant text just under the orphan threshold, ratio just above the cutoff) the deterministic summary may elide content. Mitigation: the archive always captures the raw turns; users can re-read on demand.
- **Settings namespace not validated by pi.** `extensionSettings.compactionOptimizer.*` is convention, not contract. A future pi top-level `extensionSettings` key with conflicting semantics would silently collide. Mitigation: the `extensionSettings.*` parent key is currently vacant in `settings.json` (verified against `docs/settings.md` at pi v0.75.5), and the upstream proposal tracked at #210 would, if accepted, formalize this key as the registration namespace and add collision detection at the API level.
- **Archive directory growth is unbounded over time.** No rotation/eviction policy in v1. Documented in the extension's README; rotation tracked as a follow-up if it becomes painful.
- **First extension to invent a per-extension data directory convention.** If pi later documents a different convention, we will need to migrate. The migration is mechanical (move directory + update default path) but is non-zero work.
- **`isSplitTurn` field name is docs-only.** Verified semantically present (driven by non-empty `turnPrefixMessages`) but the literal field name was not cross-checked against `pi-mono` types at ADR-write time. The PR1 implementation step explicitly cross-checks against `packages/coding-agent/src/core/extensions/types.ts` at tag `v0.75.5`.

### Neutral

- The extension is local-only; ADR-0015's network-egress allowlist does not apply.
- Settings precedence (project overrides user) follows the existing `preset` and `sandbox` example-extension pattern; no new precedence convention is invented.
- `ctx.compact()` (fire-and-forget API used by `trigger-compact.ts`) is unused by this extension; documented in Contracts for completeness.
- **Rollback is `pi extensions disable compaction-optimizer`** (or remove the extension path from `extensions: []` in settings.json); no state migration required. The archive directory may be deleted or retained at user discretion — its presence does not affect operation if the extension is later re-enabled, and its absence is not an error condition at re-enable time.

## Staged Delivery

**PR1 — archive + pruning (low blast radius, LLM-orthogonal).**

- `agent/extensions/compaction-optimizer/index.ts` with both handlers registered
- `lib/file-tracker.ts` (pruning rules + cumulative merge)
- `lib/archive.ts` (post-commit write, ephemeral handling, atomic write semantics)
- `lib/settings.ts` (self-load + project-override merge)
- Default mode is temporarily `llm-only-with-dump` (NOT `hybrid` — which this ADR specifies as the post-PR2 default). Selecting `deterministic` or `hybrid` in settings during the PR1→PR2 window returns `undefined` (no behavioral change vs pi default) and emits a single "mode not yet implemented; falling through to pi default" notify the first time per session. The post-PR2 default flip is a one-line change in `lib/settings.ts`. README documents the interim default and the flip.
- All requirements from [Threat Model and Security Posture](#threat-model-and-security-posture) are PR1 acceptance criteria: project-layer settings allowlist, file/dir mode bits, symlink-refusal, atomic-write semantics, `mkdtemp`-based ephemeral paths, append-only `failure.log`, and `archive.redactPatterns` hook (empty default).
- Test fixtures asserting (a) project-layer rejection of out-of-prefix `archive.path`, (b) refusal-on-symlink behavior, (c) refusal-on-pre-existing-target, (d) mode-bit assertions on created directories/files.
- README, AGENTS.md repo-layout update, settings.schema.json. README MUST state: archive content sensitivity, `secrets-guard` non-coverage with rationale, integrity non-claim, interim default mode, and the rollback procedure.
- Full PR1 acceptance criteria checklist at #208 comment.

**PR2 — deterministic and hybrid modes.**

- `lib/deterministic-summary.ts` (markdown builder per the schema in [Design Discussion](#design-discussion-verbatim))
- Hybrid heuristics wiring in `index.ts`
- Split-turn handling for `turnPrefixMessages.length > 0`
- Fixture-driven unit tests for both modes
- README updated to make `deterministic` and `hybrid` user-selectable

Each PR ships with `/review` over the aggregate diff and `scripts/validate.sh` green per [`rules/post-implementation-review.md`](../agent/rules/post-implementation-review.md).

## Dissent Recorded

The pre-implementation fan-out (three replications of `pi-agent-expert` — see [Pre-implementation Verification](#pre-implementation-verification-agent-efficacy)) split 1-2 on the archive default path:

- **Adopted (Agent 1 — minority position):** `~/.pi/agent/extensions/compaction-optimizer/archive/<session-id>/<timestamp>.md`. Rationale: extends pi's existing `~/.pi/agent/extensions/<name>.json` config-file convention to the data plane, keeping all extension-owned filesystem state under a single namespaced subtree.
- **Dissent (Agents 2 and 3 — majority position):** `~/.pi/compaction-archive/<session-id>/<timestamp>.md`. Rationale: more discoverable for casual `ls ~/.pi/` inspection; simpler path.

Per [`rules/consensus-by-replication.md`](../agent/rules/consensus-by-replication.md) (majority → orchestrator chooses + document dissent), the orchestrator overrode the 2-of-3 majority on the strength of the convention-fit argument. Because the path is user-configurable via `extensionSettings.compactionOptimizer.archive.path`, the dissent only affects users who do not override the default. If post-merge usage data shows the discoverability argument was load-bearing, flipping the default is a one-line change to `lib/settings.ts` and a README edit — no migration is required because the setting is configurable.

## Open Questions Resolved Before Merge

PR1 must close the following before merge (none are ADR-blocking; all are implementation-time verification):

1. **`CompactionPreparation` field set cross-check.** Verify `isSplitTurn` field name and `fileOps` shape against `pi-mono@v0.75.5:packages/coding-agent/src/core/extensions/types.ts`. The local pi runtime ships without `.d.ts` for `@earendil-works/pi-coding-agent`, so docs-stated field names cannot be type-verified locally. Use `web_fetch` against `raw.githubusercontent.com` (already on the allowlist per ADR-0015) or `gh api` to retrieve the file at the matching tag.
2. **`ctx.sessionManager.getSessionId()` accessor confirmation.** Two of three verification agents cited `getSessionFile()` + `basename` as the primary path; one cited `getSessionId()` directly. Implementation should prefer `getSessionId()` if it exists, with the basename derivation as fallback. Confirm via the same `pi-mono` types lookup.
3. **`CompactionResult` shape returned to `ctx.compact()`'s `onComplete`.** Documented as "result" in `docs/extensions.md:942-955` without a documented schema. Not blocking for this extension (which does not call `ctx.compact()`), but document the verified shape in the extension README for the benefit of future extensions that compose with this one.

## Design Discussion (verbatim)

This section preserves the design dialogue that produced this ADR, per the user directive that "loss of decisioning data is not desired." Reproduced with light formatting normalization; substantive content unchanged.

### Original three-angles analysis

| Angle | Mechanism |
|---|---|
| Cheaper model for the summary pass | Route the summarization call through a smaller/faster model (`examples/extensions/custom-compaction.ts` demonstrates) |
| Deterministic, LLM-free summary | Build the summary from tool-call metadata + file tracking — zero token cost, no latency |
| Domain-specific structure | Override the default markdown with a shape that matches the workflow (preserve `REPORT_FILE:` paths, ADR refs, issue numbers) |
| Aggressive file-list pruning | Default tracking accumulates; dedupe/collapse to keep summaries lean over long sessions |
| Pre-compaction artifact dump | Write the about-to-be-discarded turns to disk before returning the summary, so nothing is truly lost |
| Tune trigger thresholds | Combine with `compaction.reserveTokens` / `compaction.keepRecentTokens` in `settings.json` |

User selected: **file-list pruning + pre-compaction artifact dump + deterministic LLM-free summary** (with deeper discussion requested on the deterministic angle).

### Proposed deterministic schema (PR2 implementation target)

```markdown
## Goal
<verbatim first user message of the summarized span, truncated to 500 chars>

## User Turns (verbatim)
1. [turn-id 7] <user message 1, full text>
2. [turn-id 12] <user message 2, full text>
...

## File Activity
### Modified (N files)
- `path/to/file.ts` — 3 edits, last at turn 14
- ...
### Read (M files, after pruning)
- `path/to/other.ts` — 2 reads
- ...

## Tool Activity Summary
- `bash`: 14 invocations  (last: `npm test` → exit 0)
- `subagent`: 2 invocations  (linter PASS, code-review-expert NEEDS_CHANGES)
- `web_fetch`: 3 invocations  (last URL: https://...)

## Subagent Verdicts
| Agent | Verdict | Brief |
|---|---|---|
| linter | PASS | "lint clean across 8 files" |
| code-review-expert | NEEDS_CHANGES | "REPORT_FILE: .review/.../findings.md" |

## Carried-Forward Context
<previousSummary, if any, with file-tracker re-pruned>

## Compaction Metadata
- tokens_before: 87,432
- entries_summarized: 38
- generated_by: compaction-optimizer (deterministic)
- generated_at: 2026-05-25T...
```

### Why deterministic works well in this codebase specifically

- The workflow is **agent-orchestration-heavy**. The high-value signal — "what did each subagent conclude?" — is fully recoverable from `subagent` tool-call results without re-reading the assistant's prose.
- The [`rules/structured-review-format.md`](../agent/rules/structured-review-format.md) rule means review findings live in a parseable table. The deterministic builder extracts the verdict row directly.
- The [`rules/subagent-parallel-handoff.md`](../agent/rules/subagent-parallel-handoff.md) rule (Form A `REPORT_FILE:` paths, Form B fenced blocks) gives the builder unambiguous anchors.
- User messages stay verbatim — pi user messages tend to be short directives. Compressing them is where LLM-based summaries most often lose nuance.

Note that `event.customInstructions` is NEVER injected into this deterministic schema. The hybrid heuristic table in [Decision Outcome](#decision-outcome) routes any non-empty `customInstructions` through the LLM fall-through path (where pi's default summarizer honors them). In `deterministic` mode (where fall-through is disabled by user choice) non-empty `customInstructions` are silently dropped with a one-time-per-session `ctx.ui.notify` warning: `"/compact <instructions> not honored in deterministic mode; switch to hybrid or llm-only-with-dump to use custom instructions"`. The deterministic builder receives no `customInstructions` input.

### Where deterministic falls down — and the hybrid escape

| Situation | Deterministic handles? | Mitigation |
|---|---|---|
| Long assistant explanatory prose with no follow-up tool call | no | Detect orphan assistant text > threshold, fall through |
| User-supplied `/compact <instructions>` | no | Detect non-empty `event.customInstructions` → fall through |
| Heavily conversational sessions (planning, design debate) | no | Heuristic: if `tool_call_count / message_count < minToolCallRatio`, fall through |
| Single-turn deep-investigation answer from one big tool result | yes | Works well |
| Typical orchestration + review cycle | yes (very well) | — |

### User decisions captured

1. **Archive default location:** configurable, global default (not per-repo).
2. **Default mode:** `hybrid`, with mode itself configurable.
3. **Scope of v1:** staged. PR1 = archive + file-tracker pruning. PR2 = deterministic + hybrid modes.
4. **Pre-implementation verification:** approved (executed below).
5. **Archive path override of majority:** `~/.pi/agent/extensions/compaction-optimizer/archive/...` adopted; dissent recorded above.
6. **Settings namespace:** `extensionSettings.compactionOptimizer.*` (revised from initial `extensions.compactionOptimizer.*` after pre-verification surfaced the collision with the existing `extensions: string[]` core settings key).
7. **PR1 dual-handler refinement** (pre-compact for pruning + post-compact for archive write): accepted.

## Pre-implementation Verification (Agent Efficacy)

Fan-out shape: three replications of `pi-agent-expert` with identical 8-question briefs, satisfying the ≥3 minimum per [`rules/research-parallelism.md`](../agent/rules/research-parallelism.md) via [`rules/consensus-by-replication.md`](../agent/rules/consensus-by-replication.md). Conducted 2026-05-25.

### Efficacy table

| Invocation | Verdict | Findings | Unique contribution |
|---|---|---|---|
| `pi-agent-expert` #1 | PASS_WITH_WARNINGS | 13 | Split-turn handling risk; the `~/.pi/agent/extensions/` convention argument ultimately adopted |
| `pi-agent-expert` #2 | PASS_WITH_WARNINGS | 13 | `.d.ts` absence in vendored runtime → drove the `pi-mono` cross-check open question |
| `pi-agent-expert` #3 | PASS_WITH_WARNINGS | 8 (+ per-question prose) | `session_compact` post-commit hook → drove the dual-handler refinement; surfaced `agent/vendor/pi/README.md` doc drift (now tracked as #209) |

Unanimous verdict: **PASS_WITH_WARNINGS** with ~85% finding overlap and three uniquely-valuable divergent contributions (one per agent). Most-severe-wins aggregation: PASS_WITH_WARNINGS. Replication delivered measurable value over a single call — each agent surfaced at least one finding the others missed.

### Findings absorbed into this ADR

- Contracts 1–11 in [Contracts We Rely On](#contracts-we-rely-on) are the consolidated unanimous findings with citations.
- Dual-handler refinement (originally unique to Agent 3) is the chosen architecture.
- `pi-mono` types cross-check (originally unique to Agent 2) is open question #1.
- `getSessionId()` vs `getSessionFile()` divergence (Agent 3 vs Agents 1+2) is open question #2.
- Archive default path divergence is captured in [Dissent Recorded](#dissent-recorded).

### Follow-ups filed pre-ADR

- #208 — tracking issue for this ADR's implementation.
- #209 — `agent/vendor/pi/README.md` doc drift (surfaced by Agent 3; doc-only fix, separate PR).

### Held for further discussion

- Upstream proposal to `earendil-works/pi` (formerly `pi-mono`) for a documented per-extension data directory convention. The convention adopted here (`~/.pi/agent/extensions/<name>/`) is project-local; whether to lobby for an upstream version requires a separate decision and remains held.

### Filed during ADR-0019 self-review (not held)

- Upstream proposal for schema-registered extension settings API — tracked locally at #210, filed upstream as [`earendil-works/pi#4981`](https://github.com/earendil-works/pi/issues/4981) (auto-closed by new-contributor bot per repo convention; awaiting maintainer reopen).
- Contribution request to document `undefined`-return fall-through in `docs/compaction.md` — tracked at #211; upstream filing pending re-review of `earendil-works/pi` contribution docs (procedure documented in #211).

### Self-review (Agent Efficacy)

Pre-commit `/full-review` over the ADR draft (4-way parallel: code-review-expert + security-review-expert + linter + docs-expert; checkmarx-expert skipped — `cx` unavailable). Most-severe-wins aggregation:

| Reviewer | Verdict | Severity ceiling |
|---|---|---|
| code-review-expert | NEEDS_CHANGES | Error (×2) |
| security-review-expert | NEEDS_CHANGES | **Critical** (×1) + High (×4) |
| linter | PASS | — |
| docs-expert | PASS_WITH_WARNINGS | High (×2; doc-sync companion edits) |

Aggregate verdict: **NEEDS_CHANGES** → addressed in this commit. Findings closed:

- Security Critical (arbitrary-file-write via project-layer `archive.path`) → [Threat Model § Trust boundary](#trust-boundary--project-layer-settings-are-untrusted-input).
- Code Error 1 (cross-handler state hand-off unspecified) → hand-off paragraph in [Decision Outcome](#decision-outcome).
- Code Error 2 (default-mode regression in PR1) → [Staged Delivery](#staged-delivery) PR1 interim default flip.
- Security High (secrets-guard bypass, content sensitivity, ephemeral tmp unsafe, atomic-write hand-wave) → [Threat Model](#threat-model-and-security-posture) subsections.
- Code Warnings (Contract #3 hedge, payload-on-failure, tunables, customInstructions schema note) → inline.
- Docs High (README + AGENTS doc-sync) → companion edits in same commit.
- Docs Med (Mermaid sequence diagram) → deferred as improvement (not blocking).
- Docs Low (section ordering, line-citation footnote) → deferred (not blocking).

The ADR renumbered from draft ADR-0018 to ADR-0019 during this self-review after the README cross-link surfaced that ADR-0017 reserves the 0018 slot for substrate-ζ implementation work (#204). Rename produced no orphan number (draft was uncommitted).

## More Information

- [`docs/compaction.md`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/compaction.md) — pi compaction documentation (mirror at `~/.cache/pi_config/pi-v0.75.5/pi/docs/compaction.md`)
- [`examples/extensions/custom-compaction.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/custom-compaction.ts) — reference LLM-with-different-model implementation
- [`examples/extensions/trigger-compact.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/trigger-compact.ts) — reference `ctx.compact()` usage
- [`agent/rules/post-implementation-review.md`](../agent/rules/post-implementation-review.md) — doc-sync pairs that PR1 and PR2 must each satisfy
- [`agent/rules/structured-review-format.md`](../agent/rules/structured-review-format.md) — source of truth for the verdict-row extraction logic in the deterministic builder
- [`agent/rules/subagent-parallel-handoff.md`](../agent/rules/subagent-parallel-handoff.md) — source of truth for `REPORT_FILE:` and fenced-block anchor extraction in the deterministic builder
