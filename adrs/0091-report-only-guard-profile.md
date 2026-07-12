---
status: Accepted
date: 2026-07-12
---

# ADR-0091: Report-only guard profile — mechanical enforcement of the linter wrapper's report-only contract

**Status:** Accepted
**Date:** 2026-07-12
**Related:** [ADR-0082](0082-linter-stays-on-session-default.md) (the #535 evaluation that surfaced both gaps), [ADR-0072](0072-guardfall-shell-injection-hardening.md) (the guard's threat-model framing this profile inherits), #551 (the feature), #554 (the path-handling investigation resolved alongside), #506/#507 (the structurally sound boundaries this is not)

## Context and Problem Statement

The `linter` subagent wrapper is contractually **report-only**, but `mode:
read-only` only gates pi's structured Write/Edit tools — its `bash` tool can
still shell out a mutating linter. The #535 matched-pair evaluation
(ADR-0082) showed a fix-framed task instruction ("run the linters and fix the
trivial issues") defeating the prose-only contract on a bash-capable model:
one run rewrote the target file via a **relative in-cwd path with no guard
signal at all** (`cat > transform.py` — inside `bash-destructive-guard`'s
blast-radius threat model, so legitimately ungated), and another hit the
guard on an absolute path, then followed the guard's **own advertised
remediation** (`SKIP_DESTRUCTIVE_GUARD=1`) to finish the mutation.

The same evaluation exposed a real bug in the guard's path comparison
(#554 Observation B): `isUnderSafePath` was a raw string-prefix check, so on
macOS a `/var/folders/…` spelling never matched the safe list's canonical
`/private/var/folders/…` cwd entry — a false deny for a path genuinely
inside the safe cwd, and the proximate trigger for the model reaching for
the advertised override.

Three questions needed one coherent answer: (a) how to make the report-only
contract mechanical rather than prose; (b) whether the general guard should
gate in-cwd overwrites (#554 Observation A); (c) how to fix the
canonicalization bug without changing the guard's posture.

## Considered Options

1. **Guard profile in `bash-destructive-guard`, signaled per-wrapper via
   spawn-time env** — a `guard-profile: report-only` frontmatter key on the
   wrapper; the subagent spawn path exports `PI_GUARD_PROFILE=report-only`
   into the child env; the guard, when the var is present at load time,
   adds a linter-scoped mutation rule set on top of its general rules.
2. **Spawn-path command filter** — enforce in the subagent extension
   itself. Rejected: the spawn path never sees the child's bash commands;
   only the in-child `tool_call` hook has command visibility.
3. **Widen the general guard to gate in-cwd overwrites for everyone** —
   resolve #554 Observation A by distinguishing overwrite-of-tracked-file
   from create-new. Rejected: unrestricted in-workspace writes are normal
   for a general coding agent; the general guard's threat model is
   blast-radius isolation *outside* the workspace. Gating in-cwd writes
   globally would train every agent on false denials — exactly the
   ADR-0082 failure mode. The in-cwd write gate belongs to the report-only
   profile, where the contract genuinely forbids all writes.
4. **Prose-only reinforcement** — strengthen the wrapper text. Rejected:
   #535 demonstrated empirically that prose loses to fix-framed task
   wording.

## Decision Outcome

Chosen option: **1** (with option 3's question resolved as "profile-scope,
not general-scope").

- **Canonicalization fix (#554 B):** safe-list entries and absolute targets
  are canonicalized (`realpathSync`; nonexistent targets resolve via their
  nearest existing ancestor) before the prefix comparison
  (`bash-destructive-guard/paths.ts`). Fail-open on resolution error —
  identical posture to the pre-fix string comparison. The failing-then-
  passing test matrix showed the pre-fix check also **under-blocked** the
  reverse shape (a symlink inside cwd pointing at an out-of-safe-list dir
  passed on its cwd spelling); canonical-form comparison closes that escape.
- **Observation A (#554):** the general guard keeps relative/in-cwd writes
  ungated — now stated explicitly in its header — and the report-only
  profile owns the in-cwd write gate.
- **Profile signal:** `guard-profile: report-only` frontmatter (today:
  `agent/agents/linter.md`) → subagent LOCAL PATCH #7 exports
  `PI_GUARD_PROFILE=report-only` with set-or-delete semantics (never
  inherited; only the recognized value exported). Parent-controlled at
  spawn, so the child cannot un-certify itself.
- **Profile rules (`bash-destructive-guard/report-only.ts`):** deny
  mutating flags on any verb (word-level, wrapper-payload aware), in-place
  editors (`sed -i`, `perl -i`, `gofmt/shfmt -w`), default-write formatters
  without their check flag (`ruff format`, `dotnet format`, `black`,
  `rustfmt`, `cargo fmt`), ANY redirect or file-mutation verb targeting a
  non-`/tmp` path (relative in-cwd included — the #535 hole), git mutations
  (read-only subcommand allowlist), package managers, exec-wrappers whose
  token words name a mutating verb (`eval 'sed -i …'`, `sudo tee`,
  `xargs chmod` — the shared `WRAPPER_VERBS` set, extracted to
  `policy-verbs.ts`), `find -delete` / `find -exec <mutating verb>`
  regardless of root, and the interpreter bypass shapes. `/tmp` scratch
  writes stay allowed so linters can work. The wrapper/find rules were
  added after requirement-fidelity review caught the verb-position-only
  first cut letting wrapper-routed mutations through — including a
  fallthrough to the general guard's Rule 2 whose deny text advertises
  `SKIP_DESTRUCTIVE_GUARD=1`; as belt-and-braces, any general-rule denial
  that fires while the profile is active has override advertisements
  scrubbed from its message (`sanitizeGeneralDenyForProfile`). Wrapper
  handling is two-class: flag-free transparent prefix wrappers
  (`sudo`/`env K=V`/`timeout 60`/…) recurse so the full conditional rule
  set evaluates the real verb (`timeout 60 ruff check` stays allowed);
  opaque wrappers (`eval`/`xargs`/…) — and any transparent wrapper
  carrying a dash-flag, since a value-consuming flag (`sudo -u <user>`)
  would misparse its value as the wrapped verb — take a fail-closed
  word-scan against the wide `WRAPPED_DENY_WORDS` set, with direct
  invocation as the documented recovery.
- **Override posture (the ADR-0082 lesson):** profile deny messages
  advertise **no self-service override** — remediation is "report findings;
  the orchestrator applies fixes." `SKIP_DESTRUCTIVE_GUARD=1` bypasses the
  general rules but deliberately does **not** disable the profile (announced
  at session start): SKIP waives the blast-radius guard, not the wrapper's
  contract. Legitimate exits: the orchestrator spawns a wrapper without the
  frontmatter key, or the operator edits the wrapper.

### Consequences

- Good: the #535 mutation shapes (fix flags, relative clobber, SKIP-assisted
  absolute clobber) are all mechanically denied for the linter regardless of
  task wording or which model the wrapper runs on.
- Good: the false-deny that taught the model to reach for SKIP is fixed at
  the root (canonicalization), shrinking the guard's owned failure surface.
- Neutral: the profile is opt-in per wrapper; other read-only review
  wrappers (`code-review-expert`, `security-review-expert`) have no `bash`
  tool, so `linter` is the only consumer today.
- Bad (accepted): same non-adversarial threat model as the parent guard —
  ANSI-C quoting, variable indirection, runtime-decoded payloads, and
  second-interpreter files (`make lint` whose recipe rewrites sources)
  evade it. The sound boundary remains #506 (AST second pass) / #507
  (OS-level sandbox). The rule set is also tool-focused, not exhaustive:
  an unlisted mutating tool invoked without a recognized flag passes; the
  set grows as gaps surface.

## More Information

The profile reads `PI_GUARD_PROFILE` at extension load time: the value is
fixed by the parent before the child process starts, so an in-session
`export` cannot change it. `npx` is the sanctioned launcher shape (its
wrapped tool's flags are still scanned); `npm`/`yarn`/`pnpm`/`pip`/`bun`
verbs are denied wholesale because `run`/`install` execute opaque scripts.

Post-review hardening (three-way review fan-out on the PR): the wrapper/find
rules and the general-deny message scrub came from `code-review-expert`'s
requirement-fidelity pass; `security-review-expert` added the quoted-payload
redirect denial (`eval 'cat > transform.py'` — the literal #535 shape routed
through a wrapper), wrapper-carried interpreter denial, short-flag in-place
editors (`autopep8`/`yapf`/`clang-format -i`), `terraform fmt`/`go fmt`/
`swiftformat` default-write coverage, `bun`, removal of `branch`/`remote`/
`config` from the git allowlist (`git config --file <path>` is an
arbitrary-file write), and the value-flag operand fix that prevented
`chmod 644 /tmp/x`-style false denials.

**Accepted gap (tracked as #671):**
a project-scoped `.pi/agents/linter.md` can shadow the user-level profiled
wrapper and omit the frontmatter key, silently disarming enforcement when
the interactive project-agent confirmation is skipped (headless). The
"parent-controlled" property assumes the wrapper definition itself is
trusted; hardening options are enumerated in the issue.
