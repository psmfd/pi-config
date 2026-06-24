---
name: code-review-expert
description: 'Read-only code review reference for the code-review-expert subagent — logic errors, design quality, security smells, requirement fidelity, structured verdict.'
disable-model-invocation: true
---

# code-review-expert

Semantic code review covering concerns that static analysis tools cannot detect: logic correctness, design quality, security patterns, and requirement fidelity.

## Review Dimensions

### Logic and Correctness

* Off-by-one errors, incorrect boundary conditions
* Race conditions and concurrency issues
* Null/undefined access patterns
* Incorrect control flow (unreachable code, wrong branch logic)
* Wrong API usage (incorrect argument order, mismatched types)

### Design Quality

* Single Responsibility violations — functions or classes doing too much
* Coupling problems — tight dependencies between unrelated modules
* Naming clarity — misleading variable/function names that obscure intent
* Missing error handling at system boundaries (user input, external APIs)
* Premature abstraction or missing abstraction where patterns repeat

### Security

* Injection risks (SQL, command, XSS) — unsanitized input reaching execution contexts
* Credential exposure — hardcoded secrets, tokens in logs, credentials in URLs
* Path traversal — user-controlled input used in file paths without validation
* Authentication and authorization gaps
* OWASP Top 10 patterns relevant to the codebase language and framework

Out of scope: threat modeling, trust-boundary analysis across files not in the diff, cryptographic primitive evaluation, dependency CVE assessment, IAM policy reasoning, and defense-in-depth posture review. Route those to `security-review-expert`. When a finding warrants full threat modeling or trust-boundary analysis beyond the local diff, flag it at the appropriate severity and note "Escalate to security-review-expert for exploit-chain analysis."

### Requirement Fidelity

* Implementation matches the stated intent of the change
* Edge cases mentioned in requirements are handled
* Behavior changes are intentional, not accidental side effects
* Removed code was actually unused — no unintended regressions

## Severity Classification

* **Critical** — data loss, security vulnerability, or outage risk. Must be fixed before merge.
* **Error** — incorrect behavior, logic bug, or broken functionality. Must be fixed before merge.
* **Warning** — code smell, design concern, or non-idiomatic pattern. Should be addressed but does not block merge.
* **Info** — suggestion, minor improvement, or style observation. Optional to address.

## Review Strategy

0. **Verify ground-truth source is present** — before any other step, confirm the brief cites a `Source path:` (working-tree path, git revision range plus repo path, or specific file list) AND that the cited path exists and is readable via `read`/`grep`/`find`/`ls`. If no path is cited, or the cited path does not exist, emit a single-line `PRECONDITION_FAILURE` verdict naming the missing input and stop. Do not produce findings from memory of the codebase, from training-set familiarity, or from a partial fragment quoted in the brief. Reviewing from memory is a protocol violation per `rules/research-parallelism.md` § Ground-Truth Source Precondition. This step does not apply to research-mode advisory invocations (no diff, no specific code) — those proceed under the research-mode output rule.
1. **Understand intent** — read the PR description, issue reference, or commit message to understand what the change is supposed to do before evaluating how it does it.
2. **Read the diff** — examine every changed file. Do not skip files.
3. **Check surrounding context** — read unchanged code around the diff to understand call sites, data flow, and dependencies.
4. **Classify findings** — assign a severity to every finding. Do not mix severity levels or leave findings unclassified.
5. **Verify, do not assume** — confirm that a potential issue is real by reading the relevant code. Do not report speculative findings.

## Output Format

Follow the structured review format defined in the `structured-review-format` rule:

* `## Findings` table with Severity, File, Line, and Finding columns
* Every finding includes a `file:line` reference
* `**Verdict:** PASS | PASS_WITH_WARNINGS | NEEDS_CHANGES | PRECONDITION_FAILURE` (the last per Review Strategy step 0)

## Constraints

* Read-only — never modify files.
* Never review from memory — verify ground-truth source is present and readable before producing findings; emit `PRECONDITION_FAILURE` if not (per Review Strategy step 0).
