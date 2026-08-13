# repo-dash — summonable issues/PR panels

First-party pi extension implementing curated feature plan Track 1.2 (#981); design record [ADR-0137](../../../adrs/0137-github-read-core-shared-extraction.md). Interaction model adopted from GitHub Copilot CLI's redesigned terminal interface (triage entry in `notes/upstream-deferred.md`).

## What it does

| Command | Panel |
|---|---|
| `/issues` | Open issues in the current repository |
| `/prs` | Open pull requests in the current repository |

Inside a panel: `↑`/`↓` to move, `Enter` or `c` to insert a reference into the prompt, `Esc` to close. The inserted reference is `#<number> "<title>"` — `#N` is unambiguous within a repository because GitHub shares one numbering space across issues and pull requests, and the title rides along so the model gets context without a tool call.

The reference is **appended** to whatever is already in the editor. `ctx.ui.setEditorText` replaces the entire buffer, so summoning a panel mid-sentence must not discard what the operator had typed.

## It registers no tools

This is the load-bearing constraint, not an omission. repo-dash registers **commands only** — it never calls `pi.registerTool`.

That is now **checked, not merely stated**. `index.ts` carries the declaration line `// PI-EXTENSION-CAPABILITY: no-registerTool`, and `validate.sh` §6b-quinquies fails the build in either direction: if an extension declaring it acquires a real `pi.registerTool(` call site, or if an extension with no call sites drops the declaration. Until #990 this constraint was prose only — which was exactly the failure shape ADR-0137 cited ADR-0088 to avoid. See [ADR-0139](../../../adrs/0139-extension-tool-capability-declaration.md), which also records what the gate deliberately does *not* prove: hooks and `ctx.ui.setEditorText` are separate vectors with separate controls.

The model's GitHub reach therefore stays exactly `github-read`'s typed, domain-gated, opt-in-guarded tools. repo-dash widens what the **operator** can see at a keystroke without widening what the **model** can request. Because both consumers sit on the same `assertReadOnlyPlan` in [`shared/github-read-catalog.ts`](../shared/README.md), the operator-facing path inherits identical argv safety rather than carrying a parallel implementation that could drift.

Every entry point is guarded on `ctx.hasUI` and returns before doing any work when it is false, so `-p`, `--mode json`, and child subagents are unaffected — children always run headless and must never depend on dialogs.

Session off-switch: `PI_REPO_DASH=0` (mirrors `PI_HASHLINE_EDIT=0`).

## Untrusted content

GitHub titles are untrusted, operator-visible content: anyone who can file an issue on a repository the operator browses controls this string. A reference is written straight into the editor buffer, which the operator usually submits verbatim — so the title reaches both the terminal and the model. This carries ADR-0123's untrusted-content posture from the model-facing readers to the operator-facing path.

Sanitizing happens **at the data boundary**, in `toRow`, so a `DashRow` is safe by construction and no sink has to remember to clean it. That placement is the #989 fix: the sanitizer previously ran only on the reference-into-prompt path, leaving `panel.ts` to render raw titles into the terminal — and pi-tui's `truncateToWidth` deliberately *preserves* ANSI sequences and returns short strings byte-for-byte, so escapes in a title reached the terminal intact.

`stripUnsafe` removes, in one code-point scan:

| Class | Treatment | Why |
|---|---|---|
| C0 / C1 controls | → space | `ESC` (the ANSI introducer), `CR`, `BEL` — anything that moves the cursor |
| Unicode `Cf` format characters | deleted | One category covers every threat class: bidi overrides and isolates (Trojan Source), zero-width and default-ignorable formats, and the Tag block (U+E0000–E007F) used to smuggle invisible ASCII into a model's input |
| ZWNJ (U+200C), ZWJ (U+200D) | **kept** | Both are `Cf`, but ZWJ composes emoji sequences and ZWNJ is orthographically required in Persian and the Brahmic scripts |
| Combining marks | run capped at 4 | Diacritics are ordinary content; an unbounded run ("Zalgo") stacks out of its cell and wrecks the panel row |

Whitespace is then collapsed, so a multi-line title cannot forge additional prompt lines. `sanitizeTitle` adds an 80-character bound on top, applied **after** stripping and counted in **code points** — slicing UTF-16 units severed surrogate pairs, and bounding before stripping would spend the budget on invisible payload.

Deliberately not done, and recorded so it is a decision rather than an oversight:

- **No homoglyph or confusable detection, and no NFKC normalization.** NFKC does not address confusables at all — Cyrillic and Latin lookalikes have no compatibility decomposition relating them — while being lossy in ways that corrupt legitimate titles (fullwidth punctuation, ligatures, superscripts). Real anti-spoofing is UTS-39 mixed-script detection with an explicit restriction level: a separate feature with its own policy decision.
- **Accepted residuals.** The quotes in `#N "title"` are presentation, not a boundary — `"` is legitimate title content and is not stripped, so a title containing one breaks the visual quoting. Nothing parses the string, so this is cosmetic. Strong-RTL content also drives the terminal's implicit bidi algorithm with no override character present; stripping that would break every legitimate RTL title.

## Implementation notes

Two pi-tui contracts are load-bearing here and neither is evident from the type signatures. Both were established by reading the runtime, and both are the kind of thing a later refactor would plausibly break:

1. **`Container` does not forward input to its children.** It implements `render` and `invalidate` but has no `handleInput`. A panel that merely extends `Container` renders correctly and is *completely unresponsive*. `RepoDashPanel.handleInput` therefore forwards to the `SelectList` explicitly.
2. **`SelectList.handleInput` only handles up/down/confirm/cancel.** Plain characters pass through untouched — which is precisely what leaves `c` free to act as the reference key without fighting the list's own input handling.

`resolveRepository` hand-builds its `gh repo view` plan rather than using `buildOperationPlan`, because that builder requires the repository this call exists to discover. The plan still passes through `assertReadOnlyPlan` — `["repo", "view"]` is an allowlisted safe prefix — so a shape drift in that vector fails closed like any other.

The shared `runGh` takes no `cwd` argument, so `gh repo view` resolves against the process working directory, which is the session cwd (a worktree under ADR-0120, pointing at the same remote).

## Scope

Phase 1. Deferred to Phase 2: the `/ci` panel and the idle-gated CI-status widget (`ctx.isIdle()` + `ctx.ui.setWidget`). The persistent tab bar is *not* in scope at any phase — pi exposes no persistent layout regions, and FingerTrap phase FT-1 is the primary resolution.

repo-dash is retained **permanently** for headless/SSH sessions even after FingerTrap Home lands, and is a hard gate for FT-1: its data-layer and usage lessons de-risk the native panels.

## Tests

`scripts/test-repo-dash.sh` (wired into `scripts/validate.sh`). The `gh` runner is injected, so no test spawns a subprocess or touches the network. Coverage is deliberately concentrated on the two things that break silently: the title sanitizer (control characters, forged newlines, bounds) and the row mapper (malformed records degrade to fewer rows rather than throwing).
