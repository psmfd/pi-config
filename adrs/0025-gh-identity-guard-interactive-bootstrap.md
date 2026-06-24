---
status: Accepted
date: 2026-06-07
---

# ADR-0025: `gh-identity-guard` — interactive bootstrap of `.pi/expected-identity`

**Status:** Accepted
**Date:** 2026-06-07
**Tracking issue:** [#294](https://github.com/TheSemicolon/pi_config/issues/294)
**Related:** [ADR-0022](0022-gh-identity-guard-extension.md) (the guard's design; §Q1 source-of-truth, §Q4 fail-closed, §Q5 overrides — this ADR supersedes §Q1 item 3 in part), [ADR-0023](0023-gh-identity-guard-remote-scoping.md) (host-scoping), [ADR-0024](0024-gh-identity-guard-inline-skip.md) (inline skip; bypass-DENY-net framing reused here)

## Context and Problem Statement

ADR-0022 §Q1 item 3 decided: **"Neither [identity source] set → fail-closed at the first mutation"** with an actionable error. In practice this terminal state forces the operator to leave the failed push, hand-author `<repo>/.pi/expected-identity`, and retry — a context switch on every fresh clone. #294 asks the guard to *offer to create the file* at that exact terminal state, while preserving the fail-closed floor in every non-interactive context.

The file is a **trust anchor**: it declares who may push to this repo via pi. ADR-0022's Threat Model and Consequences lean on the property that the file "is itself a code-review artifact (`.pi/expected-identity` requires a PR to change)." Turning a read-only, fail-closed guard into one that *writes* that anchor on operator confirmation is a posture change — hence this ADR rather than an edit to ADR-0022.

Two structural hazards shaped the decision (both surfaced by the #294 security review):

1. **Trust-anchor primacy.** A created-but-uncommitted file is immediately load-bearing because both guard halves read it from disk regardless of git-tracked status. Easy interactive creation must not silently become an alternative to PR review for *establishing* write-authorization.
2. **Confused deputy on a suggested default.** "Pre-fill the active gh login when it equals the `origin` owner" is a *plausibility* check, not a *correctness* check. The textbook failure is benign-looking: an operator on personal account `alice` who clones their own fork `alice/forked-repo` gets `alice` suggested and, with a one-keystroke accept, permanently pins a personal account that should never have direct write to the canonical `org/repo`.

## Considered Options

- **A. Decline the feature; keep pure fail-closed-with-guidance.** Rejected: #294's friction is real and recurring on fresh clones; the guard already prints exhaustive guidance that operators must still act on manually.
- **B. Interactive create, file becomes authoritative for the current operation.** Rejected: lets the bootstrap *complete the very push that triggered it* without the trust anchor being committed or the active identity re-verified — collapses "PR-reviewed artifact" to "one `y` at a TTY."
- **C. Interactive create, but the current operation still fails closed (chosen, decision A1).** The bootstrap writes the file, then **blocks/fails the triggering operation** and instructs the operator to commit and re-run. The re-run exercises the real identity probe against the now-present file. On-disk read semantics are unchanged.
- **D. Additionally gate all per-repo reads on git-tracked status (decision A2).** Deferred to [#306](https://github.com/TheSemicolon/pi_config/issues/306) — it changes existing read behavior and could break setups that intentionally keep an uncommitted local pin; it warrants its own decision.

For the suggested default:

- **E. One-keystroke `[y/N]` accept of a pre-filled login.** Rejected (confused-deputy, hazard 2): muscle-memory ENTER pins the wrong account.
- **F. Suggestion is reference-only; operator must re-type the login; suppress any suggestion when `origin` is a personal fork (chosen, decision B1).** The active login and parsed `origin` owner are shown on separate lines; the operator re-types the value; when `gh repo view --json parent` reports a non-null parent (a fork), no default is offered at all.

## Decision Outcome

### Scope and source-of-truth (unchanged from ADR-0022)

- **Per-repo `<repo>/.pi/expected-identity` is the only write target.** The user-layer (`~/.pi/agent/settings.json`) is **not** written by the bootstrap — mutating shared user JSON mixes machine-global config with per-repo trust policy and has no PR-review surface. Resolved open question from #294: per-repo only.
- Project-layer `<cwd>/.pi/settings.json` remains untrusted and is never consulted or written (ADR-0019 / ADR-0022 §Q1.B).
- Non-`github.com` remotes still pass silently with no prompt (ADR-0023).

### Trust-anchor primacy (decision A1)

The bootstrap **never completes the operation that triggered it.** After a successful write:

- **Hook half:** writes the file (atomically), prints the commit instructions, and `exit 1` (fail). The file is not yet committed and the active-identity probe has not run; the operator commits and re-pushes, which exercises the real drift check.
- **Extension half:** writes the file and returns `{ block: true, reason }`. The block reason explicitly states a *human action* completed (file created) and a re-run is required — distinct from the `noExpectedReason()` text so the model does not loop re-issuing the same call.

On-disk read semantics are unchanged; the stronger git-tracked read-gate is [#306](https://github.com/TheSemicolon/pi_config/issues/306).

### Confused-deputy mitigation (decision B1)

- A suggested login is computed only when the active gh login (authoritative `gh api /user --jq .login`, no cache) **equals** the owner parsed from the effective remote URL **and** validates against the GitHub-username regex.
- The suggestion is **suppressed entirely** when the remote is a personal fork (`gh repo view --json parent` non-null / `remote.upstream.url` present).
- The suggestion is **reference-only**: the prompt shows the active login and the parsed owner on separate lines and requires the operator to **re-type** the login. There is no one-keystroke accept of a pre-filled value.
- Any login about to be written is revalidated against the existing helper (`is_valid_login` / `isValidGhLogin`, ≤39 chars, EMU `_<shortcode>` suffix) regardless of provenance. On reject, the raw input is `sanitize()`d before being echoed.

### Interaction surface and fail-closed floor (decision: prompt under presence-of-operator only)

- **Hook half:** prompts only when a controlling terminal is provably attached — open `/dev/tty` and check the open succeeded (`[ -t 2 ] && { exec 3<>/dev/tty; }`); `[ -e ]`/`[ -r ]`/`[ -t 0 ]` are not reliable here because git pipes the ref list on stdin. **All** prompt I/O goes through the opened tty fd, never stdin. A `read -t` timeout bounds an unattended wait. No TTY → today's fail-closed ERROR + `exit 1`, no hang, no stdin read.
- **Extension half:** prompts under `ctx.hasUI` (true in TUI **and** RPC; false in print/json) using `ctx.ui.confirm`/`ctx.ui.input`, with **no `timeout` option** (an RPC `timeout` auto-resolves silently — verified against pi 0.78.1 `docs/rpc.md` extension-ui-protocol). `!ctx.hasUI` → fail-closed block, no prompt.
- **Bypass-DENY-net shapes do not prompt.** When the extension classifier matched via the bypass net (`bash -c`/`eval`/`xargs`/`$()`, `classification.unconditional`), bootstrap is suppressed and the call fails closed — parity with ADR-0024's rule that the net is not defeatable by an outer wrapper. Bootstrap must happen on a clean mutating call.

### Override / bypass ordering (unchanged, made an explicit invariant)

`SKIP_GH_IDENTITY_GUARD=1`, `GH_IDENTITY_OVERRIDE=<login>`, and `git push --no-verify` all short-circuit **before** the no-expected-identity branch in both halves, so none of them ever reach the prompt. This ordering already holds; the implementation carries an explicit invariant comment.

## Consequences

**Positive:**

- Fresh-clone friction is removed for the common interactive case without lowering the fail-closed floor anywhere non-interactive (CI, IDE git clients, pipes, print/json sessions).
- The trust anchor is still established by a committed, PR-reviewable file: the bootstrap writes it but refuses to *use* it for the triggering operation (A1).
- The confused-deputy path is closed by re-type + fork suppression (B1); no muscle-memory accept of a wrong account.

**Negative / accepted gaps:**

- Superseded by [ADR-0027](0027-gh-identity-guard-tracked-expected-identity.md): on-disk reads of an untracked `.pi/expected-identity` are no longer authoritative. The bootstrap still eases creation and still blocks the triggering operation; the operator must `git add`/commit before the file becomes trusted policy.
- Probe-to-write TOCTOU window exists (operator confirms seconds after the probe); bounded and gated by explicit operator confirmation — documented, not mitigated.
- A headless/no-TTY operator gets no bootstrap offer (fail-closed with guidance, as today).

**Neutral:**

- The hook half and the extension half may land in separate PRs; the hook half is independently shippable. This ADR records the decision for both.
- `scripts/lib/gh-verify-user.sh` remains the canonical probe for both halves.

## Pre-implementation Verification (Agent Efficacy)

Three read-only specialists ran in parallel against the proposed design before implementation:

| Agent | Charter | Outcome |
|---|---|---|
| `pi-agent-expert` | Can the extension prompt + write mid-`tool_call` in pinned pi 0.78.1? `ctx.ui` surface, RPC behavior, re-verify pattern | **GO** (PASS_WITH_WARNINGS). `ctx.ui.confirm`/`input` work inside an async `tool_call`, block until answered, prompt in TUI and RPC under `ctx.hasUI`; `fs.writeFileSync` from the handler is safe and non-reentrant. Conditions adopted: omit `timeout`, re-resolve+re-probe after write, decline/cancel/no-UI → block. |
| `shell-expert` | Pre-push hook interactive create path: `/dev/tty` discipline, TTY detection, fail-closed-on-no-TTY, single-attempt validation, exit code after write | PASS_WITH_WARNINGS. Authoritative tty test (`[ -t 2 ] && exec 3<>/dev/tty`), all I/O off stdin, suggestion-as-confirm (bash 3.2 has no editable prefill), `exit 1` after write. Folded in: `read -t 60`-bounded prompts, best-effort `timeout`-wrapped suggestion probes (where `timeout` is available; plain call + operator Ctrl-C otherwise), atomic tmp+`mv` write. |
| `security-review-expert` | Threat model of writing a trust anchor on confirmation; suggested-default safety; ADR posture | NEEDS_CHANGES → constraints adopted: A1 commit-gate framing, B1 re-type + fork suppression, bypass-net suppression, unconditional input revalidation, atomic write, model-loop-safe block reason, and **this new superseding-in-part ADR**. |

## More Information

- [#294](https://github.com/TheSemicolon/pi_config/issues/294) — feature request and acceptance criteria.
- [#306](https://github.com/TheSemicolon/pi_config/issues/306) — deferred A2 git-tracked read-gate.
- [ADR-0022](0022-gh-identity-guard-extension.md) §Q1 item 3 (superseded in part here), §Threat Model, §Q5 overrides.
- `hooks/gh-identity-guard.sh`, `agent/extensions/gh-identity-guard/` — the two guard halves.
- `scripts/lib/gh-verify-user.sh` — authoritative active-account probe.
