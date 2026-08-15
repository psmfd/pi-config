# repo-dash — summonable issues/PR/CI panels and a CI widget

First-party pi extension implementing curated feature plan Track 1.2 (#981, #987); design records [ADR-0137](../../../adrs/0137-github-read-core-shared-extraction.md) (panels and the shared read core) and [ADR-0140](../../../adrs/0140-repo-dash-ci-widget.md) (the widget). Interaction model adopted from GitHub Copilot CLI's redesigned terminal interface (triage entry in `notes/upstream-deferred.md`).

## What it does

| Command | Panel |
|---|---|
| `/issues` | Open issues in the current repository |
| `/prs` | Open pull requests in the current repository |
| `/ci` | Recent workflow runs in the current repository |
| `/ci widget [on\|off\|status]` | Control the CI-status widget (see below) |

Inside a panel: `↑`/`↓` to move, `Enter` or `c` to insert a reference into the prompt, `Esc` to close. For issues and pull requests the reference is `#<number> "<title>"` — `#N` is unambiguous within a repository because GitHub shares one numbering space across the two, and the title rides along so the model gets context without a tool call.

Workflow runs use `run <id> "<title>"` instead, and the difference is not cosmetic. Runs are **outside** that shared numbering space, so `#N` would point the model at an unrelated issue. `run_number` is no better: each workflow keeps its own counter, so it is not unique within a repository, and it is the wrong key downstream — `github-read`'s Actions `run` operation builds `actions/runs/{id}`, so a `run_number` reference would send a follow-up lookup to a different run or a 404. The run **id** is the only handle that is both unambiguous and correct.

The reference is **appended** to whatever is already in the editor. `ctx.ui.setEditorText` replaces the entire buffer, so summoning a panel mid-sentence must not discard what the operator had typed.

## It registers no tools

This is the load-bearing constraint, not an omission. repo-dash registers **commands only** — it never calls `pi.registerTool`.

That is now **checked, not merely stated**. `index.ts` carries the declaration line `// PI-EXTENSION-CAPABILITY: no-registerTool`, and `validate.sh` §6b-quinquies fails the build in either direction: if an extension declaring it acquires a real `pi.registerTool(` call site, or if an extension with no call sites drops the declaration. Until #990 this constraint was prose only — which was exactly the failure shape ADR-0137 cited ADR-0088 to avoid. See [ADR-0139](../../../adrs/0139-extension-tool-capability-declaration.md), which also records what the gate deliberately does *not* prove: hooks and `ctx.ui.setEditorText` are separate vectors with separate controls.

The model's GitHub reach therefore stays exactly `github-read`'s typed, domain-gated, opt-in-guarded tools. repo-dash widens what the **operator** can see at a keystroke without widening what the **model** can request. Because both consumers sit on the same `assertReadOnlyPlan` in [`shared/github-read-catalog.ts`](../shared/README.md), the operator-facing path inherits identical argv safety rather than carrying a parallel implementation that could drift.

Every entry point is guarded on `ctx.hasUI` and returns before doing any work when it is false, so `-p`, `--mode json`, and child subagents are unaffected — children always run headless and must never depend on dialogs.

Session off-switch: `PI_REPO_DASH=0` (mirrors `PI_HASHLINE_EDIT=0`).

## Untrusted content

GitHub titles are untrusted, operator-visible content: anyone who can file an issue on a repository the operator browses controls this string. A reference is written straight into the editor buffer, which the operator usually submits verbatim — so the title reaches both the terminal and the model. This carries ADR-0123's untrusted-content posture from the model-facing readers to the operator-facing path.

Sanitizing happens **at the data boundary**, in `toRow` and `toRunRow`, so a `DashRow`/`DashRunRow` is safe by construction and no sink has to remember to clean it. That placement is the #989 fix: the sanitizer previously ran only on the reference-into-prompt path, leaving `panel.ts` to render raw titles into the terminal — and pi-tui's `truncateToWidth` deliberately *preserves* ANSI sequences and returns short strings byte-for-byte, so escapes in a title reached the terminal intact.

`stripUnsafe` removes, in one code-point scan:

| Class | Treatment | Why |
|---|---|---|
| C0 / C1 controls | → space | `ESC` (the ANSI introducer), `CR`, `BEL` — anything that moves the cursor |
| Unicode `Cf` format characters | deleted | One category covers every threat class: bidi overrides and isolates (Trojan Source), zero-width and default-ignorable formats, and the Tag block (U+E0000–E007F) used to smuggle invisible ASCII into a model's input |
| ZWNJ (U+200C), ZWJ (U+200D) | **kept** | Both are `Cf`, but ZWJ composes emoji sequences and ZWNJ is orthographically required in Persian and the Brahmic scripts |
| Combining marks | run capped at 4 | Diacritics are ordinary content; an unbounded run ("Zalgo") stacks out of its cell and wrecks the panel row |

Whitespace is then collapsed, so a multi-line title cannot forge additional prompt lines. `sanitizeTitle` adds an 80-character bound on top, applied **after** stripping and counted in **code points** — slicing UTF-16 units severed surrogate pairs, and bounding before stripping would spend the budget on invisible payload.

For workflow runs the same rule picks out four attacker-influenced fields: `display_title` (a commit message or PR title), the run `name` (settable per run via a workflow's `run-name:`, which routinely interpolates that same text), `head_branch` (named by whoever pushes the branch or opens the fork PR), and the actor login. Statuses, conclusions, events, ids, and timestamps are fixed vocabularies and are left alone rather than nominally cleaned.

Deliberately not done, and recorded so it is a decision rather than an oversight:

- **No homoglyph or confusable detection, and no NFKC normalization.** NFKC does not address confusables at all — Cyrillic and Latin lookalikes have no compatibility decomposition relating them — while being lossy in ways that corrupt legitimate titles (fullwidth punctuation, ligatures, superscripts). Real anti-spoofing is UTS-39 mixed-script detection with an explicit restriction level: a separate feature with its own policy decision.
- **Accepted residuals.** The quotes in `#N "title"` are presentation, not a boundary — `"` is legitimate title content and is not stripped, so a title containing one breaks the visual quoting. Nothing parses the string, so this is cosmetic. Strong-RTL content also drives the terminal's implicit bidi algorithm with no override character present; stripping that would break every legitimate RTL title.

## Workflow runs: status is not conclusion

A `completed` run can be a failure. `status` says whether a run finished; `conclusion` says how, and is `null` until it has. Collapsing the two — mapping `conclusion` onto the `state` field the issue/PR rows use — would discard exactly the bit an operator is scanning for.

`run-status.ts` owns the single derivation (`deriveRunOutcome`) that both the `/ci` panel and the CI widget consume. Two independent derivations would eventually disagree about the same run, and the disagreement would surface as a widget claiming success next to a panel row that says otherwise. A completed run whose conclusion is `null` or a value the module has never seen resolves to `unknown`, never `success` — GitHub has added conclusions before (`startup_failure`), and failing open there would paint a green marker on an unreported result.

The Actions API also wraps its list as `{ total_count, workflow_runs: [...] }` rather than returning a bare array, so `toRunRows` unwraps before mapping. Reusing the issue/PR `Array.isArray` guard would have yielded an always-empty panel with no error.

## Implementation notes

Two pi-tui contracts are load-bearing here and neither is evident from the type signatures. Both were established by reading the runtime, and both are the kind of thing a later refactor would plausibly break:

1. **`Container` does not forward input to its children.** It implements `render` and `invalidate` but has no `handleInput`. A panel that merely extends `Container` renders correctly and is *completely unresponsive*. `RepoDashPanel.handleInput` therefore forwards to the `SelectList` explicitly.
2. **`SelectList.handleInput` only handles up/down/confirm/cancel.** Plain characters pass through untouched — which is precisely what leaves `c` free to act as the reference key without fighting the list's own input handling.

`resolveRepository` hand-builds its `gh repo view` plan rather than using `buildOperationPlan`, because that builder requires the repository this call exists to discover. The plan still passes through `assertReadOnlyPlan` — `["repo", "view"]` is an allowlisted safe prefix — so a shape drift in that vector fails closed like any other.

The shared `runGh` takes no `cwd` argument, so `gh repo view` resolves against the process working directory, which is the session cwd (a worktree under ADR-0120, pointing at the same remote).

## The CI widget

Off by default. Design record: [ADR-0140](../../../adrs/0140-repo-dash-ci-widget.md).

| Enable | Scope |
|---|---|
| `extensionSettings.repoDash.ciWidget: true` in `~/.pi/agent/settings.json` | Persistent |
| `/ci widget on` | This session only |

The settings key is read from the **user layer only** — a deliberately stronger exclusion than token-meter's (ADR-0073). This toggle starts *standing network activity*, so a project-layer switch would let any cloned repository begin polling the GitHub API against the operator's token on session start. A malformed or unreadable settings file resolves to off; an opt-in feature must never be enabled by a parse failure.

```text
CI  + validate · x tests · > codeql
    dev · 2m ago
```

This is the extension's **first standing background activity** — everything else runs only on a keystroke — so the parts that decide whether `gh` is spawned at all live in `widget.ts` behind injected `now`/`isIdle`/`load` seams, and are tested against a fake clock:

- **Never during a turn.** `ctx.isIdle() && !ctx.hasPendingMessages()`. The second conjunct matters as much as the first: between a queued message being accepted and the next agent loop starting, the session is momentarily "idle" while being anything but.
- **Never overlapping.** A single-flight guard, so a slow `gh` cannot accumulate children as the interval keeps firing.
- **60 seconds, as a floor rather than a period.** 60 polls/hour is 1.2% of GitHub's 5000/hour authenticated limit — the same budget `github-read`'s model-facing tools draw on. The `agent_settled` edge trigger shares the same eligibility check, so a long turn is followed by an immediate refresh while a burst of short turns cannot poll faster than the floor.
- **`agent_settled`, not `agent_end`.** `agent_end` fires while an automatic retry, compaction, or queued continuation may still run, so polling there lands mid-work — a silent failure of the idle gate.
- **Backoff on every failure**, not only 403/429: telling them apart means parsing `gh` stderr, and the blunt rule's cost is slow recovery while the alternative's is hammering an endpoint already refusing us.

Degradation is deliberate. Before the first successful poll the widget renders **nothing**, reserving no vertical space rather than flashing a placeholder. On failure it keeps the last snapshot and marks it `stale` rather than blanking — an empty widget reads as "CI is fine", which is the one thing it must not imply.

**Widget content does not reach the model.** Verified against the runtime: `setExtensionWidget` touches only the widget maps and `renderWidgets()`, never `appendEntry` or the system prompt. So untrusted `display_title` here is an ANSI and layout hazard, not a prompt-injection vector — a different threat model from the reference-into-prompt path. Sanitization is still inherited from `toRunRow` at the data boundary; the widget adds only width bounds (names clipped to 20 code points, ASCII-only glyphs). This property is **not** mechanically gated — ADR-0139's §6b-quinquies checks `pi.registerTool` call sites and nothing else — and is a point-in-time reading a pin bump could invalidate.

### Branch scoping

The widget is scoped to the session's branch ([ADR-0141](../../../adrs/0141-repo-dash-branch-scoped-ci-widget.md), #1005). This matters more than it first appears: ADR-0120 puts **every pi session in its own worktree**, so without scoping one session routinely shows another session's CI results.

`git-branch.ts` runs `git rev-parse --abbrev-ref HEAD`. That is repo-dash's second subprocess — the first being the argv-gated `gh` path — so the claim that survives is the narrower one: *every GitHub read* goes through `assertReadOnlyPlan`. Three properties keep the addition narrow:

- **The argv is a constant.** Nothing interpolated. The concern behind `assertReadOnlyPlan` is argv *construction*; there is none here to get wrong.
- **Every failure is soft.** Not a repository, no `git` on PATH, detached HEAD (`--abbrev-ref` prints the literal `HEAD`), timeout, or a name outside GitHub's ref grammar all yield `undefined` and fall back to the repository-wide view, which stays live as the fallback rather than becoming dead code. stderr is discarded, so a non-repository session is silent.
- **It runs once per session**, cached beside the repository, never on the polling path. The cache is keyed on a resolved *flag*, not on the value being non-`undefined` — an unscopable session legitimately resolves to `undefined`, and without the flag that would re-spawn `git` on every poll forever.

`REF_RE` is mirrored from `shared/github-read-validation.ts` rather than imported, because `validateRef` **throws** — and a throw on this path would show a permanently unavailable widget for a branch name that is legal in git but outside GitHub's accepted shape. Keep the two patterns in lockstep.

A scoped widget with no runs says `no recent runs for <branch>` and deliberately does **not** fall back to the repository-wide list: doing so would show another session's runs under a widget the operator now reads as scoped, silently reintroducing the confusion scoping removes.

Only the widget is scoped. The **`/ci` panel stays repository-wide** — it is a browser for referencing *any* run into the prompt, including one on another branch, and that is a different question from the widget's ambient "how is my current work doing".

Reading `.git/HEAD` instead (zero subprocess) was rejected on evidence: under ADR-0120 a session's `.git` is a *file* pointing at `…/.git/worktrees/<name>`, so worktree gitdir resolution is the **normal** path, with `GIT_DIR`, bare repos, and parent-directory discovery still unhandled after that. `rev-parse` gets all of it right.

## Scope

Phases 1 and 2 complete. The persistent tab bar is *not* in scope at any phase — pi exposes no persistent layout regions, and FingerTrap phase FT-1 is the primary resolution.

repo-dash is retained **permanently** for headless/SSH sessions even after FingerTrap Home lands, and is a hard gate for FT-1: its data-layer and usage lessons de-risk the native panels.

## Tests

`scripts/test-repo-dash.sh` (wired into `scripts/validate.sh`). The `gh` runner is injected, so no test spawns a subprocess or touches the network. Coverage is deliberately concentrated on what breaks silently: the title sanitizer (control characters, forged newlines, bounds), the row mapper (malformed records degrade to fewer rows rather than throwing), and the widget's poll policy.

The widget tests inject the clock as well as the loader, so the cases that matter most and are least observable by hand are asserted directly: 101 settle events across 100 seconds yield exactly 2 polls; a slow load does not accumulate overlapping children; a load resolving after `stop()` does not repaint a torn-down widget; and a failed poll retains the prior snapshot instead of blanking.
