---
status: Accepted
date: 2026-05-26
---

# ADR-0022: `gh-identity-guard` extension

**Status:** Accepted
**Date:** 2026-05-26
**Tracking issue:** [#250](https://github.com/TheSemicolon/pi_config/issues/250)
**Implementation tracker:** [#252](https://github.com/TheSemicolon/pi_config/issues/252)
**Related:** [ADR-0001](0001-subagent-orchestration-substrate.md) (substrate for `agent/extensions/`), [ADR-0019](0019-compaction-optimizer-extension.md) (precedent for ADR-eligible new extension, `extensionSettings.*` namespace, project-layer-untrusted trust boundary), [ADR-0021](0021-extension-type-checking-and-linting.md) (per-extension `tsconfig.json` + ESLint contract this extension inherits)

## Contents

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
  - [Q1 — Identity source-of-truth](#q1--identity-source-of-truth)
  - [Q2 — Mutation matcher scope](#q2--mutation-matcher-scope)
  - [Q3 — Caching policy](#q3--caching-policy)
  - [Q4 — Failure mode on `gh` unavailable / network failure](#q4--failure-mode-on-gh-unavailable--network-failure)
  - [Q5 — Override mechanism](#q5--override-mechanism)
  - [Q6 — ADR-0021 affirmation](#q6--adr-0021-affirmation)
- [Decision Outcome](#decision-outcome)
- [Contracts We Rely On](#contracts-we-rely-on)
- [Threat Model and Security Posture](#threat-model-and-security-posture)
- [Consequences](#consequences)
- [Staged Delivery](#staged-delivery)
- [Dissent Recorded](#dissent-recorded)
- [Open Questions Deferred](#open-questions-deferred)
- [Pre-implementation Verification (Agent Efficacy)](#pre-implementation-verification-agent-efficacy)
- [More Information](#more-information)

## Context and Problem Statement

`gh auth status` reads an `active` flag from `~/.config/gh/hosts.yml` that can disagree with the actual token used by `gh api` after a `gh auth switch` + refresh. The only authoritative probe of the active identity is `gh api /user --jq .login`. This defect — silent identity drift causing wrong-author writes to GitHub — was filed as [#217](https://github.com/TheSemicolon/pi_config/issues/217) and patched procedurally in [#251](https://github.com/TheSemicolon/pi_config/pull/251):

- New sourceable helper `scripts/lib/gh-verify-user.sh` (`gh_verify_user <login>`) that calls the authoritative probe and exits 0/1/2 per `script-output-conventions.md`.
- Skill-text + wrapper directives on `gh-cli-expert` and `work-item-management-expert` requiring the probe before mutations.
- AGENTS.md repository-layout entry for the new helper.

The procedural fix has the known weakness of every procedural fix in this repo: it relies on subagents reading and following instructions. The repo has already established that **structural enforcement at the tool boundary is the stronger pattern** — `agent/extensions/secrets-guard/` and `agent/extensions/bash-destructive-guard/` are the precedents. Both hook the pi `tool_call` event on the `bash` tool and refuse calls that violate policy, returning an actionable `reason:` string the model can recover from.

This ADR decides the design of a third such guard, `gh-identity-guard`, that intercepts mutating GitHub invocations and blocks on identity drift. Implementation is tracked separately in [#252](https://github.com/TheSemicolon/pi_config/issues/252) and is blocked on this ADR landing as Accepted.

Six design questions enumerated in the tracking issue need to be resolved before implementation. They are answered in [Considered Options](#considered-options) below.

## Considered Options

### Q1 — Identity source-of-truth

| Option | Tamperability | Visibility | Drift surface | Verdict |
|---|---|---|---|---|
| **Q1.A. `.pi/expected-identity` committed at repo root.** Single login per line, multiple lines allowed for repos with legitimate multi-identity workflows. | Same as any committed file — PR review is the control. Changing the expected identity requires a PR, leaving a paper trail. | High (visible in `ls`, in git history, in PR diffs). | Bound to the repo; travels with branches. | **Chosen.** |
| Q1.B. `extensionSettings.ghIdentityGuard.expectedIdentity` in `<cwd>/.pi/settings.json`. | Project-layer settings are treated as untrusted input by repo convention (ADR-0019 § Threat Model). A hostile `<cwd>/.pi/settings.json` could silently spoof the expected identity on `cd` into a malicious repo. | Mixed — settings.json file is reviewed but the field semantics are not as obvious as a dedicated identity file. | Settings-collision risk; mixes identity policy with extension configuration. | Rejected for project layer (untrusted-input precedent); acceptable as **user-layer** fallback only (`~/.pi/agent/settings.json`). |
| Q1.C. `.pi/expected-identity` gitignored. | Per-clone drift; new clones have no guard. | Low (invisible to teammates). | High — silent per-clone divergence. | Rejected. |
| Q1.D. Env var (`PI_EXPECTED_GH_IDENTITY`). | Trivially settable in shell rc; defeats the guard silently if used as source-of-truth. | Low. | High. | Rejected as source-of-truth; accepted as an override surface (see Q5). |
| Q1.E. Derived from `git config remote.origin.url`. | Forks routinely have an owner that is the human, not the bot; defeated by URL rewriting (`url.<base>.insteadOf`). | N/A. | High. | Rejected as primary; usable as a **warn-only cross-check** at `session_start`. |

Precedence chosen:

1. **`./.pi/expected-identity`** at repo root (committed) — primary.
2. **`~/.pi/agent/settings.json`** field `extensionSettings.ghIdentityGuard.expectedIdentity` — user-layer fallback if the per-repo file is absent.
3. **Neither set → fail-closed** at the first mutation with a clear "no expected identity configured" error. The extension does not assume `gh api /user` is correct just because there is no comparison target.

> **Superseded in part by [ADR-0025](0025-gh-identity-guard-interactive-bootstrap.md) (2026-06-07).** Item 3's pure fail-closed terminal state now optionally offers an *interactive bootstrap* — when a controlling terminal (hook) or `ctx.hasUI` (extension) is present, the operator may create `.pi/expected-identity` in place rather than leaving the failed operation. The fail-closed floor is preserved in every non-interactive context (CI, IDE git clients, pipes, print/json), and the triggering operation still fails closed after the write (the operator must commit and re-run). The trust-anchor and code-review-artifact framing of this ADR is unchanged; ADR-0025 only adds a write path, gated on operator presence + re-typed confirmation, and suppresses the suggestion on personal forks.
>
> **Superseded in part by [ADR-0027](0027-gh-identity-guard-tracked-expected-identity.md) (2026-06-07).** The per-repo source remains primary, but both guard halves now trust it only when Git tracks `.pi/expected-identity`; untracked local files are ignored and fall through to the user-layer fallback or fail closed.

`git remote get-url origin` parse is **never** the source-of-truth. It MAY be probed at `session_start` and surfaced as a one-line `ctx.ui.notify(..., "warn")` if the remote-owner pattern disagrees with the declared expected identity. This warning is informational; it does not gate execution.

### Q2 — Mutation matcher scope

Apply detection to each **simple command** extracted from the bash string. A simple command matches if any rule fires.

**Q2.A — `gh <noun> <verb>` table.** Verbs are noun-scoped because `gh project copy` mutates but `gh release download` does not. Match when `argv[0]` (or its basename) is `gh` AND `argv[1]` is a known noun AND `argv[2]` is a mutating verb for that noun. Verb position must be `argv[2]` exactly — verbs appearing in `--search` strings or later positional arguments do not count (false-positive defense).

Noun/verb table (MVP):

| Noun | Mutating verbs |
|---|---|
| `issue` | `create`, `edit`, `close`, `reopen`, `delete`, `comment`, `lock`, `unlock`, `pin`, `unpin`, `transfer`, `develop` |
| `pr` | `create`, `edit`, `close`, `reopen`, `merge`, `ready`, `comment`, `lock`, `unlock`, `review`, `update-branch` |
| `release` | `create`, `edit`, `delete`, `upload`, `delete-asset` |
| `repo` | `create`, `delete`, `edit`, `rename`, `archive`, `unarchive`, `fork`, `sync`, `set-default`, `deploy-key` |
| `project` | `create`, `delete`, `edit`, `close`, `copy`, `link`, `unlink`, `field-create`, `field-delete`, `item-add`, `item-create`, `item-edit`, `item-delete`, `item-archive` |
| `label` | `create`, `edit`, `delete`, `clone` |
| `secret` | `set`, `delete` |
| `variable` | `set`, `delete` |
| `workflow` | `enable`, `disable`, `run` |
| `ruleset` | `create`, `edit`, `delete` |
| `gist` | `create`, `edit`, `delete`, `rename` |
| `auth` | `login`, `logout`, `refresh`, `switch`, `setup-git` |
| `alias` | `set`, `delete`, `import` |
| `cache` | `delete` |
| `run` | `cancel`, `delete`, `rerun` |

`gh pr checkout` is local-only (touches working tree, no push) — **out of scope**.

**Q2.B — `gh api` raw HTTP.** Mutating iff argv contains any of:

- `-X POST|PATCH|PUT|DELETE` (also `-XPOST` no-space form)
- `--method POST|PATCH|PUT|DELETE`
- `-f`, `--field`, `-F`, `--raw-field`, `--input` — these implicitly switch `gh api` to POST when no `-X` is given. Must match.

Bare `gh api <path>` is GET — not mutating.

**Q2.C — `git push` blanket.** Match `argv[0] == "git"` AND `argv[1] == "push"` in **any form**: bare, with refspec, `--delete`/`-d`, `--force`/`-f`/`--force-with-lease`/`--force-if-includes`, `+refspec`, `--mirror`, `--tags`, `--all`, `--follow-tags`, `--atomic`, `--prune`. `--dry-run` short-circuits (see Q2.E).

> **Superseded in part by [ADR-0023](0023-gh-identity-guard-remote-scoping.md) (2026-05-29).** The blanket `git push` match over-blocked pushes to non-`github.com` remotes (Azure DevOps, GitLab, self-hosted), contradicting the documented "github.com remotes only" scope and breaking #265. The classifier still flags every `git push` as a candidate, but the in-session layer now resolves the effective push host and gates only `github.com` (or indeterminate) hosts, matching the pre-push hook. The ssh-asymmetry note in the Threat Model below is likewise refined by ADR-0023 (SSH host-aliases are resolved via `ssh -G`). The rationale in this section is preserved as the original decision record.

`git fetch`, `git pull`, `git clone`, `git commit` — **out of scope**. These are read-only on the remote or local-only; they don't carry gh-identity-attributed mutations. `git commit` author identity (`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`) is an adjacent concern; if relevant, file a follow-up.

**Q2.D — Bypass-DENY net.** If the command string contains any of:

- `bash -c`, `sh -c`, `dash -c`, `zsh -c`, `ksh -c`, `busybox sh -c`
- `eval` (followed by anything)
- `xargs gh`, `xargs git`
- `` ` `` (backtick command substitution) containing a `gh` invocation or `git push`
- `$(` (command substitution) containing a `gh` invocation or `git push`

AND the outer string mentions `gh`/`git push` literally — **force identity verification** (do not outright deny). Outright deny breaks too many legitimate scripts and trains operators to disable the guard. Forcing the identity check is the conservative middle path.

**Q2.E — Short-circuits before any matching.**

- `argv[0]` in skip-list (`echo printf cat less more head tail grep rg ag sed awk jq yq tr wc sort uniq diff man`) → never mutating regardless of content.
- `--help` anywhere in argv → not mutating.
- `--dry-run` anywhere in argv → not mutating.
- Heredoc bodies (`<<EOF ... EOF`) are skipped during tokenization. They commonly contain documented commands.

**Q2.F — Accepted false positive.** `gh api graphql -f query='mutation { ... }'` and `gh api graphql -f query='query { ... }'` both trigger the `-f implies POST` rule, but the first is a real mutation and the second is read-only. Excluding `graphql` from the rule opens a real false-negative (GraphQL mutations transit `-f query=`), so we **accept the false positive** for `query { ... }` payloads. The cost is one identity-probe per GraphQL GET — acceptable.

**Q2.G — Compound-command extraction.** Hand-rolled tokenizer (precedent: `bash-destructive-guard/index.ts`). Split on `&&`, `||`, `;`, `|`, newlines; tokenize each segment respecting `'...'` and `"..."` quoting. Real shell parsers (`mvdan-sh`, `shell-quote`) are deferred — overkill for MVP, and bash-destructive-guard's hand-rolled approach has held up in production.

**Out of MVP scope (documented; accept as gaps):**

- Env-var-constructed command strings (`CMD="gh pr create"; $CMD ...`) — no static analyzer catches this without an interpreter.
- Custom `gh` extensions (`gh my-ext create ...`) — noun won't match the registry.
- Aliased binaries (`mygh`, `cp $(which gh) ./mygh`).
- `gh alias set ship 'pr merge'; gh ship 42` — the alias creation is guarded (`alias set` is in the matcher), but runtime use of the alias is not. Document.
- `curl -X POST -H "Authorization: bearer $(gh auth token)" api.github.com/...` — the token-extraction bypass. Phase-2 consideration: add a `curl`/`xh`/`http` rule keyed on `api.github.com` host + non-GET method.
- `git push` via non-git porcelains (`hub`, `lazygit`, IDE plugins) — `hub` is EOL; TUI tools rare in agent context.
- Adversarial obfuscation (`g""h`, `g\h`, hex-encoded eval).
- TOCTOU between identity check and execution — bounded, ~tens of ms; accepted as a documented threat-model boundary.

### Q3 — Caching policy

**Chosen: per-mutation re-probe, no cross-call cache.**

| Option | Trade-off | Verdict |
|---|---|---|
| **Q3.A. No cache; re-probe on every mutation.** | ~80–150ms cost per mutation against a warm token. Mutations are not high-frequency (units per minute peak). Probe cost is below per-tool-call latency floor. | **Chosen.** |
| Q3.B. Module-scope `{login, fetchedAt}` with ≤30s TTL. | Any cache window is defeated by an out-of-band `gh auth switch` in another shell within that window. Reintroduces the originating bug class (#217). | Rejected. |
| Q3.C. ctx-attached state. | No formal API; `ctx` is event-scoped. | Rejected on contract grounds. |
| Q3.D. `pi.events` bus invalidation. | Bus is for cross-extension messaging, not external system-state invalidation. Cannot observe `gh auth switch` in another shell. | Rejected (does not solve the problem). |

A single-`tool_call`-event-scoped memoization (the classifier may ask "what is the active identity?" more than once per event) is acceptable because it has no cross-event lifetime. Not a cache in any meaningful sense.

### Q4 — Failure mode on `gh` unavailable / network failure

**Chosen: fail-closed across the board.**

Mirrors `secrets-guard`'s posture (`agent/extensions/secrets-guard/README.md`: every blocked rule emits actionable `reason:` text; no fail-open path). Justification table:

| Failure | Behavior | Rationale |
|---|---|---|
| `gh` not on PATH | block | The user is mutating a GitHub remote in a pi session without `gh` installed; no legitimate path forward except installing `gh` or invoking the override. |
| `gh api /user` returns non-zero (network, rate limit, expired token, 5xx) | block | An expired token is a state the user must resolve before mutating. |
| Empty `login` response | block | Matches `scripts/lib/gh-verify-user.sh:71` exit-code semantics. |
| Airplane mode | block | Special case of network failure. Error message hints at override. |

**Carve-out by classifier, not by policy:** read-only `gh` invocations (`gh issue list`, `gh api repos/foo/bar`, etc.) never reach the probe because Q2's classifier doesn't match them. Get the classifier right and fail-closed causes near-zero friction.

Rejected alternative — fail-open-with-warn: regresses to the `gh auth status` silent-drift defect that motivates this guard. A warning the model is free to ignore is not a guard.

### Q5 — Override mechanism

> **Extended by [ADR-0024](0024-gh-identity-guard-inline-skip.md) (2026-05-29).** `SKIP_GH_IDENTITY_GUARD=1` gains a per-command (per-segment) inline form alongside the session-wide one, and the probe-error hint is hardened so it no longer coaches a blocked agent toward disabling the guard. The three-surface model below stands; ADR-0024 records the inline-skip semantics, the SKIP+OVERRIDE ambiguity rule, and the operator-only framing.

**Chosen: three surfaces, all of which announce themselves.**

| Surface | Scope | Visibility | Recommended? |
|---|---|---|---|
| **`SKIP_GH_IDENTITY_GUARD=1` env var** | Whole pi session | Visible in shell history; auditable. Extension loads but installs no `tool_call` handler (mirrors `secrets-guard/index.ts:144-147`). | Yes — primary session-wide override. |
| **`.gh-identity-allowlist` file at repo root** | Per-command-pattern, persistent, version-controlled. One pattern per line; comments with `#`. | Visible in PR review. | Yes — for repos with legitimate dual-identity workflows (e.g., bot + human commits). |
| **`GH_IDENTITY_OVERRIDE=<login>` per-invocation prefix** | Per-invocation, narrowest blast radius | Visible in the tool-call input the model emits; auditable. Override MUST name the alternate identity explicitly — never a generic on/off. | Yes — for one-off cross-identity calls within an otherwise correctly-identitied session. |

**Announcement contract (the override cannot be silent):**

- Session-wide env-var bypass: emit a single `ctx.ui.notify("gh-identity-guard: bypassed via SKIP_GH_IDENTITY_GUARD=1; active identity is <login>", "warn")` at extension init.
- Allowlist hit: per-hit `ctx.ui.notify(..., "info")` naming the matched allowlist line and the actual vs expected identities.
- Per-invocation `GH_IDENTITY_OVERRIDE`: per-hit notify naming both identities.

**Trust-boundary affirmation:** the override is **never** settable from `~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json`. Project-layer settings are untrusted input per ADR-0019. A hostile project setting `ghIdentityGuard.disable: true` would silently neutralize the guard on `cd`.

### Q6 — ADR-0021 affirmation

The extension inherits ADR-0021's contract:

- `agent/extensions/gh-identity-guard/tsconfig.json` copies `agent/extensions/secrets-guard/tsconfig.json` verbatim (the canonical shape).
- `scripts/typecheck-extensions.sh` and `scripts/lint-extensions.sh` auto-discover any directory containing a `tsconfig.json`; no wiring change.
- ESLint v9 + `@typescript-eslint` type-aware rules apply. The load-bearing rule for this extension is **`@typescript-eslint/no-floating-promises`** — the extension `await`s `pi.exec("gh", ...)` chains and a forgotten `await` would silently allow a mutating call through.
- Use the documented `isToolCallEventType("bash", event)` helper (`docs/extensions.md:707-715`) for typed `event.input.command` rather than the `as { command?: string }` cast pattern that pre-dates the helper.

## Decision Outcome

Implement `agent/extensions/gh-identity-guard/` as a fail-closed tool-boundary guard that:

1. Registers a `tool_call` handler on the `bash` tool.
2. Classifies each command via the Q2 matcher (noun/verb table + `gh api` method detection + `git push` blanket + bypass-DENY net + skip-list).
3. On a classifier match, reads the expected identity (precedence Q1: per-repo `.pi/expected-identity` → user-layer `~/.pi/agent/settings.json` → fail-closed).
4. Probes the active identity via `gh api /user --jq .login` (Q3: per-mutation, no cache).
5. If the probe fails (Q4: fail-closed), returns `{ block: true, reason: "<actionable>" }`.
6. If actual ≠ expected (and no allowlist entry / no `GH_IDENTITY_OVERRIDE=<login>` matches), returns `{ block: true, reason: "<actionable, naming both identities and listing override paths>" }`.
7. If `SKIP_GH_IDENTITY_GUARD=1` is set, installs no handler and announces itself via `ctx.ui.notify` at init.

**This ADR is the structural answer that supersedes the procedural fix in #251 as the primary enforcement layer.** The procedural skill text and the `scripts/lib/gh-verify-user.sh` helper survive:

- Skill text becomes "why the guard exists" documentation and belt-and-suspenders for sessions where the extension is disabled.
- The helper remains the right tool for non-pi consumers (git hooks, `setup.sh`, CI, ad-hoc shell).

## Contracts We Rely On

- **`tool_call` event with blocking return shape.** Documented at `docs/extensions.md:691-715`: handler may return `{ block: true, reason: "..." }` to deny execution and surface `reason` to the model. Pi does not re-validate after handler mutation. Verified against pi v0.75.5 docs and the precedent extensions (`secrets-guard/index.ts`, `bash-destructive-guard/index.ts`).
- **`isToolCallEventType("bash", event)` typed-narrowing helper.** Documented at `docs/extensions.md:707-715`. Narrows `event.input` to `{ command: string; timeout?: number }`.
- **`ctx.ui.notify(message, level)` with `ctx.hasUI` gate.** Documented in `docs/extensions.md` § ctx. No-op under `-p`/`--mode json`/RPC.
- **`pi.exec(cmd, args, opts?)` for shelling out to `gh`.** Used by the existing guards as the canonical subprocess API.
- **`extensionSettings.<name>.*` namespace as repo convention** (ADR-0019; pi has no first-party schema-registered settings API yet — tracked upstream as #210).
- **`tool_call` handler ordering across extensions is undocumented.** `docs/extensions.md` documents ordering for `tool_result` (`:744`), `before_provider_request` (`:603`), `after_provider_response` (`:620`), but **not** for `tool_call`. Mutation-chaining language at `:691-715` implies sequential execution in load order but does not name it. **Design guarantee:** `gh-identity-guard`'s behavior is ordering-independent. All three bash guards (`secrets-guard`, `bash-destructive-guard`, `gh-identity-guard`) are deny-only; the worst case from undefined ordering is a redundant block, never a missed block. The `reason:` string is self-contained and does not assume the other guards have or have not run.

## Threat Model and Security Posture

**In-scope (mitigated):**

| Threat | Mechanism |
|---|---|
| Silent-drift wrong-author writes after `gh auth switch` in another shell | Pre-mutation `gh api /user --jq .login` — the only authoritative probe per `scripts/lib/gh-verify-user.sh:7-13`. |
| Mixed-identity sessions where a long-running pi process outlives an identity rotation | Per-mutation re-probe catches the next mutation; the previous one is unrecoverable but bounded. |
| Operator footgun: model asked to "push the fix" while the active gh account is a personal identity instead of the org service account | Expected-identity comparison blocks before `git push` / `gh pr create` lands. |
| Cross-repo identity confusion in a multi-repo workflow | Per-repo `.pi/expected-identity` means the guard's expectation tracks `cwd`. |

**Out-of-scope (explicit non-claims):**

- **Compromised local `gh` token.** If `~/.config/gh/hosts.yml` is attacker-controlled but `gh api /user` returns the expected login, the guard passes. This is an authentication-state guard, not a token-integrity guard.
- **Malicious operator with override.** `SKIP_GH_IDENTITY_GUARD=1` is a deliberate bypass. The threat model assumes a non-malicious operator who may be wrong, not one trying to evade.
- **Subagent shells that don't load the extension.** Per ADR-0001, subagent wrappers compose their own extension allowlists. Mitigation: any subagent wrapper that grants `bash` MUST also load `gh-identity-guard`. Verify in `scripts/validate.sh` as part of #252.
- **Raw shell outside pi.** Out of scope by construction. The companion control surface is a git pre-push hook (analogous to `secrets-guard`'s two-layer design — `agent/rules/secrets-guard.md` § "Two layers of enforcement"). The hook MAY share probe logic via `scripts/lib/gh-verify-user.sh`.
- **`git push` over SSH remotes.** Authenticity is decided by the ssh-agent key, not the active gh identity. The classifier still matches the `git push` (because operator intent — an identity-tied write — is the same), and the guard still verifies the *expected gh identity*, accepting the asymmetry that the *actual* auth path may be ssh. Documented behavioral choice, not a logical guarantee.
- **Tool boundaries other than `bash`.** A hypothetical `gh_tool` custom tool that wraps `gh` API calls in TypeScript would bypass a `bash`-only hook. Mitigation: any new GitHub-mutating custom tool MUST add itself to the guard's handled-tools list (precedent: `agent/extensions/secrets-guard/README.md` § "Tool-call coverage" — explicit carve-in for `artifact_review`).
- **Raw `curl -X POST -H "Authorization: bearer $(gh auth token)" api.github.com/...`** — the token-extraction bypass. Phase-2 work; not blocking for MVP.
- **`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` mismatches.** Out of scope — this guard verifies the *gh CLI authentication identity*, not the *git commit author identity*. Adjacent concern; file a follow-up if relevant.
- **TOCTOU between identity check and execution.** A `gh auth switch` in the ~tens-of-ms window between probe and bash exec is a race. Acceptable; bounded but not zero.
- **The override env var itself.** `SKIP_GH_IDENTITY_GUARD=1` set in `~/.zshrc` or `.envrc` neuters the guard silently. Mitigation: init-time `ctx.ui.notify` announces the bypass at each session start (Q5).
- **Pseudonymous accounts in error messages / compaction archives.** The guard's `reason:` and `ctx.ui.notify` text name both identities. GitHub logins are public; disclosure surface is effectively zero. One-line README note for users running pi under a pseudonymous gh identity.

## Consequences

**Positive:**

- Structural enforcement at the tool boundary — no longer relies on subagents reading and following skill text.
- Closes the `gh auth status` silent-drift defect class (#217) at the strongest available enforcement layer.
- Per-repo expected-identity is itself a code-review artifact (`.pi/expected-identity` requires a PR to change).
- Composes cleanly with the existing two bash guards; ordering-independent by design.

**Negative / cost:**

- ~80–150ms per mutating `gh`/`git push` invocation for the identity probe. Acceptable given mutation frequency.
- Operators must declare expected identity per repo (`.pi/expected-identity`) or fall back to user-layer settings; absence is fail-closed and surfaces an actionable error at the first mutation.
- Adds a third bash-guard extension; debugging "which guard blocked this?" requires reading the `reason:` text (each guard names itself).
- ssh-remote `git push` exhibits a documented asymmetry: the guard checks the expected gh identity even though ssh-agent decides actual auth. Operators in mixed gh+ssh workflows must understand this.

**Neutral:**

- Procedural skill text from #251 stays in place as belt-and-suspenders documentation.
- `scripts/lib/gh-verify-user.sh` remains the canonical helper for non-pi consumers.

## Staged Delivery

This ADR's implementation lands in stages tracked by #252:

1. **Scaffolding** — `agent/extensions/gh-identity-guard/{index.ts,tsconfig.json,README.md}`. Empty handler; `scripts/typecheck-extensions.sh` and `scripts/lint-extensions.sh` clean. Extension loads but blocks nothing.
2. **Classifier + unit tests** — Q2 noun/verb table, `gh api` method detection, `git push` blanket, bypass-DENY net, skip-list, heredoc skipping. Test corpus of ≥35 positive + ≥35 negative commands (canonical set in the research notes attached to #250). Wire into `scripts/validate.sh`.
3. **Identity resolution + probe** — Q1 precedence chain, Q3 per-mutation probe, Q4 fail-closed handling.
4. **Override surfaces** — Q5 env var + allowlist file + per-invocation prefix + announcement notifies.
5. **AGENTS.md + cross-references** — repository-layout block, skill cross-references in `gh-cli-expert` and `work-item-management-expert` ("structural backstop: see `agent/extensions/gh-identity-guard/`"). Subagent-wrapper audit to confirm every wrapper granting `bash` also loads this extension.
6. **Companion git pre-push hook** — out-of-scope for #252; file as follow-up if/when the raw-shell threat-model boundary needs closing.

## Dissent Recorded

Two design-question splits surfaced during pre-implementation research (one `pi-agent-expert` + one `shell-expert` + one `security-review-expert` parallel fan-out per the consensus-by-replication protocol in ADR-0004; aggregation ladder applied):

**Q1 (identity source-of-truth) — 1-1 split.** `pi-agent-expert` recommended `extensionSettings.ghIdentityGuard.expectedIdentity` in project `<cwd>/.pi/settings.json` for consistency with the ADR-0019 settings convention. `security-review-expert` recommended `.pi/expected-identity` committed file, rejecting project-layer settings on the ADR-0019 untrusted-input precedent (a hostile repo could spoof the expected identity by setting it in `<cwd>/.pi/settings.json`). **Orchestrator chose the security recommendation.** Settings.json remains accepted as a *user-layer* fallback (where the trust boundary is the operator's own home directory), but the per-repo file is the primary source-of-truth because it makes identity-policy changes a PR-reviewed event.

**Q3 (caching) — 1-1 split.** `pi-agent-expert` recommended a 30s TTL cache with bypass for high-stakes operations (`git push` to protected branch, `gh pr merge`, `gh api -X DELETE`). `security-review-expert` recommended no cache at all, arguing that any cache window reintroduces the originating defect class (#217) since an out-of-band `gh auth switch` in another shell within the TTL window is exactly the bug this guard exists to close. **Orchestrator chose the security recommendation.** The 100ms-class probe cost is below the per-tool-call latency floor and mutations are not high-frequency.

`shell-expert` Q2-track findings were unanimous with the other reviewers (no dissent on classifier shape; minor `gh api graphql` false-positive flagged and accepted in Q2.F).

## Open Questions Deferred

- **`tool_call` handler-ordering documentation gap.** Should we file an upstream pi documentation request (similar to #211) asking `earendil-works/pi` to document `tool_call` handler ordering parity with `tool_result` / `before_provider_request` / `after_provider_response`? Defer to post-implementation; surface as a follow-up if #252's review uncovers an ordering-dependent edge case.
- **Companion git pre-push hook.** Closes the raw-shell-outside-pi gap. Defer to follow-up; this ADR's scope is the pi extension only.
- **`curl`/`xh`/`http` against `api.github.com`.** Phase-2 classifier extension. Defer.
- **`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` mismatch guard.** Adjacent concern, separate extension. Defer.
- **Backport the "announce-bypass-via-notify" pattern (Q5) to `secrets-guard`.** Strict improvement; surface as a follow-up issue against `secrets-guard` independently of #252.

## Pre-implementation Verification (Agent Efficacy)

Three parallel subagents invoked in one `subagent` call on 2026-05-26 to inform this ADR:

| Specialist | Role | Outcome |
|---|---|---|
| `pi-agent-expert` | Verify pi extension API surface (`tool_call` shape, settings plumbing, caching options, handler-ordering documentation) | PASS. Surfaced three caveats incorporated into the ADR: `tool_call` ordering undocumented (handled in [Contracts](#contracts-we-rely-on)), out-of-band `gh auth switch` defeats any cache (handled in Q3), `extensionSettings.*` is convention not contract (handled by inheriting the ADR-0019 pattern). Corrected the issue-text terminology: the pi event is `tool_call`, not `tool_use_before`. |
| `shell-expert` | Design the mutation classifier (noun/verb table, `gh api` rules, `git push` forms, compound-command handling, bypass vectors) | PASS_WITH_WARNINGS. Q2 design lifted directly from this brief. Warnings (`gh api graphql -f query=` false positive; `gh alias set` runtime-use gap; TOCTOU; compound-command Layer-1 should force identity verification not outright deny) all incorporated into Q2.F, Q2 out-of-scope list, and the Threat Model. |
| `security-review-expert` | Threat model, fail-mode, override design, identity source-of-truth ranking, cache-staleness analysis, log-leak risk, bypass enumeration | Research-mode advisory (no diff under review). Source of the chosen Q1 and Q3 positions (see [Dissent Recorded](#dissent-recorded)). Full threat-model and bypass enumerations adopted into [Threat Model and Security Posture](#threat-model-and-security-posture). |

All three returned Form B per `agent/rules/subagent-parallel-handoff.md`. Aggregation per `agent/rules/consensus-by-replication.md` (orchestrator choice on the two 1-1 splits, dissent documented).

## Addendum 2026-05-27 — Enterprise Managed Users (EMU) login support (#262)

The initial `GH_LOGIN_RE` shipped in #252 admitted only the classic
GitHub username shape (alnum + single internal hyphens, ≤39 chars). In
practice this hard-refused every mutating `gh` call made under an EMU
identity, because EMU logins carry a mandatory `_<shortcode>` suffix
(shortcode = 3–8 alnum chars; e.g. `Example-User_acme`,
`mona-cat_octo`). Per [docs.github.com EMU username considerations][emu]
the full grammar is:

```text
<idp-username>_<shortcode>
```

where `<idp-username>` follows the standard normalization rules
(alnum + single internal dashes, no leading/trailing dash, no
consecutive dashes) and `<shortcode>` is 3–8 alnum chars. Total length
including the underscore is capped at 39 chars on github.com
(30 on GHE.com data-residency).

**Regex change (both layers, kept in sync):**

- `agent/extensions/gh-identity-guard/lib/identity.ts` (TS):

  ```text
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}(?:_[a-zA-Z0-9]{3,8})?$/
  ```

- `hooks/gh-identity-guard.sh` — equivalent POSIX ERE form using a capturing
  group in place of the TS lookahead. The bash hook is its own
  source-of-truth; see `GH_LOGIN_RE=...` in the hook file.

The regex is shape-only and over-permissive on length. The authoritative
39-char total cap is enforced by:

- A `login.length > 39` precheck inside `isValidGhLogin` (TS).
- The pre-existing `[ "${#1}" -le 39 ]` guard inside `is_valid_login` (bash).

**Scope of this addendum:** regex shape only. No change to the guard
policy, trust boundary, override mechanism, or any other contract in
this ADR. Cross-language duplication (TS regex vs. bash regex) is
intentional; the test suites in `agent/extensions/gh-identity-guard/test/`
and `scripts/test-gh-identity-hook.sh` enforce parity. No shared
`isValidLogin` helper extraction is warranted at this time.

[emu]: https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/iam-configuration-reference/username-considerations-for-external-authentication

## More Information

- [#217](https://github.com/TheSemicolon/pi_config/issues/217) — original `gh auth status` drift defect (closed by #251).
- [#251](https://github.com/TheSemicolon/pi_config/pull/251) — procedural bridging fix this ADR structurally supersedes.
- [#250](https://github.com/TheSemicolon/pi_config/issues/250) — this ADR's tracking issue.
- [#252](https://github.com/TheSemicolon/pi_config/issues/252) — implementation tracker (blocked on this ADR; unblocked on merge).
- [#210](https://github.com/TheSemicolon/pi_config/issues/210) — upstream contribution tracker for schema-registered extension settings API (forward-compatibility target for `extensionSettings.*` namespace).
- [#211](https://github.com/TheSemicolon/pi_config/issues/211) — upstream contribution tracker for `CompactionHandler` undefined-return fall-through documentation (precedent for filing the `tool_call` ordering documentation request, if needed).
- `agent/extensions/secrets-guard/` — fail-closed tool-boundary guard precedent.
- `agent/extensions/bash-destructive-guard/` — bash-pattern interception precedent (hand-rolled tokenizer; bypass-DENY net).
- `scripts/lib/gh-verify-user.sh` — sourceable helper that survives this extension; remains the right tool for non-pi consumers.
- `agent/rules/secrets-guard.md` — two-layer enforcement design.
- ADR-0001 — substrate for `agent/extensions/`.
- ADR-0004 — consensus-by-replication (used for pre-implementation verification).
- ADR-0019 — `extensionSettings.<name>.*` namespace and project-layer-untrusted trust boundary.
- ADR-0021 — per-extension `tsconfig.json` + ESLint v9 contract.
- `docs/extensions.md` (pi v0.75.5) — `tool_call` event contract (lines 691–715).
