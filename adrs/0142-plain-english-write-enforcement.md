---
status: Accepted
date: 2026-08-18
---

# ADR-0142: plain-english enforces the Claudish rewrite by mutating write input in flight

**Status:** Accepted — approved with the #1022 implementation plan on 2026-08-18.

**Related:** [ADR-0031](0031-auto-router.md) (the `complete()` call surface and injectable seam this reuses), [ADR-0084](0084-auto-router-prefer-local-classifier.md) (user-layer-only model steering for extension-internal LLM calls), [ADR-0073](0073-token-meter-extension.md) / [ADR-0140](0140-repo-dash-ci-widget.md) (the user-layer-only settings posture), [ADR-0139](0139-extension-tool-capability-declaration.md) (the `no-registerTool` gate this extension declares under). Behavioral counterpart: docs-expert SKILL.md §Plain-English Pass (#1009) and work-item-management-expert §Plain-English Content (#1021).

## Context and Problem Statement

Issue #1009 added a plain-English ("Claudish") pass to the docs-expert and work-item skills: agents are instructed to detect padded, hedged, jargon-heavy LLM prose and write plain English into persisted documentation. Skill text is advisory — an agent that never loads the skill, or drifts, still ships Claudish. The operator asked for enforcement: a mechanical layer that applies the rewrite regardless of which agent authored the content.

The upstream reference, [gvzdv/claudish-to-english](https://github.com/gvzdv/claudish-to-english) (MIT), is a Claude Code `PostToolUse` hook: after a `.md` write, a shell script sends the file body to an LLM and writes either a `NAME.plain.md` sibling (default) or the file in place. Its rewrite contract (preserve facts, code, structure; fail open on every error; never write a partial rewrite over real content) is sound, but its mechanism does not transplant: pi extensions intercept tool calls in-process, and post-hoc rewriting has a failure mode specific to agentic loops.

## Decision Drivers

- **Disk must only ever hold the enforced version** — a window where Claudish is on disk and the rewrite may or may not land is not enforcement.
- **The authoring agent's view of the file must not diverge from disk.** pi's `edit` tool anchors on exact old strings; a post-hoc rewrite invalidates every anchor the agent holds and poisons its next edit.
- **A rewrite failure must never block a turn or lose content** — the same "never write a partial or empty rewrite over real content" contract upstream implements.
- **A cloned repository must not be able to turn the feature on, steer the model, or widen its reach** (the recurring project-layer trust gap: ADR-0073, ADR-0140).
- **Model access follows the sanctioned pattern** — `complete()` via `ctx.modelRegistry`, never raw HTTP to a model endpoint (ADR-0031/0084).

## Considered Options

1. **Pre-write input mutation** — a `tool_call` handler on `write` rewrites `event.input.content` in place before execution (the worktree extension's in-flight mutation pattern, applied to content instead of paths).
2. **Post-write rewrite** — a `tool_result` handler re-reads and rewrites the file with its own `fs.writeFile` (the upstream mechanism, transplanted).
3. **Override the `write` tool** via `pi.registerTool` / custom `WriteOperations` (the hashline-edit pattern).
4. **Advisory only** — keep the skill-level pass, add no runtime layer.

## Decision Outcome

**Option 1: pre-write input mutation**, in a new `agent/extensions/plain-english/` extension.

- The write executes once, already enforced — no second disk write, no rewrite loop (nothing re-triggers `tool_call`), and the tool result the model sees reflects what is actually on disk.
- Option 2 was rejected on the edit-anchoring failure: after a post-hoc rewrite the agent's remembered content no longer matches disk, so its next `edit` fails or (worse) applies against rewritten text it has never seen. Upstream avoids this only by defaulting to sibling files — which is advice, not enforcement.
- Option 3 grants far more surface than needed (full ownership of the write path, plus interaction with hashline-edit's existing `edit` override) for no additional guarantee over in-flight mutation.
- Option 4 fails the stated requirement — the operator asked for enforcement.
- `edit` calls are **out of scope in v1**: fragments lack document context and rewriting them breaks anchoring by construction. Issue-body mutations (`gh issue create` etc.) are out of scope per #1024 — munging arbitrary bash strings is a different risk class.

### Mechanical masking, not prompt-trust

YAML frontmatter and fenced code blocks are extracted before the model call and reinserted verbatim; the model sees `<!-- PE-BLOCK-n -->` placeholders and a reply that drops, duplicates, or invents one is discarded. Upstream protects frontmatter mechanically but code blocks by prompt instruction only; both are mechanical here because a local model garbling one fence would otherwise corrupt executable content. The rewrite instruction additionally pins **claim strength** (must/should/may, stated conditions), mirroring the Rewrite Contract in docs-expert's `references/style.md` — a hedge that encodes a rule condition is content, not style.

### Fail-open posture

Every failure path — no credential, unknown configured model, provider error, timeout (`AbortSignal.timeout` composed with the tool-call signal), completion truncated by the output cap, placeholder mismatch, oversized document — returns the original content unchanged. This is the auto-router "never block a turn" posture (ADR-0031) applied to a guard-shaped hook. Fixable causes notify once per session; the handler's outer catch guarantees no unexpected error can disturb the turn. The trade-off is explicit: under provider outage the feature silently degrades to advisory-only (the skill-level pass), which is the correct failure direction for a style gate — the inverse (fail-closed) would block every documentation write on a down local model.

### Settings and trust boundary

`extensionSettings.plainEnglish`, **user layer only**, default off. The project layer is ignored entirely — stronger than a merge-with-allowlist — because this extension sends file content to a configurable model endpoint and mutates what lands on disk: both are operator-trust decisions a hostile repo must not reach. The `model` setting accepts a `"provider/id"` string or an ordered array of them (capped at 3): an explicit **fallback chain**, tried in order with auto-router's candidate-trial shape — provider-level failures advance, document-property failures stop. Unset uses the session's active model. The chain is the *only* fallback: unknown or credential-less entries are dropped, and exhaustion falls open to the original content — never a silent substitution the operator did not list, because chain order decides which providers the file content egresses to.

## Consequences

- Documentation writes matching the globs incur one model call of latency (bounded by `timeoutMs`, default 30 s) while enabled. The `minChars` gate keeps trivial writes free.
- The catalogue lives in prose (the skill) and the enforcement in code (this extension); they share vocabulary by reference, not by a lockstep copy — drift shows up as weaker rewrites, not corruption.
- Repeated writes of an already-plain document re-run the model harmlessly (idempotent-ish, not cached); acceptable at documentation write rates.
- secrets-guard continues to scan the **original** or **rewritten** content depending on handler order; both are equivalent for its patterns since protected blocks are byte-identical and prose rewrites do not manufacture secrets.
- Mirror distribution (`psmfd/pi-plain-english`) is deferred to #1023 until the fail-open posture has soaked locally.
