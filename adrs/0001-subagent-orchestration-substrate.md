# ADR-0001: Adopt pi `subagent` extension and routing primitives as the orchestration substrate

**Status:** Accepted
**Date:** 2026-05-13

## Context and Problem Statement

`pi_config` was bootstrapped by lifting skills from the multi-platform `agent-framework` repository, which targeted both Claude Code and GitHub Copilot CLI. That framework provided a layered orchestration model — domain skills, per-platform agent wrappers with tool restrictions and model selection, behavioral rules (orchestrator protocol, agent-first selection, research parallelism), structured-output rules, and shell-script hooks — to make read-only specialists like `code-review-expert` and `security-review-expert` invokable in a controlled, isolated, parallelizable way.

`pi_config` is pi-only. Skills are migrated, but the surrounding routing and invocation surface is not. A `code-review-expert` SKILL.md alone is insufficient: the model needs (a) a mechanism to spawn the specialist with restricted tools and an isolated context, (b) a behavioral framing that routes review tasks to it instead of inlining the review, (c) a shape contract for the output so callers can act on it, and (d) guardrails preventing destructive operations and secret leakage during the workflow. Without these, the migrated skills are knowledge with no enforced delivery path.

The question is which pi primitives to build that surface on, given that pi itself does not expose Claude's `Agent` tool or Copilot's `agent` tool natively, and pi has no `applyTo`-style auto-injected instruction files like Copilot's `*.instructions.md`.

## Considered Options

* **Option A** — Adopt pi's bundled `subagent` example extension as the core orchestration primitive; vendor it into the repo; add `agent/agents/`, `agent/prompts/`, `agent/rules/`, and TypeScript-extension-based hooks. Routing rules loaded via `AGENTS.md`.
* **Option B** — Skills-only: rely on the model loading specialist `SKILL.md` files in-context within the same session. No subprocess isolation, no tool restriction per specialist, no parallel fan-out.
* **Option C** — Symlink (not vendor) pi's bundled `subagent` example from the installed pi package. Same architecture as A, but extension version tracks pi version.
* **Option D** — Build a custom subagent extension from scratch against pi's `Extension` SDK. Owns the surface fully but rebuilds existing functionality.
* **Option E** — Defer; keep skills-only for now and revisit when pi ships a first-class subagent primitive.

## Decision Outcome

Chosen option: **A — adopt and vendor the `subagent` extension, add agents/prompts/rules/hooks alongside it**.

The `subagent` extension is structurally a near-perfect fit for the framework's orchestration model and is in some respects materially stronger:

* **Process isolation per subagent.** Each subagent runs in a separate `pi` subprocess with its own context window. This is a stronger blast-radius boundary than Claude's in-process `Agent` tool, and aligns directly with the supply-chain-injection threat model the framework codified in its `no-mcp-servers` rule and ADR-046 (expertise injection removal).
* **Explicit parallel and chain modes.** The extension exposes `{ tasks: [...] }` (parallel, capped at 8 with concurrency 4) and `{ chain: [...] }` with a `{previous}` placeholder. The framework's `research-parallelism.md` rule — a long behavioral mandate the model could violate — collapses to a tool affordance the model invokes correctly or not at all.
* **Per-agent frontmatter for `name`, `description`, `tools`, `model`.** Same shape as the framework's Claude and Copilot wrappers. Migration of agent definitions is essentially a re-frontmatter exercise.
* **Default-safe project agent loading.** Project-level `.pi/agents/*.md` is opt-in (`agentScope: "both"`) and prompts for confirmation interactively. Better posture than Claude/Copilot defaults.
* **Single-platform collapse.** The framework's three-file pattern (`skills/X/SKILL.md` + `agents/X.md` + `copilot/agents/X.agent.md`) compresses to one skill + one agent wrapper. The `ai-crossplatform-expert` skill becomes unnecessary and is correctly excluded from migration.

Vendoring (over symlinking, Option C) is chosen because the subagent extension is a bundled *example*, not part of pi's stable surface — pi version upgrades could change or remove it, and orchestration is core enough to this repo that we want to own the version. The vendored copy lives at `agent/extensions/subagent/` and is symlinked into `~/.pi/agent/extensions/subagent/` by `setup.sh`.

Behavioral routing rules (orchestrator protocol, agent-first selection, research parallelism, structured-review output) are placed in `agent/rules/*.md`. Pi has no `applyTo`-style auto-injection for arbitrary instruction files, so the protocol-level triad (orchestrator, agent-first, parallelism) is composed into `agent/AGENTS.md` and symlinked to `~/.pi/AGENTS.md` so it is always in context. Output-shape rules (`structured-review-format.md`) ride along inside the relevant prompt templates (`/review`, `/security-review`, `/full-review`) because they only matter when a review workflow is invoked.

