---
status: Accepted
date: 2026-08-13
---

# ADR-0139: extensions declare their tool-registration capability, and validate.sh checks the declaration against the code

**Status:** Accepted — approved with the #990 implementation plan on 2026-08-13.

**Related:** [ADR-0137](0137-github-read-core-shared-extraction.md) (states the `repo-dash` constraint this operationalizes; its decision is unchanged), [ADR-0088](0088-cross-extension-import-boundary.md) (the mechanical-gate precedent ADR-0137 cited but did not follow for its own constraint), [ADR-0074](0074-mirror-target-onboarding-lockstep-gate.md) (the hand-kept-list failure shape this deliberately avoids), [ADR-0123](0123-typed-read-only-github-and-git-tools.md) (the typed model-facing tool surface whose exclusivity is the property at stake).

## Context and Problem Statement

ADR-0137 §4 states, in the strongest terms available to it, that `repo-dash` registers no tools:

> `repo-dash` registers no tools. It may register commands (`pi.registerCommand`), shortcuts (`pi.registerShortcut`), and widgets, and may open `ctx.ui.custom` panels. It MUST NOT call `pi.registerTool`. … The security consequence is the point.

The constraint was true when written and is true today. It was also enforced by nothing but prose — a doc comment in `agent/extensions/repo-dash/index.ts` and a README section. There was no `validate.sh` check, no ESLint rule, and no test assertion. A single future commit adding one `pi.registerTool` call would have shipped with no signal.

The irony is the reason this is worth an ADR rather than a quiet patch: ADR-0137 cites **ADR-0088's mechanical gate** (`validate.sh §6b-quater` plus `sync-mirror.sh`'s `verify_no_orphan_cross_imports`) as the precedent for its own design — a fail-closed check for a boundary that would otherwise drift silently — and then protected its own load-bearing constraint with a comment. This is the same failure shape ADR-0137 itself documents for the `shared/` flatness constraint: a rule that fails silently is a rule that eventually gets broken.

Flagged independently by two reviewers in the five-agent fan-out review of ADR-0136/0137, which is why it was filed rather than noted in passing.

`package-agent-broker` is the proof that the drift is real rather than theoretical. Its README described it as tool-free through the draft and approve phases; `index.ts:313` now genuinely calls `pi.registerTool(` since the #930/ADR-0131 dispatch work landed. The capability changed and nothing forced the description to keep up.

## Decision Drivers

- **Do not add a second hand-kept list.** ADR-0074 exists because a mirror target was added to two of three enumerations and not the third, and the omission surfaced only at release time. Any design here that introduces a human-maintained roster of extensions recreates that failure one field over.
- **The constraint must survive its author.** The check has to fail for someone who has never read ADR-0137 and is simply adding a tool to what looks like an ordinary extension.
- **A gate nobody can reason about is worse than a simple one with stated limits.** Chasing every conceivable evasion produces a check whose failures cannot be diagnosed. The gate's job is to catch accidental drift; deliberate evasion of a documented ADR is a review problem, not a static-analysis problem.
- **Do not overclaim.** "Registers no tools" and "does not widen model reach" are not the same proposition, and a gate that checks the first must not be described as proving the second.

## Considered Options

| Option | Verdict |
| --- | --- |
| **Bidirectional source-derived check against a one-line in-source marker** | **Chosen.** Both sets are derived from the tree — the declaration by glob over `index.ts`, the reality by grep over call sites — so there is no roster to drift. Generalizes to every extension without naming any. |
| Bespoke check hardcoding `repo-dash` | Rejected. Exactly the anti-pattern #990 names: protects one extension, silently permits the same regression in the other eleven, and hardcodes a name the ADR-0074 lesson says not to hardcode. |
| A ledger file listing tool-registering extensions | Rejected. A human-maintained enumeration adjacent to the code it describes — the ADR-0074 shape. The in-source marker carries the same information with no second file to forget. |
| Ledger inside `mirror/targets.yml` | Rejected on top of the above: `repo-dash` is not a mirror target, so the property would be recorded in a manifest that does not describe it. |
| ESLint `no-restricted-syntax` scoped by `files:` | Rejected. Needs one override entry per tool-free extension — twelve today — which is itself the lockstep list this avoids, and it cannot express the "must have declared it" direction. Every invariant of this shape already lives in `validate.sh`. |
| A unit test in `repo-dash`'s own suite | Rejected as the primary mechanism. It cannot express a fleet-wide check without duplicating into twelve suites, and it teaches the wrong pattern for the next tool-free extension: ADR-0088's `§6b-quater-pre` comment records a mirror-shipped invariant test that could not resolve its path in the mirror and broke that repo's CI for weeks. Monorepo-scoped invariants belong in the monorepo's gate. |

### Why bidirectional

