---
description: Enforce multi-agent research with minimum three subagents, quorum-based synthesis, and agent efficacy reporting
---

# Research Parallelism

This rule is mandatory, not advisory. When `orchestrator-protocol.md` classifies a task as Research, this rule applies in full. There are no soft opt-outs.

## When This Rule Applies

Any task that involves:

- Investigating a question or debugging a problem
- Exploring solutions or approaches
- Researching unfamiliar territory or technology
- Evaluating libraries, tools, or patterns
- Making architecture or design decisions
- Setting up infrastructure, CI/CD, branch policies, or deployment configuration
- Comparing alternatives or trade-offs
- Answering questions that touch domain expertise covered by custom subagents

If the task matches ANY of the above, this rule applies. The question is never "is this complex enough to warrant research?" — it is "does this involve any investigation, evaluation, or domain knowledge?" If yes, fan out.

## Requirements

- **Fan out with a minimum of 3 parallel subagents**, each approaching the problem from a different angle. Fewer than 3 is a protocol violation unless fewer than 3 relevant subagents exist in the catalog.
- **Use a single `subagent` tool call with `tasks: [...]`** — do not invoke them sequentially. The extension caps at 8 tasks / 4 concurrent; three reviewers fits comfortably.
- **Wait for all subagents to return** before synthesizing. Do not present partial results or act on a single subagent's output.
- **Synthesize the best-of-breed answer** by comparing and combining subagent results — do not simply pick one.
- **If subagents disagree**, highlight the disagreement and explain which perspective is strongest and why.

## What Counts Toward the Minimum

- Custom subagents from the agent catalog count.
- Inline handling of an angle counts only when no custom subagent covers it (subject to `agent-first-selection.md`).
- The same subagent invoked twice with different prompts does NOT count as two subagents.
- The same subagent invoked N times with **identical** prompts is **consensus-by-replication** and DOES count toward the minimum the same way divergence does. See [`consensus-by-replication.md`](consensus-by-replication.md) for the choose-between guidance and the aggregation ladder for design-recommendation splits (which are distinct from the verdict-aggregation rule in `structured-review-format.md`).
- A pre-composed slash workflow (`/review`, `/full-review`) that fans out to 3+ subagents satisfies the minimum in one user-visible action.

## Agent-behavioral Fan-out Composition

When the task is an agent-behavioral fix — a change that modifies constraint language, boundary conditions, or enumerated prohibited actions in a `SKILL.md`, agent wrapper, prompt template, or rule — the fan-out MUST include `code-review-expert` for requirement-fidelity review of the proposed text.

### When this applies

- Closing a documented boundary violation
- Correcting a known failure mode in agent behavior
- Codifying behavioral guidance that prohibits specific actions or rationalizations

This does not apply to additive knowledge changes (new domain facts, examples, reference content), typo fixes, or structural-only edits that do not alter the semantic content of a constraint.

### Why code-review-expert

Two distinct failure modes have been observed in agent-behavioral fixes elsewhere:

- **Missed artifact** — the fix targets the SKILL.md correctly but a parallel artifact (e.g., a wrapper Output template, a prompt-template embed) preserves the old behavior. The fix ships incomplete and the failure mode recurs.
- **Loophole text** — the fix itself contains language that an instruction-following agent can reuse to commit the original failure (e.g., a "Sample tone" subsection that provides a placeholder policy sentence the agent rationalizes as compliant).

Domain-of-the-fix experts and structural reviewers do not reliably catch either mechanism. The requirement-fidelity lens is what binds them.

### Typical composition

`code-review-expert` fills one of the three minimum-fan-out slots, not a fourth. The standard composition for an agent-behavioral fix is:

- **Subject agent** — the one being corrected
- **Structural reviewer** — `docs-expert` for rule/prose changes; the agent itself for SKILL.md / wrapper changes (running against its own change)
- **`code-review-expert`** — requirement-fidelity review of the proposed text

## Ground-Truth Source Precondition

Review agents that produce findings against code (`security-review-expert`, `code-review-expert`) MUST read the actual source under review before emitting any finding. Reviewing from memory of the repository, from prior context, or from a partial fragment quoted in a brief is a protocol violation.

### Rationale

A fan-out against `agent-expertise-api` produced four Error-class security findings (per-issuer audience binding, mode-guard enforcement, compound-role parsing, deny-by-default tenant resolution) from `security-review-expert` reasoning from training-set familiarity with the codebase. A subsequent round against a fresh local clone reversed all four with `file:line` evidence — every alleged defect was already correctly implemented. High-confidence findings produced against code the agent has not read are a worse failure than refusing to review, because they cost orchestrator turns to disprove and may be acted on by downstream consumers before the disproof lands.

### Orchestrator Obligation

When dispatching a review subagent, the brief MUST include an explicit `Source path:` line that names either:

