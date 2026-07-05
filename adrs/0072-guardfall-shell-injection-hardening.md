---
status: Proposed
date: 2026-07-04
---

# ADR-0072: GuardFall shell-injection hardening — extension placement, shared lexer, and destructive-flag scope

**Status:** Proposed
**Date:** 2026-07-04
**Tracking issue:** #504
**Related:** [ADR-0030](0030-shared-foundation.md) (the `shared/` foundation this extends), [ADR-0065](0065-inline-shared-modules-for-coupled-extension-mirrors.md) (inline-coupling this triggers for `pi-bash-destructive-guard`), [ADR-0021](0021-extension-type-checking-and-linting.md) (per-extension tsconfig + ESLint contract), [ADR-0038](0038-psmfd-pi-build-and-attest-trust-boundary.md) + [ADR-0041](0041-conditional-security-patch-divergence.md) (why the core-fork path is not used), [ADR-0071](0071-secret-pattern-lockstep-reconciliation.md) (cross-copy lockstep precedent relevant to the deferred `secrets-guard` follow-up)

## Context and Problem Statement

Adversa AI's ["GuardFall"](https://adversa.ai/blog/opensource-ai-coding-agents-shell-injection-vulnerability/) describes a class of bypasses that defeat string-inspection shell guards in AI coding agents: the guard inspects the raw command text, but bash expands, unquotes, and rewrites that text before executing it. Five bypass classes are enumerated:

- **A — Quote-splitting:** `r''m` reads as two tokens to a matcher but bash joins it to `rm`.
- **B — Variable/IFS expansion:** `rm$IFS-rf$/` (or the generic `X=' '; rm$X-rf /`) splits into multiple args at runtime.
- **C — Command substitution:** `$(echo rm) -rf /` hides the binary name; the glued form `r$(true)m` reconstructs `rm` inside one word.
- **D — Piped decode:** `echo <b64> | base64 -d | sh` — no dangerous token is present in plaintext.
- **E — Destructive flags with no danger keyword:** `find /x -delete`, `dd of=/dev/sda`, `truncate -s 0 f`, bare `>` clobber.

This repo already ships the guard the article critiques: `agent/extensions/bash-destructive-guard/` is a fail-closed pi extension hooking the `tool_call` event on the `bash` tool, using a hand-rolled quote-aware lexer. A three-agent research fan-out (shell-expert, security-review-expert, code-review-expert) assessed the shipped guard against the five classes. Findings:

1. **Classes A and B (literal `$IFS`) are already closed** by the existing lexer, and Class C's *un-glued* substitution case is handled (substitution bodies become their own validated segments). This is real, verified-in-code coverage, not aspiration.
2. **Two live, exploitable gaps exist in the shipped guard**, found independently by two agents:
   - **Class D pipe-sink:** the shell-interpreter rule fires only on `<`/`<<`/`<<<` redirection or `-c` (`seg.readsInput || hasMinusC(tokens)`). A pipe into a bare interpreter — `echo <b64> | base64 -d | sh` — is **not** detected, because `|` resets `readsInput` on the downstream segment. This is the textbook `curl | bash` shape and is unblocked today.
   - **Class C glued substitution:** `r$(true)m` lexes as two harmless fragments (`r$`, `m`) because every `(`/`)`/backtick unconditionally ends a token; the lexer has no notion of a *word* spanning a substitution boundary, so it never reconstructs the `rm` that bash produces.
3. **Class E is out of scope by construction** — only `rm`/`mv` are path-checked. `find -delete`, `dd of=`, `truncate`, and bare `>` clobber all pass; there is not even a structural hook (`writesOutput`) on which to hang a redirection check.
4. **A residuum is provably unclosable by any static string analysis** — the generic Class B case (a `$VAR` whose value contains whitespace), the value-dependent half of Classes C/D (substitution/decode output that only exists after execution), and **file-content indirection** (a malicious `Makefile`/`package.json` script the agent runs via `make test`, where the destructive verb lives in a file `make` reads and never appears in the string pi hands the guard). These require a control *below* the shell, not a better lexer.

The problem this ADR resolves: **where should the hardening live, how far can the extension layer go, and what must be explicitly deferred to an OS-level control** — while satisfying the operator requirement to develop and prove the fix locally before any upstream submission.

## Considered Options

### Q1 — Placement: pi extension vs. fork of the `psmfd/pi` runtime

| Option | Verdict |
|---|---|
| **Q1.A — Harden as a pi extension** (the established pattern: `secrets-guard`, `gh-identity-guard`, `bash-destructive-guard` all hook `tool_call` and return `{block, reason}`). | **Chosen.** Classes A–E are all decidable (or not) from the command string pi hands the `bash` tool — the exact artifact the extension already receives. A fork grants no additional visibility at this layer: pi still passes a *string* to bash either way. Fully iterable locally under `agent/extensions/` + `scripts/validate.sh`, zero upstream dependency. |
| Q1.B — Carry the change as a source patch in the `psmfd/pi` mirror. | Rejected. ADR-0038 makes the mirror zero-divergence by default; ADR-0041 sanctions divergence **only** for a CVE/CodeQL fix with no upstream patch in flight. A defensive feature guard layered on top of pi does not qualify; using the fork path would require stretching that exception or a new divergence-class ADR — a heavier governance lift for no capability gain. |
| Q1.C — Build the sound defense (execve/syscall interception, `$HOME` scoping, sandbox) now. | Deferred, not rejected — filed as #507. This is the *only* sound defense against a deliberate adversary and against the file-content-indirection class, but it is a launcher/wrapper concern (how pi's bash tool is spawned — `bwrap`/`nsjail`/container/`$HOME` redirection + egress control), **not** a `tool_call` extension and **not** necessarily a pi source fork. |

