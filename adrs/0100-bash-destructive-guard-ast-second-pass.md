---
status: Accepted
date: 2026-07-13
---

# ADR-0100: bash-destructive-guard AST second pass

**Status:** Accepted
**Date:** 2026-07-13
**Related:** [ADR-0072](0072-guardfall-shell-injection-hardening.md) (guard threat model + hand-lexer), [ADR-0091](0091-report-only-guard-profile.md) (report-only profile), [ADR-0099](0099-reusable-release-workflows-and-parser-vendor.md) (the parser binary + vendor pin), #506, #508 (operational-filter vs security-guarantee framing), #507 (the sound boundary)

## Context and Problem Statement

`bash-destructive-guard`'s TypeScript hand-lexer cannot soundly resolve a few
command shapes: ANSI-C quoting (`$'\x72m'`), value-glued substitution, and
destructive verbs nested inside command substitution as their own command
positions. ADR-0072 documented these as residual gaps. #506 adds a real shell
parser (the vendored `pi-bash-parser` binary, ADR-0099) as a second opinion.
The design question is the **posture**: when should the AST pass deny?

## Considered Options

1. **Deny-by-default on anything not statically resolvable** (the research
   framing): when a triggered command's parser is unavailable or the parse
   fails, DENY. Maximally cautious, but denies every command merely containing
   `$(` when the binary is absent (`echo "$(date)"`), which breaks ordinary
   agent use and — because the binary is a separate install — turns a missing
   dependency into a session-wide outage. False-positive denials also erode the
   trust the guard depends on.
2. **Additive, defer-on-uncertainty (chosen default):** the AST pass only ever
   ADDS a denial — it blocks a command the hand-lexer allowed **only** when the
   binary is present, the parse succeeds, and the guard's existing policy fires
   on an AST-discovered segment. Binary-absent and parse-failure fall back to
   the hand-lexer's verdict.
3. Offer both, defaulting to additive with a strict opt-in.

## Decision Outcome

Option 3. The default is **additive** (option 2); `PI_BASH_GUARD_AST_STRICT=1`
switches to **deny-by-default** (option 1: a triggered command is denied when
the binary is unavailable or the parse fails).

Rationale for the additive default: this guard is explicitly an **operational
filter, not a security guarantee** (ADR-0072 threat model, #508). Its job is
blast-radius isolation against *naive/mistaken* destructive commands, not a
sound adversary defense — that is #507's OS sandbox. An additive second pass
strictly increases coverage (it closes the ANSI-C and nested-substitution gaps
when the binary is present) without ever introducing a false-positive denial or
a hard dependency on a helper binary. Operators running untrusted agents who
want the stricter posture opt in.

Mechanics: a cheap trigger (`$'`, `$(`, or backtick present) gates the spawn, so
the common case never pays. On trigger, the guard spawns `pi-bash-parser`
(stdin: the preprocessed command; stdout: JSON command-position segments; 2 s
timeout, 512 KB output cap), and re-applies its **own** policy to the parsed
segments — parsing here, policy in the guard.

The parser returns segments; `index.ts` runs them through the **same two
policies its hand-lexer loop uses**: the report-only profile check
(`analyzeReportOnlySegment`, ADR-0091) when the profile is active, then the
general blast-radius policy (`analyzeSegment`). So the AST pass extends **both**
contracts — a report-only subagent gets the ANSI-C / nested-substitution
coverage too, not only ordinary sessions. Posture config (strict mode + the
resolved binary path) is captured once at extension load, mirroring how
`skipGeneral`/`profileActive` are captured, so an in-session env mutation cannot
downgrade strict→additive or repoint the binary.

### Delta table — what the AST pass changes

| Class | Before (hand-lexer) | After (AST pass, binary present) |
|---|---|---|
| ANSI-C-quoted verb/flag (`$'\x72m'`) | fail-open | **closed** for both the general and report-only policies (decoded → policy applies) |
| Destructive verb in nested `$(...)` | not seen as a command position | **closed** for both policies (own segment) |
| Empty-glued substitution (`r$(true)m`) | closed (deglue) | closed |
| Value-producing substitution (`$(echo rm)`) | fail-open | **still fail-open** — value is runtime-only; the parser renders it empty |
| Parameter-default / variable indirection (`${x:-rm}`, `$R`) | fail-open | **still fail-open** — value-dependent |
| File-content indirection (`make test`) | fail-open | **still fail-open** — different interpreter; #507 |

The AST pass is a **soundness improvement on the string-decidable subset**, not
a security boundary. It does not change the guard's overclaim posture: the
value-dependent and file-content-indirection classes remain open by design and
are addressed only by #507.

## Consequences

- Closes the two most realistic accidental-obfuscation gaps (ANSI-C quoting,
  nested substitution) when the binary is present, with zero new false positives
  in the default posture.
- Adds a runtime dependency on the vendored `pi-bash-parser` binary; its absence
  degrades gracefully to the prior hand-lexer behavior (or denies triggered
  commands under strict mode).
- The `PI_BASH_GUARD_AST_STRICT` posture and the honest delta table are recorded
  here rather than by reference, per #508.
