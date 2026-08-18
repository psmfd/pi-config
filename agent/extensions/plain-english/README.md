# plain-english

Enforces the Claudish→plain-English pass on markdown writes (ADR-0142, #1022). The behavioral half lives in the docs-expert skill (`agent/skills/docs-expert/SKILL.md` §Plain-English Pass, #1009); this extension is the mechanical half: prose that would land on disk in Claudish gets rewritten before the write executes.

## How it works

A `tool_call` handler on the core `write` tool checks eligibility (a `.md` file inside the working tree, include-glob matched, not excluded), masks protected content, sends the remainder to a model with the rewrite instruction, and — only on a fully verified reply — mutates `event.input.content` in place so the actual write carries the plain-English version. Disk never holds an unenforced version, and because the mutation happens before execution there is no post-hoc file churn, no divergence between what the authoring agent believes it wrote and what is on disk, and no rewrite loop.

`edit` calls pass through untouched: an edit fragment has no document context, and rewriting it would both garble structure and break subsequent edit anchoring.

## What is protected mechanically

- **YAML frontmatter** and **fenced code blocks** (``` and `~~~`, unclosed fences included) are cut out before the model call and reinserted verbatim. The model sees `<!-- PE-BLOCK-n -->` placeholder lines; a reply that drops, duplicates, or invents a placeholder is discarded. This is stronger than the upstream reference plugin, which protects code blocks by prompt instruction only.
- **Claim strength** (must/should/may, stated conditions and exceptions) is preserved by the rewrite instruction, matching the Rewrite Contract in `agent/skills/docs-expert/references/style.md`.

## Fail-open contract

Any failure — disabled, ineligible path, prose below `minChars`, document above `maxChars`, missing credential, unknown configured model, provider error, timeout, truncated completion, placeholder mismatch — leaves the original content byte-for-byte and never blocks the turn. Fixable causes (credentials, provider down, truncation) surface once per session via `ctx.ui.notify`; everything else stays silent.

## Settings

`extensionSettings.plainEnglish` — **user layer only** (`~/.pi/agent/settings.json`). The project layer is deliberately ignored: a cloned repository must not be able to enable LLM rewriting of the operator's files, steer which model receives their content, or widen the include globs (same posture as token-meter/ADR-0073 and repo-dash/ADR-0140).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch (inert by default) |
| `model` | `null` | A `"provider/model-id"` string **or an ordered array of them (max 3)** — the fallback chain. Candidates are tried in order; provider-level failures (no credential, error, timeout, truncation, garbled placeholders) advance to the next, document-property failures (`minChars`/`maxChars`) stop the chain. `null`/empty uses the session's active model. Chain order is a trust/cost decision: file content egresses to each provider tried, so there is no implicit fallback beyond what you list |
| `timeoutMs` | `30000` | Rewrite call budget; on expiry the original content is written |
| `minChars` | `200` | Minimum masked-prose size (non-whitespace chars) before a rewrite is attempted |
| `maxChars` | `60000` | Documents with more masked text than this pass through (single completion, no chunking) |
| `include` | `["**/*.md"]` | Eligible paths, relative to the session cwd |
| `exclude` | see below | Never-rewritten paths |

Default excludes: `adrs/**` (decided records are superseded, never edited), `.review/**` (structured artifact-handoff payloads), `NEXT_SESSION*` (session-handoff scratch), `agent/**` (skill/rule/prompt text is deliberate instruction content — the same scope line docs-expert draws), `.worktrees/**`, `.wt_tmp/**`, `node_modules/**`.

Session override: `/plain-english on|off|status` (does not persist).

## Model call

`complete()` from `@earendil-works/pi-ai/compat`, with each candidate's model and credentials resolved through `ctx.modelRegistry` (auto-router's classifier pattern, ADR-0031/0084) and an injectable `completeFn` seam so the whole pipeline unit-tests without a network call. The fallback loop is auto-router's candidate-trial shape: try, advance on provider failure, never block the turn. No raw HTTP to model endpoints; no chunking — one completion per document per attempt (worst case `chain length × timeoutMs`).

## Attribution

The rewrite instruction and the fail-open posture are adapted from [gvzdv/claudish-to-english](https://github.com/gvzdv/claudish-to-english) (MIT, © 2026 Mike Gvozdev), with the anti-pattern vocabulary from docs-expert's Claudish catalogue and mechanical (rather than prompt-only) code-block protection added. See ADR-0142 for the pre-write vs post-write decision record.

## Tests

`./scripts/test-plain-english.sh` — node:test over `test/*.test.ts` with a fake `completeFn`; no network, no extension-deps hydration (pi imports in the tested modules are type-only).