Checking only "declared tool-free implies no call sites" leaves the marker self-disabling: an author adding a tool deletes the comment and the gate falls silent. The second direction — "no call sites implies declared" — closes it. Adding a tool now *requires* deleting a declaration line, which is a visible, reviewable act in the diff rather than an absence nobody notices.

This does not make the marker tamper-proof, and it is not meant to. An author can still delete the line and add a tool in one commit. What the gate guarantees is that doing so is never silent.

## Decision Outcome

**1. Every extension whose `index.ts` registers no model-callable tool carries this exact line in its own `index.ts`:**

```ts
// PI-EXTENSION-CAPABILITY: no-registerTool
```

Twelve extensions carry it as of this ADR: `auto-router`, `bash-destructive-guard`, `cache-meter`, `compaction-optimizer`, `context-manager`, `expertise-fanout-gate`, `gh-identity-guard`, `payload-tuner`, `prefill-meter`, `repo-dash`, `secrets-guard`, `worktree`. The other ten register at least one tool and must not carry it.

**2. `validate.sh §6b-quinquies` checks both directions**, deriving each set from the tracked tree:

- Set A — extensions whose own `index.ts` contains the marker as a whole line.
- Set B — extensions with zero real `pi.registerTool(` call sites across their own tracked non-test `.ts` files.
- `A \ B` is an error: the declaration is false.
- `B \ A` is an error: tool-free but undeclared.

Extension discovery is anchored to `^agent/extensions/[^/]+/index\.ts$`. A bare `/index\.ts$` matches `hashline-edit/vendor/jsdiff/index.ts`, a vendored third-party file, and would count a 23rd "extension" that has no marker and no registration.

Call-site detection strips comment lines and excludes `test/`. Both exclusions are load-bearing against real content, not hypothetical: `web-fetch/index.ts` carries `pi.registerTool (#826)` in a docblock, which matches the call pattern, and `expertise-client/test/coexist.test.ts` holds `pi.registerTool(...)` inside string literals by design.

**3. The gate's scope is narrower than ADR-0137's prose claim, and is documented as such.** It proves that no new model-callable tool schema is registered. That is necessary but not sufficient for "does not widen model reach":

- `registerCommand` / `registerShortcut` are operator-invoked and are not a model-reach vector.
- **Hooks** (`pi.on`) are a genuine vector — a `tool_call` hook can rewrite another extension's call without registering anything. `repo-dash` registers no hooks today, so the gate is sufficient for it in fact; it would not catch a future hook-based regression, and this ADR does not claim otherwise. Extending the gate to hooks is a separate property with its own reasoning, because hook use is sanctioned and routine in `context-manager`, `auto-router`, and `expertise-fanout-gate`.
- **`ctx.ui.setEditorText`** is a real injection vector that `repo-dash` does use, writing attacker-influenced GitHub titles into the prompt buffer. It is not an unenforced gap — it is controlled by `sanitizeTitle` and its tests, hardened under #989 in the same change as this ADR — but it is controlled by a *behavioural* mechanism, not by this structural one.

**4. Accepted gaps, recorded rather than chased.** Aliasing (`const rt = pi.registerTool`), destructuring (`const { registerTool } = pi`), computed access (`pi["registerTool"]`), line-wrapped member access, and registration indirected through a shared helper module are not detected. None occurs anywhere in the current corpus; member-call-off-receiver is the uniform house style. This matches the risk posture `secrets-guard` already takes with its own documented gaps (base64-encoded secrets, runtime-assembled literals).

The shared-helper case is the most plausible future gap, because it would arrive as a well-meant refactor rather than an evasion. The trigger to write down now: **if a tool-free extension ever imports a shared registration helper, either extend this gate to that module or reject the import.**

## Consequences

- **Positive.** ADR-0137's constraint is enforced rather than asserted. Every extension's tool posture is now a declared, checked fact, so the `package-agent-broker` drift shape cannot recur silently. The check adds no new file and no roster, so there is nothing to keep in sync.
- **Positive.** The declaration is co-located with the code it constrains, so a reviewer reading `index.ts` sees it without knowing the gate exists.
- **Negative / accepted.** Twelve files carry a two-line preamble that is pure metadata. Judged worth it: the alternative that avoids the preamble is a roster file, which is the failure mode being designed out.
- **Negative / accepted.** A new tool-free extension fails validation until it adds the marker. This is the forcing function working as intended, but it is a papercut for an author who has not read this ADR — the error message therefore names the exact line to add and cites this ADR.
- **Negative / accepted.** The marker is deletable. The gate makes tool registration *visible*, not impossible; the ADR is the policy and review is the enforcement of last resort.
- **Follow-up.** Hook-based widening (`pi.on`) is unmodelled by any gate. Not filed as work, because there is no observed drift and no tool-free extension currently registers hooks — recorded here so a future reader does not mistake this gate's silence for coverage.