The framework's bash-script hooks (`secrets-guard`, `bash-destructive-guard`, `stop-preflight-check`) are reimplemented as TypeScript pi extensions under `agent/extensions/`, which gives typed access to commands, cwd, env, and tool arguments and removes a class of regex-in-bash bugs.

The framework's `validate.sh` is replaced by a much simpler pi-only validator: every `agent/agents/*.md` references a valid skill, every `agent/prompts/*.md` references valid agents, the agent catalog in `AGENTS.md` matches `agent/agents/`. This is one source of truth instead of three.

The default fan-out for `/review` is **three agents in parallel** (`code-review-expert`, `security-review-expert`, `linter`), matching `research-parallelism.md`'s minimum. The subagent extension's 8-task / 4-concurrency cap is sufficient for any orchestration we have planned; if a future workflow needs more, scale-up will be revisited.

`disable-model-invocation: true` is set on the read-only specialist skills (`code-review-expert`, `security-review-expert`, `checkmarx-expert`) so the agent wrapper becomes the sole entry point — the model cannot inline-load the skill and produce a one-pass review without going through the isolated subagent. This is the framework's intent for those skills, expressed in pi semantics.

### Tradeoffs

* Good: Process-isolated subagent execution — stronger blast-radius containment than Claude/Copilot in-process
* Good: Parallel and chain orchestration are first-class tool affordances, not behavioral conventions
* Good: Single-platform collapse — one agent definition per specialist, not three; no cross-platform translation skill
* Good: Workflows (`/review`, `/full-review`) discoverable as slash commands without custom UI work
* Good: Hooks become typed TypeScript with structured access to tool arguments — reduced surface for regex-in-bash bugs
* Good: Vendoring insulates the orchestration surface from pi version drift
* Bad: Adds a dependency on the bundled `subagent` example, which is not part of pi's stable surface — vendoring mitigates but does not eliminate the maintenance burden of tracking upstream changes
* Bad: Behavioral rules in `AGENTS.md` are always-in-context — estimated 1–3K tokens of overhead per session; payoff is reliable routing
* Bad: Spawning subprocesses has higher latency than in-process Agent tool calls — measured cost is a few hundred milliseconds per invocation
* Bad: Routing rule enforcement in pi is softer than Copilot's `applyTo` — the model can read AGENTS.md and choose to ignore it; the strongest mitigation is making the *easy path* (slash workflows + parallel-by-default) the correct path

## More Information

Implementation is split into four sequenced phases, tracked as separate GitHub issues against this repo:

* **Phase A — Foundations.** Vendor the `subagent` extension into `agent/extensions/subagent/`. Add `agent/agents/` with starter agents for the eight read-only specialists. Add `agent/prompts/` with `/review`, `/security-review`, `/full-review`. Update `setup.sh` to symlink both directories.
* **Phase B — Rules.** Add `agent/rules/` with `orchestrator-protocol.md`, `agent-first-selection.md`, `research-parallelism.md`, `structured-review-format.md` (paths-block-stripped). Add `agent/AGENTS.md` composing the routing triad and the agent catalog (catalog generated from `agent/agents/*.md` frontmatter to prevent drift).
* **Phase C — Guardrails.** Port `secrets-guard`, `bash-destructive-guard`, `stop-preflight-check` as TypeScript extensions under `agent/extensions/`. Replace `validate.sh` with a pi-only validator.
* **Phase D — Cutover.** Set `disable-model-invocation: true` on `code-review-expert`, `security-review-expert`, `checkmarx-expert` so their agent wrappers are the sole entry points. Smoke-test `/review` end-to-end. This phase merges with the existing optimization issue #2 (`disable-model-invocation` for read-only specialists) — Phase D and #2 are the same work and should be executed together.

Source material for the migrated agent wrappers, routing rules, and hooks lives in `/home/pdavis/projects/agent-framework/`:

* Agent wrappers: `agents/*.md` (Claude format) and `copilot/agents/*.agent.md` (Copilot format) — pi format collapses these to a single `agent/agents/<name>.md`.
* Routing rules: `rules/{orchestrator-protocol,agent-first-selection,research-parallelism,structured-review-format}.md` — strip `paths:` blocks, normalize frontmatter quoting per the same convention used for skills.
* Hooks: `hooks/{secrets-guard,bash-destructive-guard,stop-preflight-check}.sh` — reimplement as TS extensions, do not port the bash verbatim.

The pi `subagent` extension's upstream source is bundled with pi at `<pi-install>/examples/extensions/subagent/`. The vendored copy in this repo is the snapshot taken on the date of this ADR; future updates are tracked manually with a note in the commit message recording the source pi version.

Peer-to-peer subagent communication was explicitly considered and rejected — see [ADR-0002](0002-agent-to-agent-channel.md) (Superseded) for the design archive and [ADR-0008](0008-tier-3-as-sole-intra-session-inter-agent-channel.md) for the active intra-session inter-agent evidence channel (Tier 3 artifact handoff via `.review/` + `artifact_review`).
