---
status: Accepted
date: 2026-08-19
---

# ADR-0143: commit-trailer guard — mechanically enforce the no-attribution commit rule

**Status:** Accepted 2026-08-19 — implemented with #1028. The two open decision points resolved at implementation: **strip is the default** (a reject default breaks harness sessions by construction, exactly as the Decision Drivers argued), and **the boundary is strip-everywhere with no shipped allowlist entries** — a repo that must keep harness attribution opts in by committing its own `.pi/trailer-allowlist`, which is precisely the recorded-exemption mechanism this ADR wanted. The "inline prefix form" override is read as belonging to the deferred runtime `tool_call` half (a `commit-msg` hook sees no command string to prefix); the shipped override surfaces are the env var, the allowlist file, and `--no-verify`.

**Related:** `agent/rules/conventional-commits.md` (the prose half this enforces), `secrets-guard` (the extension + git-hook two-layer architecture this copies), [ADR-0022](0022-gh-identity-guard-extension.md) (the adjacent commit-boundary guard — identity, where this is content), #69 (refusal-policy classification convention). Provenance: the 2026-08-19 audit of [disler/fixing-smartass-opus-5](https://github.com/disler/fixing-smartass-opus-5) against this suite, and psmfd/FingerTrap ADR-0027 (the DeepSeek Harness assessment that queued the adoption).

## Context and Problem Statement

`conventional-commits.md` bans authorship attributions in commit messages — "no Co-authored-by, authored by AI, or tool-name trailers" — as prose only. Nothing enforces it: `gh-identity-guard` probes *who* is committing, not what the message says; no installed hook inspects trailers.

The rule is violated in practice, and by construction rather than negligence: remote-harness sessions (Claude Code web/CCR and peers) are *mandated by their platforms* to append attribution trailers. Concrete instance: psmfd/FingerTrap `c5108b3` (2026-08-19) carries `Co-Authored-By` plus a session trailer, committed by a harness session hours after the rule was re-read in an audit. A written rule that recurring tooling violates needs a mechanical layer or a recorded exemption; silence — the status quo — is the one wrong answer, because it trains everyone to read the rules as aspirational.

## Decision Drivers

- **Every commit path must be covered**: the pi `bash` tool, the operator's own shell, and remote-harness sessions. The git-hook layer is the only surface all three share; a runtime `tool_call` guard alone sees only the first.
- **Enforcement must not block work**: a harness session cannot change its platform's mandate, so a posture that *rejects* its commits creates a failure loop nobody can fix from inside the session.
- **DCO must survive**: `Signed-off-by:` is attestation with legal meaning, not attribution — it must never match.
- **Overrides visible, per the #69 convention**: a deliberate exception is a recorded, inspectable act.
- **Per-repo variance is configuration, not folklore**: a repo that must keep harness attribution gets an allowlist entry, not an unwritten understanding.

## Considered Options

1. **Strip-mode `commit-msg` hook** — edit the message file in place, remove matched trailers, let the commit proceed; optional runtime `tool_call` guard later.
2. **Reject-mode `commit-msg` hook** — fail the commit naming the trailer and the override.
3. **Runtime `tool_call` guard only** — inspect `git commit` argv/`-F` content from the `bash` tool.
4. **Prose only** — status quo.

## Decision Outcome

**Option 1: strip-mode `hooks/commit-trailer-guard.sh`**, installed beside `secrets-guard.sh` through the same hook-install path.

- `commit-msg` receives the final message file on every composition path — `-m`, `-F`, editor, amend, harness — after the message is assembled and before the commit lands. Stripping there enforces the rule with no failure mode: the commit proceeds, clean, everywhere the hook is installed, harness sessions included.
- **Match set** (exact list lives in the hook, test-pinned): `Co-Authored-By:` trailers, `Generated with <tool>` lines, tool/session attribution trailers. **Explicitly excluded:** `Signed-off-by:` (DCO).
- **Announcements**: one line at hook install, and a one-line notice on the first strip in a repo per session — a silently edited message must never be a mystery hunt.
- **Refusal policy (per-rule, #69 convention):** continue-eligible. Overrides, three surfaces: `SKIP_COMMIT_TRAILER_GUARD=1` (env, per-invocation), `.pi/trailer-allowlist` (per-repo file naming permitted trailer patterns — the recorded exemption for repos that keep harness attribution), and the inline prefix form. Every override use is visible in the hook's output.
- **Reject posture ships as configuration**, not the default — for repos that prefer loud failure over silent hygiene.
- **The runtime `tool_call` half is deferred**: the hook already covers all paths; a runtime guard adds only earlier feedback inside pi sessions and can follow as a pattern-addition (likely `adr-required.md`-exempt) if the hook's feedback proves too late.

Option 2 is rejected as the *default* because it breaks harness sessions by construction. Option 3 alone is rejected because it misses operator-shell and harness commits entirely — the two paths where the violations actually occur. Option 4 fails the stated requirement: the rule is currently false in practice.

### Consequences

- Good: the rule becomes true everywhere the hook is installed; exceptions become allowlist entries with diffs.
- Good: completes the channel map from the #1028 audit — docs channel enforced by `plain-english` (ADR-0142), commits channel by this, response channel measured (#1029/#1034).
- Bad: strip mode rewrites messages silently by design; mitigated by the two announcements, and by the reject posture for repos that want it.
- Bad: coverage is per-clone — a fresh clone that never ran the hook install commits unguarded. Same exposure class as `secrets-guard`'s hook half; accepted there, accepted here.
- Neutral: harness platforms may evolve their attribution mandates; the match list is test-pinned and cheap to amend.

## Known Limitations and Deferred Work

- The runtime `tool_call` half (earlier in-session feedback) is deferred until the hook's ergonomics are proven.
- Squash-merge trailers added by forge UIs (GitHub's own squash attribution) land outside any local hook; if that path matters, it is CI's to check, and out of scope here.
