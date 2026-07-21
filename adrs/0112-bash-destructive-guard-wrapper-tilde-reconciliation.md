---
status: Accepted
date: 2026-07-20
---

# ADR-0112: bash-destructive-guard — wrapper-surface completion, tilde resolution, and general↔report-only parity

**Status:** Accepted
**Date:** 2026-07-20
**Related:** [ADR-0072](0072-guardfall-shell-injection-hardening.md) (added the Class-E direct-invocation rules this completes for the wrapper path — extended, not superseded), [ADR-0091](0091-report-only-guard-profile.md) (the report-only engine whose parallel checkers are reconciled here), [ADR-0100](0100-bash-destructive-guard-ast-second-pass.md) (the AST second pass whose shipped status the docs now reflect), pi_config #798 (the review that surfaced the bypasses), #799 (deferred report-only R1–R8 extraction)

## Context and Problem Statement

The #798 extension review executed the general guard's real `tool_call`
handler against the guard's own threat model — "naive or mistaken"
destructive commands using ordinary shell syntax — and empirically
reproduced three bypasses that were not on the documented adversarial
residual-gap list:

- **Home-path misclassification.** `pathUnsafeReason` treated any path not
  starting with `/` as "relative → within cwd → safe" and never expanded
  `~`. `rm ~/.ssh/id_rsa`, `dd of=~/.aws/credentials`,
  `echo x > ~/.ssh/authorized_keys`, and `truncate -s0 ~/.bash_history`
  all passed unblocked, though `~` expands to `$HOME`, which is neither
  `cwd` nor `/tmp`.
- **Wrapper-surface omission.** ADR-0072 added Rules 0/4/5/6 (clobber,
  `find -delete`, `dd of=`, `truncate`) for *direct* invocation, but the
  wrapper rule (`wrapsDestructive`) still only recognized the literal
  words `rm`/`mv`. `sudo dd if=/dev/zero of=/etc/shadow`,
  `timeout 5 truncate -s0 /etc/passwd`, `sudo find / -delete`, and the
  quote-embedded clobber `eval 'echo x > /etc/passwd'` (whose `>` never
  surfaces as a structural redirect) all bypassed the guard entirely.
- **No basename normalization on the wrapped word.** The segment's own
  verb is basename-normalized (`/bin/rm` → `rm`), but `wrapsDestructive`
  compared each wrapped word verbatim, so `sudo /bin/rm -rf /etc` scanned
  `/bin/rm ≠ rm` and allowed the command. `/bin/rm`/`/usr/bin/mv` are
  standard non-adversarial paths.

Two adjacent errors and a report-only parity gap accompanied them: `find`
global options before the root (`find -L /etc -delete`) collapsed
`leadingPathArgs` to an empty (cwd-safe) root list; the report-only
profile's `scanOpaqueWrapperArgs` had the identical un-normalized
word-scan and omitted `find` from `WRAPPED_DENY_WORDS`
(`eval 'find /etc -delete'` bypassed the profile); and its default-write
formatter detection hard-coded the subcommand at `tokens[1]`, so a global
flag before it (`terraform -chdir=infra fmt`) dodged the deny. The review
also found `hasMinusC` over-matching any single-dash all-letter token
containing `c` across the whole token list, so a shell-interpreter script
argument (`bash run.sh -clean`) was falsely read as `-c` and blocked.

## Considered Options

1. **Reconcile the wrapper path to the direct-invocation surface** — make
   Rule 2 recognize the full Class-E set with basename normalization and
   the quoted-redirect check `report-only.ts` already had, resolve `~`
   before the relative-path exemption, fix `find` option skipping, and
   bring the report-only checkers to parity.
2. **Rely on the AST second pass** to catch the wrapped/tilde shapes.
   Rejected: the AST pass only triggers on `$'`/`$(`/backtick, so plain
   `sudo dd …` and `rm ~/x` never reach it; it is a complement to the
   hand-lexer rules, not a substitute.
3. Document the bypasses as accepted gaps. Rejected: they are inside the
   stated "naive misuse" threat model and require no evasion technique.

## Decision Outcome

**Option 1 — complete the wrapper surface and reconcile the two engines.**
The guard's contract is blast-radius isolation against ordinary
destructive commands; a bypass reachable with `sudo`, `~/`, or `/bin/rm`
is a hole in that contract, not an adversarial edge case. Reconciliation
is *upward* (widen protection), mirroring ADR-0111's looser-wins posture
for the sibling secrets-guard.

Concretely:

1. **`wrapsDestructive`** (general guard) scans a basename-normalized word
   against `{rm, mv, dd, truncate}`, treats a token containing `>` as a
   wrapped clobber, and denies wrapped `find` co-occurring with `-delete`.
   The deny message and the source rule-list comment widen from "rm|mv" to
   the full operation set.
2. **`pathUnsafeReason`** resolves a leading `~`/`~/…` against `$HOME` and
   safe-checks the absolute target; an unresolvable `~user/…` is refused.
   Bare relative paths keep the cwd-safe exemption.
3. **`leadingPathArgs`** skips GNU find global options (`-H`/`-L`/`-P`,
   `-D <opts>`, `-O[n]`) before collecting roots, so a pre-path flag no
   longer empties the root list.
4. **`report-only.ts`** reaches parity: `scanOpaqueWrapperArgs`
   basename-normalizes wrapped words, `find` joins `WRAPPED_DENY_WORDS`,
   and formatter subcommands are located as the first non-flag token
   (the pattern `cargo` already used) rather than `tokens[1]`.
5. **`hasMinusC`** (`shared/shell-lex.ts`) scans only the leading flag
   region — up to the first non-flag token — so a `c`-bearing script
   argument is no longer read as the `-c` option. `bash -c '…'` still
   matches, since `-c` is always in the option region.
6. Regression tests cover every closed bypass and every new negative in
   `bypass.test.ts`, `report-only.test.ts`, and `shell-lex.test.ts`.

### Consequences

- Good: the wrapper path enforces the same Class-E surface as direct
  invocation; `~`-relative destructive operations are gated; the two
  engines no longer disagree on wrapped verbs.
- Good: `find -L … -delete` and `terraform -chdir=… fmt` are caught;
  legitimate `bash run.sh -clean` invocations stop false-blocking.
- Neutral: a wrapped token literally containing `>` (e.g. `sudo grep ">"`)
  is now conservatively denied — consistent with the fail-closed posture
  the report-only profile already applied, with direct invocation the
  documented recovery.
- Accepted gap (unchanged): separated-value global flags before a
  formatter subcommand (`dotnet --verbosity q format`) still evade the
  report-only deny — the checkers remain a pragmatic scan, not a POSIX
  parser. Deferred with the R1–R8 extraction in #799.
- Accepted gap (unchanged): runtime-value evasions (`${x:-rm}`, variable
  indirection, value-producing substitution, base64 pipelines) remain
  fail-open per the threat model; the ANSI-C and nested-substitution
  shapes are closed by ADR-0100's AST second pass, whose shipped status
  the README now reflects (the review found the docs still framed it as
  unmerged #506).