- A working-tree path the subagent can `read`/`grep`/`find`/`ls`
- A git revision range (`base..HEAD`) plus the repo path the subagent should resolve it against
- A specific file list with line ranges

Briefs that ask for a review of a remote repository, a PR URL, or a topic ("review the auth code") without a resolvable source path are non-conforming. The orchestrator's responsibility is to clone, fetch, or check out the target before dispatching.

### Subagent Obligation

Review subagents MUST verify the cited path exists and is readable before producing findings. If no path is cited, or the cited path does not exist, the subagent MUST return a single-line `PRECONDITION_FAILURE` verdict naming the missing input rather than producing speculative findings. `PRECONDITION_FAILURE` is distinct from `NEEDS_CHANGES` — it signals that the review did not happen, not that the code was rejected.

Verification means actually performing a `read` of the cited file(s), not merely confirming the path resolves. Every finding emitted MUST be grounded in a quote, snippet, or `file:line` reference drawn from that read. Findings unsupported by an observable read of the cited path are a protocol violation — they are the failure mode this rule exists to close.

This precondition does not apply to research-mode advisory work (no diff, no specific code under review) — those invocations remain valid and must state research-mode explicitly per the skill's Output Format.

## Dependency Liveliness Evaluation

When research subagents evaluate and recommend external libraries, tools, or utilities, they must assess whether the project is actively maintained. Recommending an abandoned or stagnating project risks unpatched security vulnerabilities, degrading platform compatibility, and no path forward for bug fixes.

### When This Applies

- Recommending an external library, CLI tool, or utility for adoption
- Comparing alternatives where project health is a differentiator
- Answering questions about whether a specific tool is suitable for production use

This does not apply to: standard library features, language builtins, well-known stable projects with obvious activity (e.g., Linux kernel, systemd, PostgreSQL), or internal/first-party code.

### Signals to Assess

| Signal | What to check |
|---|---|
| Last release date | Most recent tagged release or published package version |
| Commit recency | Commits in the last 6 months on the default branch |
| Issue/PR activity | Triaging, review, and merge activity — not just issue count |
| Contributor count | Bus-factor risk — single-maintainer projects are higher risk |
| Open issue age | Unresponded issues piling up without triage |
| CI/CD health | Automated checks running and passing on recent commits |

Not all signals carry equal weight. A project with infrequent releases but active issue triage may be in maintenance mode (healthy). A project with recent commits but hundreds of unresponded issues may be overwhelmed (unhealthy).

### Output Format

When recommending an external dependency, include a liveliness assessment:

```text
**Liveliness:** Active | Maintenance-only | Stale | Abandoned
**Last release:** <date or "none">
**Commit activity:** <description of recent activity>
**Risk level:** Low | Medium | High
```

- **Active** — regular releases, responsive issue triage, multiple contributors
- **Maintenance-only** — infrequent releases, security patches only, limited new features. Acceptable for stable, mature tools.
- **Stale** — no releases or commits in 12+ months, unresponsive maintainers. Flag the risk.
- **Abandoned** — archived repo, explicit abandonment notice, or no activity in 24+ months. Do not recommend without strong justification and a mitigation plan.

### Risk Escalation

- **Low** — Active or Maintenance-only with multiple contributors. No action required.
- **Medium** — Maintenance-only with a single maintainer, or Stale with a viable fork. Note the risk in the recommendation.
- **High** — Stale or Abandoned with no viable fork. Recommend alternatives or flag that the user is accepting maintenance risk.

## Agent Efficacy Reporting

Every research, design, and implementation phase that invokes subagents MUST include an **Agent Efficacy Report**. This is a mandatory output. Omitting it is a protocol violation.

### When to produce a report

- **Research phase:** After all parallel subagents return and before presenting synthesized findings.
- **Design/planning phase:** Included in the implementation plan presented for approval.
- **Implementation phase:** After implementation is complete, report on how subagent research translated into implementation and where gaps appeared.

### Report structure

Each report must include:

1. **Agent table** — for each subagent invoked: name, duration, key contributions, value rating (High / Medium / Low).
2. **Disagreements** — where subagents disagreed and which perspective was chosen and why. State "None" explicitly if subagents agreed.
3. **Synergies** — how subagent outputs combined or complemented each other.
4. **Custom agent feedback** — specific improvement opportunities for custom subagents (SKILL.md content gaps, behavioral issues, performance concerns). This feeds directly into backlog issues for skill improvement.

### Purpose

Efficacy reports serve three goals:

- **Transparency** — the user sees exactly what each subagent contributed and can evaluate the research quality.
- **Continuous improvement** — feedback identifies SKILL.md gaps and behavioral issues that become backlog work items.
- **Process validation** — tracks whether the orchestration framework is producing value proportional to the time and context invested.