### Q2 — Harden in place vs. extract the lexer to `shared/` vs. new sibling extension

| Option | Verdict |
|---|---|
| **Q2.A — Extract the general shell-lexing primitive into `agent/extensions/shared/shell-lex.ts`; keep policy (verb sets, path-safety, safe-list) in `bash-destructive-guard/index.ts`.** | **Chosen.** The seam is clean: `shared/` owns *parsing* (quote-aware segmentation, heredoc stripping, `$IFS` normalization, env-assignment stripping, redirection detection), the extension owns *policy*. `secrets-guard` scans bash commands with **raw regex over the unlexed string** (`findContentSecret`, `BASH_SENSITIVE_PATH_RE.test(command)`) and is exposed to the same quote/IFS obfuscation; a shared primitive lets it adopt lexing later (#505) without a second implementation. Consistent with the ADR-0030 `shared/` foundation pattern already consumed by `auto-router`/`context-manager`/`indexing`. |
| Q2.B — Harden `bash-destructive-guard/index.ts` in place, leave the lexer private. | Rejected. Leaves `secrets-guard` exposed to the identical bypass class with no shared path to fix it, and bakes a second copy of the lexer into the repo's future. |
| Q2.C — New sibling extension. | Rejected. Duplicates the lexer and the `tool_call` plumbing for no separation benefit; the policy already lives in one place. |

**Consequence of Q2.A (recorded here, actioned in the plan):** `pi-bash-destructive-guard` is currently a **leaf** distribution mirror (`mirror/targets.yml`, `inline: []`). Importing `../shared/shell-lex.ts` makes it a **coupled** mirror under ADR-0065 — its `targets.yml` entry MUST gain `inline: [shell-lex]` (its only `../shared/` import; `shell-lex` itself imports nothing from `shared/`, so the transitive closure is just the one module), so the sync engine stages the module under a `shared/` subdir and rewrites the import specifier. Omitting this fails the ADR-0065 `verify` gate.

### Q3 — Hand-lexer hardening vs. real shell parser (`mvdan/sh`)

| Option | Verdict |
|---|---|
| **Q3.A — Harden the existing hand-lexer for the two found gaps + the `writesOutput` hook now.** | **Chosen for this ADR.** The pipe-sink fix is small and fully closes the common Class-D shape at the string layer. The `writesOutput` structural hook is a prerequisite for Class E (`>` clobber). Both are dependency-free TypeScript. |
| Q3.B — Replace the hand-lexer with a real AST parser (`mvdan/sh`, Active, low-risk) via a bundled Go helper or WASM. | Deferred to a separate ADR — filed as #506. A real parser structurally closes the glued-substitution gap and gives a first-class pipeline-sink query, but `mvdan/sh` is Go-only — it requires a compiled helper binary or WASM bridge, a real packaging addition out of scope for a locally-iterable string-layer hardening pass. **Do not** adopt the `mvdan-sh` npm port — abandoned since ~2022. The glued-substitution gap (`r$(true)m`) is accordingly handled conservatively where cheap and otherwise **remains a documented fail-open gap** pending Q3.B. |

### Q4 — Class-E destructive-operation scope

Add the highest-frequency-incident destructive operations, path-checked against the same safe-list as `rm`/`mv`, **enabled by default** (consistent with the guard's blast-radius purpose; the safe-list + `SKIP_DESTRUCTIVE_GUARD=1` override cover false positives):

- **Bare output-redirection clobber** — `>` / `>|` targeting a path outside the safe list (requires the new `writesOutput` hook; `>>` append is lower-risk and out of scope for now). Highest value: needs no verb at all (`> /etc/passwd`).
- **`find … -delete`** and **`find … -exec rm|mv`** — the `-exec` form is partially covered via `wrapsDestructive`; `-delete` needs an explicit `find`-verb flag check.
- **`dd of=<path>`** — device targets (`/dev/*`) unconditionally; other `of=` targets path-checked.
- **`truncate -s <n> <path>`** — path-checked like `rm`/`mv`.

**Deferred (enumerated, not silently dropped):** `shred`, `wipefs`, `mkfs.*`, `parted`/`sgdisk` (low frequency, catastrophic — a later denylist row); `git clean -fdx`, `git reset --hard`, `git push --force` (different domain — same blast-radius category, warrants its own decision).

## Decision Outcome

1. **Harden at the extension layer, not by forking pi** (Q1.A). Record that the sound defense (Q1.C) is a separate, deferred OS/launcher control (#507).
2. **Extract the quote-aware lexer to `agent/extensions/shared/shell-lex.ts`** (Q2.A); `bash-destructive-guard` consumes it; register the resulting mirror coupling in `mirror/targets.yml` per ADR-0065.
3. **Close the Class-D pipe-sink gap** and **add a `writesOutput` structural hook**; harden the hand-lexer only (Q3.A), deferring the `mvdan/sh` AST parser (Q3.B, #506) and documenting the glued-substitution residuum honestly.
4. **Extend the destructive-operation policy** to `>`/`>|` clobber, `find -delete`, `dd of=`, and `truncate` (Q4), enabled by default, deferring the lower-frequency verbs with an explicit list.
5. **Preserve the guard's honest framing.** The `THREAT MODEL` header stays: this is **blast-radius / accidental-misuse isolation, not an adversarial security boundary**. The value-dependent Class-B/C/D residuum and the file-content-indirection class remain documented fail-open gaps; the ADR names the OS-level control (#507) that would actually close them.

## Consequences

**Positive:**

- Closes two live, currently-exploitable gaps in the shipped guard (`| sh` pipe-sink; conservatively, glued substitution).
- Broadens accidental-destruction coverage from `rm`/`mv` to the highest-incident Class-E operations.
- Creates one shared, tested lexing primitive that `secrets-guard` can later adopt (#505), retiring the raw-regex-over-command exposure.
- Entirely local iteration; no upstream coupling; optional-later-upstreaming preserved.

**Negative / cost:**

- `pi-bash-destructive-guard` becomes a coupled mirror (added sync complexity, per ADR-0065 — already borne by three other extensions).
- The hand-lexer grows; the glued-substitution gap is only conservatively mitigated until Q3.B lands.
- Class-E false-positive surface widens slightly (e.g. `>` to a legitimate absolute path outside cwd is now blocked) — mitigated by the existing safe-list + `SKIP_DESTRUCTIVE_GUARD=1` override.

**Deferred (filed as follow-up issues, plan step 1 — not silently dropped):**

- #505 — `secrets-guard` adopts `shared/shell-lex.ts` for its bash-command scan (own design pass; its match model is literals/paths, not command-position verbs). Cross-copy lockstep concerns per ADR-0071 apply.
- #506 — `mvdan/sh` AST second-pass (Q3.B); structurally closes glued substitution and pipeline-sink queries.
- #507 — OS-level sound defense (Q1.C); `$HOME` scoping, filesystem sandbox, egress allowlist around the bash tool's process tree; the only control that addresses the file-content-indirection (Makefile-exfil) class.
- #508 — repo-wide operational-vs-security framing; backport the `THREAT MODEL` header to `secrets-guard` and record the operational-filter-vs-security-guarantee split as a rule/ADR.

## Doc-Impact

| Surface | Classification | Reason |
|---|---|---|
| `adrs/0072-*.md` | in-scope | this ADR |
| `agent/extensions/shared/shell-lex.ts` (+ `test/shell-lex.test.ts`) | in-scope | new shared module + unit tests |
| `agent/extensions/shared/README.md` | in-scope | document the new module |
| `agent/extensions/bash-destructive-guard/index.ts` | in-scope | consume shared lexer; pipe-sink fix; Class-E rules |
| `agent/extensions/bash-destructive-guard/README.md` | in-scope | detection model, refusal-policy table, expanded verb scope |
| `agent/extensions/bash-destructive-guard/test/bypass.test.ts` | in-scope | A–E regression corpus incl. the two closed gaps + new Class-E |
| `mirror/targets.yml` | in-scope | `pi-bash-destructive-guard` → `inline: [shell-lex]` (ADR-0065) |
| `agent/extensions/README.md` index row | in-scope | update `bash-destructive-guard` purpose line (scope now beyond rm/mv) |
| `agent/AGENTS.md` extensions tree comment | in-scope | line ~134 "Blocks rm/mv…" reflects expanded scope |
| `scripts/test-shared.sh`, `scripts/test-bash-destructive-guard.sh`, `scripts/validate.sh` | not-a-thing | both suites auto-discover `test/*.test.ts`; no wiring change |
| `secrets-guard` shared-lexer adoption | out-of-scope but tracked | #505; own design pass |
| `mvdan/sh` parser, OS sandbox, repo-wide framing | out-of-scope but tracked | #506, #507, #508 |

## More Information

- [GuardFall — Adversa AI](https://adversa.ai/blog/opensource-ai-coding-agents-shell-injection-vulnerability/) — the vulnerability-class source.
- `agent/extensions/bash-destructive-guard/index.ts` — the guard being hardened (`#297` detection model, `#258` announce-backport).
- `agent/extensions/secrets-guard/index.ts` — the sibling that will later adopt the shared lexer.
- ADR-0030 (`shared/` foundation), ADR-0065 (inline coupling), ADR-0021 (extension tsconfig/lint contract), ADR-0038/0041 (mirror divergence posture).
- CWE-78 (OS command injection) — the underlying class GuardFall exploits.
