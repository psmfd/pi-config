# pi_config

## Architecture Decisions

ADRs live in [`adrs/`](adrs/). Currently:

- [ADR-0001](adrs/0001-subagent-orchestration-substrate.md) — Adopt pi `subagent` extension and routing primitives as the orchestration substrate
- [ADR-0002](adrs/0002-agent-to-agent-channel.md) — Agent-to-agent (a2a) channel — orchestrator-mediated filesystem journal (superseded by ADR-0008)
- [ADR-0003](adrs/0003-expand-disable-model-invocation-to-all-wrapper-paired-skills.md) — Expand `disable-model-invocation: true` to all wrapper-paired expert skills
- [ADR-0004](adrs/0004-consensus-by-replication.md) — Consensus-by-replication as a first-class fan-out shape
- [ADR-0005](adrs/0005-tool-call-journal-and-restore.md) — Tool-call journal and restore primitive (proposed)
- [ADR-0006](adrs/0006-artifact-handoff-and-review-format.md) — Artifact handoff format for in-session user review
- [ADR-0007](adrs/0007-tier-3-payload-path.md) — Tier 3 payload path — `.review/` tracked directory on feature branch
- [ADR-0008](adrs/0008-tier-3-as-sole-intra-session-inter-agent-channel.md) — Tier 3 artifact handoff as sole sanctioned intra-session inter-agent evidence channel (supersedes ADR-0002)
- [ADR-0009](adrs/0009-pi-runtime-acquisition-strategy.md) — Pi runtime acquisition strategy: pin and fetch upstream release binary (parallel to ADR-0001)
- [ADR-0010](adrs/0010-setup-install-trust-posture.md) — setup.sh install-trust posture and nvm-mandatory node management (consumes ADR-0009)
- [ADR-0011](adrs/0011-toolchain-install-strategy.md) — developer toolchain install strategy: hybrid vendor + distro, mikefarah/yq (consumes ADR-0010)
- [ADR-0012](adrs/0012-vendored-pi-default.md) — pi default install path flipped to vendored binary; npm preserved indefinitely as `PI_USE_VENDORED=0` opt-out (partially supersedes ADR-0010 § Pi acquisition)
- [ADR-0013](adrs/0013-distribution-substrate-strategy.md) — distribution-substrate strategy: GitHub Template (α) + WSL2 rootfs (η) primary (amended by ADR-0014; further amended by ADR-0020)
- [ADR-0014](adrs/0014-oci-substrate-amendment-to-0013.md) — add OCI/GHCR container substrate (κ); originally reframed smolvm pack (ζ) as the sandbox substrate (amends ADR-0013; the ζ-reframing is retired by ADR-0020, but the cross-substrate amendments survive)
- [ADR-0015](adrs/0015-network-capable-extensions-and-the-first-party-docs-allowlist.md) — `web_fetch` extension: tight first-party-docs host allowlist as the security boundary for network-capable extensions; `web_search` explicitly rejected
- [ADR-0016](adrs/0016-smolvm-pack-substrate-details.md) — substrate ζ (smolvm pack) implementation details: R1 topology, bake matrix, registry, base image, headless auth, update story (superseded by ADR-0020)
- [ADR-0017](adrs/0017-substrate-zeta-path-b-framing.md) — substrate ζ audience contract: Path B (single-file portable; macOS + Debian first-class; Windows deferred) (superseded by ADR-0020)
- *ADR-0018 — number intentionally unallocated: reserved by ADR-0017 for the substrate-implementation answer, then closed by rescission rather than implementation; see [ADR-0020 § Numbering note](adrs/0020-rescind-substrate-zeta-smolvm-pack.md). No `adrs/0018-*.md` exists.*
- [ADR-0019](adrs/0019-compaction-optimizer-extension.md) — `compaction-optimizer` extension: dual-handler (`session_before_compact` + `session_compact`) with three modes (`deterministic` / `hybrid` (default) / `llm-only-with-dump`); pre-compaction archive + file-tracker pruning; establishes `extensionSettings.<name>.*` settings namespace and `~/.pi/agent/extensions/<name>/` as the per-extension data subtree; project-layer settings allowlist as trust-boundary
- [ADR-0020](adrs/0020-rescind-substrate-zeta-smolvm-pack.md) — rescind substrate ζ (smolvm pack) and remove smolvm support; substrate matrix reduces to α + η + κ (supersedes ADR-0016 and ADR-0017; amends ADR-0013 and ADR-0014)
- [ADR-0021](adrs/0021-extension-type-checking-and-linting.md) — type-checking and linting for `agent/extensions/`: per-extension `tsconfig.json` + ESLint v9 with `@typescript-eslint` type-aware rules + npx-pinned no-install tooling + integration via two sibling scripts called from `scripts/validate.sh`; vendored `subagent` in-scope
- [ADR-0022](adrs/0022-gh-identity-guard-extension.md) — `gh-identity-guard` extension: fail-closed `tool_call` guard on `bash` that intercepts mutating GitHub invocations (`gh <noun> <verb>` table + `gh api` method/field detection + `git push` blanket + bypass-DENY net) and blocks on identity drift via per-mutation `gh api /user --jq .login` probe; per-repo `.pi/expected-identity` as source-of-truth (tracked-only refinement in ADR-0027); three-surface override (`SKIP_GH_IDENTITY_GUARD=1` env + `.gh-identity-allowlist` file + `GH_IDENTITY_OVERRIDE=<login>` per-invocation); structurally supersedes the procedural fix in #251
- [ADR-0023](adrs/0023-gh-identity-guard-remote-scoping.md) — `gh-identity-guard` — host-scope the in-session `git push` classification to GitHub remotes only (Azure DevOps, GitLab, Bitbucket, self-hosted pass through)
- [ADR-0024](adrs/0024-gh-identity-guard-inline-skip.md) — `gh-identity-guard` — per-command inline `SKIP_GH_IDENTITY_GUARD=1` prefix + override-hint hardening
- [ADR-0025](adrs/0025-gh-identity-guard-interactive-bootstrap.md) — `gh-identity-guard` — interactive bootstrap of `.pi/expected-identity` at the no-expected-identity terminal state (operator-presence-gated: `/dev/tty` for the hook, `ctx.hasUI` for the extension); per-repo-only write target; re-type confirmation + personal-fork suggestion suppression; triggering operation still fails closed after the write (supersedes ADR-0022 §Q1 item 3 in part)
- [ADR-0026](adrs/0026-copilot-models-forward-fix-via-models-json.md) — forward-fix new GitHub Copilot models via `agent/models.json` (pi's documented merge-by-id provider-override mechanism) rather than waiting for pi releases; ships an empty framework-shaped scaffold; preserves VS Code Copilot Chat enablement and Copilot tier gating as upstream prerequisites; MAI-Code-1-Flash cited as the worked example of an upstream-tier-gated model the override cannot unlock
- [ADR-0027](adrs/0027-gh-identity-guard-tracked-expected-identity.md) — `gh-identity-guard` only trusts per-repo `.pi/expected-identity` when Git tracks the path (`git ls-files --error-unmatch`); untracked local pins are ignored with a warning and fallback to user-layer settings or fail-closed
- [ADR-0028](adrs/0028-agent-expertise-api-client.md) — `agent-expertise-api` client phase 1 is a local-only, Linux/macOS-only, API-key-authenticated, write-capable extension with `expertise_search` and create-only `expertise_create`; endpoint/API key come from env or fixed extension `.env.local`, remote/team/OIDC/Windows/update-delete are deferred
- [ADR-0029](adrs/0029-expertise-client-coexistence.md) — `expertise-client` performs a load-time coexistence check and stands down (registers nothing) when `SKIP_EXPERTISE_CLIENT` is truthy or the current project ships a `.pi/extensions` entry already registering `expertise_search`/`expertise_create` (e.g. the `agent-expertise-api` repo's in-process extension); yields the tool names to the project-local extension with no rename to ADR-0028's tool-name contract
- [ADR-0030](adrs/0030-shared-foundation.md) — Pi Extension Suite `shared/` foundation library at `agent/extensions/shared/`: a non-loadable library dir (no `index.ts`, so pi auto-discovery skips it) imported by relative `../shared/*.ts`; owns the suite usage thresholds, credentialed-candidate menu, cost table, notify formatting, and schema-versioned per-extension state (`~/.pi/agent/extensions/<name>/state.json`); `validate.sh` recognizes the library form
- [ADR-0031](adrs/0031-auto-router.md) — `auto-router` extension: per-prompt model selection via a cheap classifier on `before_agent_start` → `pi.setModel`, consuming `shared/`; `/auto`+`--auto` controls, per-session decision cache, total fallback (routing never blocks a turn); corrects the plan to use pi-ai `complete()` (not `streamSimple`) and fixes `shared/notify.ts` levels to the real `info|error|warning`
- [ADR-0032](adrs/0032-context-manager.md) — `context-manager` extension: cache-safe, zero-token context pruning on the `context` hook, consuming `shared/`; freezes each tool result's prune decision per `toolCallId` at first sight so the cached prefix never churns; rejects both adopt candidates (`pi-dcp`, `pi-context-prune`) at inspection for rewriting the prefix; `/prune`+`--prune` controls
- [ADR-0033](adrs/0033-codebase-indexing.md) — `indexing` extension: semantic `search_codebase` over the `cocoindex-code` (`ccc`) CLI engine with an idle-gated, single-flight `agent_end` re-index; rejects both adopt candidates (`@pi-unipi/cocoindex` wrong engine + LanceDB AGPL caveat; `pi-cocoindex` stale + namespace-incompatible) and builds custom; no MCP (CLI-only guard), untrusted-output framing, pinned model + transformers CVE floor; `/index`+`--index` controls; pin-not-copy toolchain record under `agent/vendor/cocoindex-code/`
- [ADR-0034](adrs/0034-cache-ratio-measurement.md) — `cache-meter` extension + `scripts/analyze-cache-ratio.sh`: the suite-wide prefix-churn / cache-ratio gate. Read-only `message_end` recorder (returns `undefined`, never churns; inert unless `CACHE_METER_CONFIG` set) → JSONL → per-config cache-hit-ratio + fresh-input/cost analysis vs baseline. Records the github-copilot cache-field gap (SDK #1073 → CHR SKIP + CFIT proxy); live measurement is operator-run, only the analysis self-test + unit tests are CI-gated
- [ADR-0035](adrs/0035-copilot-live-model-discovery.md) — `auto-router` live GitHub Copilot model discovery: query `/models` (JWT-derived auth + base) and drop `github-copilot` candidates that aren't `model_picker_enabled`/are `policy.state:disabled`, so the router stops routing to phantom/tier-gated models (the `gpt-5.4-nano` 400); fail-open to the static menu; clarifies ADR-0015's allowlist as `web_fetch`-tool-scoped (this first-party call is host-pinned, no off-host redirect, JWT never logged/cached); no-MCP compliant (filters a menu, never enters context)
- [ADR-0036](adrs/0036-dev-integration-main-stable-branch-model.md) — `dev` as the integration branch (normal PRs target `dev`) and `main` as the protected stable branch advanced by promotion PRs; hotfixes branch from `main` and propagate back to `dev` immediately
- [ADR-0037](adrs/0037-secret-scanner-tooling-strategy.md) — Gitleaks as the canonical setup-installed secret scanner; TruffleHog retained as optional/deep audit tooling
- [ADR-0038](adrs/0038-psmfd-pi-build-and-attest-trust-boundary.md) — `psmfd/pi` releases rebuild from mirrored source in PSMFD-controlled workflows and attest the resulting artifacts; upstream-built artifacts may be comparison inputs but are not re-attested as PSMFD provenance
- [ADR-0039](adrs/0039-mirror-sync-cadence-and-provenance.md) — `psmfd/pi` mirror sync: upstream-release-driven cadence with security fast path, local maintainer-run execution, main+tags namespace-isolated import, `--no-ff` merge with mechanical overlay conflict resolution, and a per-sync evidence block (policy: `docs/psmfd-pi-mirror-sync.md`)
- [ADR-0040](adrs/0040-consume-psmfd-attested-pi-releases.md) — the vendored pi runtime pins PSMFD-attested `psmfd/pi` releases (`vX.Y.Z-psmfd.N`; digest source is the attestation-verified `SHA256SUMS`); plain upstream pins remain the emergency-rollback path; amends ADR-0009's release surface, keeps its pin-and-fetch mechanism
- [ADR-0042](adrs/0042-standalone-extension-distribution.md) — first-party extensions are distributed via standalone public mirror repos (`psmfd/pi-<name>`, installed with `pi install git:...`); pi_config remains the source of truth with manual runbook sync; fresh-start mirror history with provenance notes; leaf extensions first, `shared/`-coupled extensions deferred pending an inlining pass
- [ADR-0043](adrs/0043-upstream-reporting-gate.md) — upstream documentation as the security-reporting gate: a vulnerability is reported upstream only when first-party docs establish the affected behavior is intended
- [ADR-0044](adrs/0044-security-overrides-for-vulnerable-transitive-deps.md) — security overrides for vulnerable transitive dependencies in the `psmfd/pi` mirror (pin-forward via overlay, tracked against upstream)
- [ADR-0045](adrs/0045-automate-mirror-sync-runbook.md) — automate the `psmfd/pi` inbound mirror-sync runbook with overlay tooling (`.psmfd/sync-upstream.sh`); divergence-sensitive judgement stays human-gated (policy: `docs/psmfd-pi-mirror-sync.md`)
- [ADR-0046](adrs/0046-psmfd-pi-main-ruleset-migration.md) — migrate `psmfd/pi` `main` to a ruleset with an Admin bypass plus a detective guard
- [ADR-0047](adrs/0047-release-automation-script.md) — script the `dev`→`main` release promotion (`scripts/release.sh`) with a manual merge gate
- [ADR-0048](adrs/0048-repo-agnostic-secret-scanner.md) — make `scan-secrets` repo-agnostic and shareable across repos (each supplies its own `.gitleaks.toml`)
- [ADR-0049](adrs/0049-genericize-runtime-config-via-templates.md) — ship runtime config as `*.example.json` templates; gitignore the live `settings.json`/`models.json` and seed them on install
- [ADR-0050](adrs/0050-outbound-distribution-mirror-sync.md) — a generic, manifest-driven outbound mirror-sync engine (`scripts/sync-mirror.sh` + `mirror/targets.yml`) for the config + extension distribution mirrors (runbook: `docs/outbound-mirror-sync.md`)
- [ADR-0051](adrs/0051-sendable-one-shot-installer.md) — a sendable one-shot installer (`install.sh`) on top of the verified public mirror
- [ADR-0052](adrs/0052-mirror-code-scanning-followup.md) — code-scanning follow-up process for the mirrors: free mirror-side CodeQL as the baseline, fix-at-source loop, dismissal log (`security/scanning-decisions.md`), and a HIGH/CRITICAL promotion gate (`scripts/check-mirror-alerts.sh`)
- [ADR-0053](adrs/0053-pin-github-actions-to-sha.md) — pin third-party GitHub Actions to full-length commit SHAs (with a `# vX.Y.Z` comment); vendored binaries stay content-pinned via `CHECKSUMS`

Tracked configuration for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

For distribution-substrate provenance (verification commands, content-audit guidance, author-side obligations) see [`docs/distribution-provenance.md`](docs/distribution-provenance.md).

`~/.pi` is symlinked to this repo, so everything under `agent/` is the live pi
configuration. Runtime artifacts (`auth.json`, `bin/`, `sessions/`) are
gitignored.

## Layout

```text
agent/
├── settings.example.json # Generic starter template (tracked) — setup.sh seeds settings.json from it (ADR-0049)
├── settings.json        # Live pi settings (gitignored, operator-owned; seeded from the template)
├── models.example.json  # Generic model-registry starter (tracked) — seeds models.json (ADR-0026/0049)
├── models.json          # Live custom-provider overrides (gitignored, operator-owned; forward-fix new Copilot models)
├── AGENTS.md            # Orchestration playbook (loaded as ~/.pi/agent/AGENTS.md)
├── skills/              # Auto-discovered skills (one dir per skill)
├── agents/              # Subagent wrappers (consumed by the subagent extension)
├── prompts/             # Slash-command workflows (/review, /security-review, /full-review, /vendor-update)
├── rules/               # Behavioral rules (referenced from AGENTS.md, loaded on demand)
└── extensions/          # TypeScript pi extensions
    ├── subagent/                 # Vendored from pi 0.78.0 (ADR-0001)
    ├── secrets-guard/            # Blocks write/edit/bash/artifact_review that would surface secrets
    ├── bash-destructive-guard/   # Blocks rm/mv outside safe path list
    ├── gh-identity-guard/        # Blocks mutating gh/git push on GitHub identity drift (ADR-0022/0027)
    ├── artifact-handoff/         # Registers `artifact_review` tool for Tier 3 (.review/) payloads
    ├── web-fetch/                # Registers `web_fetch` tool against first-party-docs allowlist (ADR-0015)
    ├── compaction-optimizer/     # Dual-handler compaction: archive + file-tracker pruning + deterministic/hybrid summary modes (active, `hybrid` default) (ADR-0019)
    ├── expertise-client/         # Local-only client for agent-expertise-api; registers `expertise_search` + create-only `expertise_create` (ADR-0028)
    ├── auto-router/              # Per-prompt model selection via cheap classifier on before_agent_start (Pi Extension Suite; ADR-0031)
    ├── context-manager/          # Cache-safe zero-token context pruning: freezes per-toolCallId prune decisions on the context hook (Pi Extension Suite; ADR-0032)
    ├── indexing/                 # Semantic codebase search via cocoindex-code (ccc) CLI; search_codebase tool + agent_end idle re-index (Pi Extension Suite; ADR-0033)
    ├── cache-meter/              # Read-only message_end recorder for the prefix-churn / cache-ratio gate; inert unless CACHE_METER_CONFIG set (Pi Extension Suite; ADR-0034)
    └── shared/                   # Library (no index.ts; not auto-loaded) — Pi Extension Suite signals/candidates/cost/notify/state foundation (ADR-0030)

adrs/                    # Architecture Decision Records (MADR format)
hooks/                   # Git hooks (opt-in via INSTALL_GIT_HOOKS=1 ./setup.sh)
├── secrets-guard.sh          # Pre-commit; same patterns as the pi extension
└── gh-identity-guard.sh      # Pre-push; blocks GitHub pushes on identity drift (ADR-0022/0027)
scripts/                 # Repo utilities
├── regen-agent-catalog.sh    # Regenerates the agent catalog table in agent/AGENTS.md
├── release.sh                # Cuts a release: dev→main promotion PR + annotated tag (ADR-0047)
├── retag-annotated.sh        # Converts lightweight release tags to annotated (semver-tagging)
├── sync-mirror.sh            # Outbound mirror-sync engine: config + extension mirrors (ADR-0050)
└── validate.sh               # Pre-PR validator: frontmatter, catalog sync, ADR uniqueness, links
mirror/                  # Outbound distribution-mirror sync config (ADR-0050)
├── targets.yml               # Per-mirror manifest (psmfd/pi-config + 5 extension mirrors)
└── sanitize/                 # sed programs applied to staged trees before publish
.review/                 # Tier 3 artifact handoff payloads (ADR-0006 / ADR-0007); never merged to main
.github/workflows/       # CI workflows
├── validate.yml              # Runs scripts/validate.sh on every PR (required status check)
├── sync-mirrors.yml          # Outbound mirror sync: PR dry-run gate + push-on-main (ADR-0050)
└── artifact-review-guard.yml # Fails any PR carrying the `artifact-review` label (required status check)
CODEOWNERS               # Owns `.review/**` only; belt-and-suspenders for the artifact-review guard
setup.sh                 # Idempotent installer: node + toolchain + pi, then symlinks ~/.pi (ADR-0010/0011)
install.sh               # Sendable one-shot bootstrap: clones psmfd/pi-config + installs extension mirrors (ADR-0051)
```

## Agents and workflows

Read-only specialists (`code-review-expert`, `security-review-expert`,
`checkmarx-expert`, `linter`, `docs-expert`, `gh-cli-expert`,
`gitflow-expert`, `work-item-management-expert`) are exposed as **subagents**
that run in isolated `pi` subprocesses with restricted tool sets. Invoke
them directly via the `subagent` tool, or via the slash workflows below.

Workflows (typed as `/<name>`):

| Command | Behavior |
|---|---|
| `/review` | 3-way parallel: code + security + linter |
| `/security-review` | Single-agent security focus |
| `/full-review` | 4-way parallel: above three plus checkmarx (requires `cx`) |
| `/vendor-update` | Vendor bump/re-audit workflow using [`docs/vendor-updates.md`](docs/vendor-updates.md) |

Orchestration behavior (task classification, routing, parallelism, output
format) is defined in [`agent/AGENTS.md`](agent/AGENTS.md), which pi loads
from `~/.pi/agent/AGENTS.md` as session context. Full rule text lives in
[`agent/rules/`](agent/rules/) and is loaded on demand. For vendored dependency
bumps and re-audits, use `/vendor-update` with the canonical guide at
[`docs/vendor-updates.md`](docs/vendor-updates.md).

See [ADR-0001](adrs/0001-subagent-orchestration-substrate.md) for the
orchestration architecture.

## Guardrails

Three always-on pi extensions block the highest-frequency catastrophic outcomes:

| Extension | Blocks | Override |
|---|---|---|
| [`secrets-guard`](agent/extensions/secrets-guard/README.md) | `write`/`edit`/`bash` calls that would surface PEM keys, AWS access keys, GitHub PATs, unencrypted vault files, or sensitive credential paths | `SKIP_SECRETS_GUARD=1` env, or `.secrets-guard-allowlist` glob |
| [`bash-destructive-guard`](agent/extensions/bash-destructive-guard/README.md) | `rm`/`mv` outside `/tmp`, the project `cwd`, or `~/.config/pi/bash-guard-safe-paths.conf`. Also blocks `bash -c '...'` and compound commands containing `rm`/`mv`. | `SKIP_DESTRUCTIVE_GUARD=1` env, or extend the safe-paths file |
| [`gh-identity-guard`](agent/extensions/gh-identity-guard/README.md) | Mutating `gh <noun> <verb>`, `gh api` (POST/PATCH/PUT/DELETE), and `git push` issued from `bash` when the active gh identity does not match the configured expected identity | `SKIP_GH_IDENTITY_GUARD=1` env, `.gh-identity-allowlist` substring, or `GH_IDENTITY_OVERRIDE=<login>` per-invocation |

### Two-layer identity enforcement

`gh-identity-guard` is delivered as a **pair** — the pi extension intercepts in-session `bash` calls, and a companion git pre-push hook ([`hooks/gh-identity-guard.sh`](hooks/gh-identity-guard.sh)) closes the raw-shell-outside-pi gap (plain terminal, IDE git client, scripts). The hook only fires on **GitHub remotes**; pushes to Azure DevOps (`dev.azure.com`, `*.visualstudio.com`), GitLab, Bitbucket, and self-hosted hosts pass through silently. Both layers share the same expected-identity resolution chain (git-tracked `<repo>/.pi/expected-identity` → `~/.pi/agent/settings.json` → fail-closed) via the shared [`scripts/lib/gh-verify-user.sh`](scripts/lib/gh-verify-user.sh) probe helper.

When **neither** trusted identity source is configured, the guard fails closed — but, with an operator present (a controlling terminal for the hook, an interactive `ctx.hasUI` session for the extension), it first offers to **bootstrap `<repo>/.pi/expected-identity`** ([ADR-0025](adrs/0025-gh-identity-guard-interactive-bootstrap.md)). The operator re-types the login (a suggestion is shown only when the active gh login matches the remote owner and the remote is not a personal fork, and is never auto-accepted); the file is then written and the triggering operation **still fails closed** so the operator adds/commits the new trust anchor and re-runs. Per [ADR-0027](adrs/0027-gh-identity-guard-tracked-expected-identity.md), an untracked local `.pi/expected-identity` is ignored until Git tracks it. In any non-interactive context (CI, IDE git clients, pipes, `-p`/JSON sessions) the original fail-closed error is unchanged — no prompt, no hang.

A companion git pre-commit hook ([`hooks/secrets-guard.sh`](hooks/secrets-guard.sh)) enforces the same secret patterns at commit time. Gitleaks is the broader repo/file/history audit layer installed by setup per [ADR-0037](adrs/0037-secret-scanner-tooling-strategy.md); run it through [`scripts/scan-secrets.sh`](scripts/scan-secrets.sh). The scanner is repo-agnostic ([ADR-0048](adrs/0048-repo-agnostic-secret-scanner.md)) and `setup.sh` installs it as `~/.local/bin/scan-secrets`, so it works from any repo (each supplies its own `.gitleaks.toml`): `scan-secrets --working-tree`, `--history`, or `--range OLD..NEW` (e.g. to scan an upstream-sync import range). Install all opt-in git hooks (pre-commit + pre-push) with:

```bash
INSTALL_GIT_HOOKS=1 ./setup.sh
```

## Validation

```bash
./scripts/validate.sh         # repo validator: metadata, docs, tests, typecheck, lint
VERBOSE=1 ./scripts/validate.sh
```

Run before opening a PR (per [post-implementation-review](agent/rules/post-implementation-review.md)). Required checks must actually run: missing Node/npx, unavailable extension dependencies, missing required test scripts, or skipped required suites are validation failures rather than warnings.

## Skills

21 skills with frontmatter normalized for the
[Agent Skills](https://agentskills.io/specification) standard (Copilot-specific
`paths:` blocks removed). **All 21 skills carry `disable-model-invocation: true`** — they are removed from the parent session's `<available_skills>` system-prompt auto-trigger block and only run via `/skill:<name>` (manual) or via the matching agent wrapper through the `subagent` tool. This enforces agent-first routing structurally and reclaims ~7–11 KB of parent context per session. See [ADR-0001](adrs/0001-subagent-orchestration-substrate.md) for the original subagent-substrate decision; the three review specialists remain *additionally* gated by opus pinning and a read-only tool allowlist.

| Skill | Purpose |
|---|---|
| ansible-expert | Playbooks, roles, inventory, ansible-core |
| aws-expert | IAM (incl. IRSA, SCPs), S3, Route 53, VPC, EKS, ECR, ECS, EB, MSK |
| azure-devops-expert | Repos, YAML pipelines, Boards, az devops CLI |
| azure-infra-expert | Entra ID, Key Vault, networking, Log Analytics |
| checkmarx-expert | Checkmarx One CLI — use via `checkmarx-expert` agent wrapper |
| code-review-expert | Semantic code review — use via `code-review-expert` agent wrapper |
| docker-expert | Dockerfiles, BuildKit, Compose v2, security |
| docs-expert | Documentation style, curation, Mermaid |
| dotnet-expert | .NET 10 SDK, ASP.NET Core, EF Core, dotnet CLI |
| gh-cli-expert | GitHub CLI (issue/pr/release/run/api) |
| gitflow-expert | Branching strategies, PR/release workflows |
| helm-expert | Helm 3 chart authoring, values, hooks |
| hyperv-expert | Hyper-V architecture, nested virt, WSL2 utility-VM, WHPX, VBS/HVCI |
| linter | Multi-tool lint runner with auto-fix |
| pi-agent-expert | pi CLI, extensions, agents/skills, our vendored subagent |
| security-review-expert | Security review — use via `security-review-expert` agent wrapper |
| shell-expert | Bash/Zsh/POSIX, coreutils, idioms |
| tauri-expert | Tauri 2 desktop apps, plugins, sidecars, CI |
| vcluster-expert | Virtual cluster lifecycle and config |
| work-item-management-expert | GitHub Issues/Projects v2, ADO Boards |
| wsl2-expert | `wsl.exe` CLI, `wsl.conf`/`.wslconfig`, export/import, systemd-in-WSL2, networking modes |

All 21 skills are hidden from the parent system prompt and load on demand — either via the matching agent wrapper through the `subagent` tool (the standard path), or manually via `/skill:<name>` tab-completion.

## Setup on a new machine

**Sendable one-shot install** (recommended for recipients of the public mirror, per [ADR-0051](adrs/0051-sendable-one-shot-installer.md)) — save [`install.sh`](install.sh) and run it; it clones the public mirror [`psmfd/pi-config`](https://github.com/psmfd/pi-config), runs `setup.sh`, and installs the first-party extensions from their own public mirrors:

```bash
bash install.sh                 # or: bash install.sh --dir ~/pi-config --dry-run
```

The mirror ships **generic config only** — no maintainer personalizations. Pass `--owner/--repo/--gh-login` to also personalize the clone for your own fork.

**Manual** (clone + setup directly):

```bash
git clone <this-repo> ~/projects/pi_config
cd ~/projects/pi_config && ./setup.sh
```

`setup.sh` is idempotent and **actively installs** the dependencies pi_config requires, per [ADR-0010](adrs/0010-setup-install-trust-posture.md) (install-trust posture) and [ADR-0011](adrs/0011-toolchain-install-strategy.md) (toolchain channels). On a fresh box it will:

1. **§1 Node** — Install [nvm](https://github.com/nvm-sh/nvm) (from the pinned, sha256-verified `agent/vendor/nvm/` snapshot) and Node.js 24.x via nvm. nvm itself is per-user (no sudo).
2. **§1b Toolchain** — Install the developer toolchain per [ADR-0011](adrs/0011-toolchain-install-strategy.md) and [ADR-0037](adrs/0037-secret-scanner-tooling-strategy.md):
   - **Vendor-pinned (sha256-verified, no sudo):** `gh` (`agent/vendor/gh/`), `yq` (mikefarah, `agent/vendor/yq/`), `shellcheck` (`agent/vendor/shellcheck/`), `gitleaks` (`agent/vendor/gitleaks/`). Each symlinks into `~/.local/bin/`.
   - **Distro-managed (sudo gated):** `jq`, `yamllint` via `apt`/`dnf`/`brew`. Linux installs require `PI_ALLOW_SUDO_APT=1` or `PI_ALLOW_SUDO_DNF=1` (off by default).
   - **npm-managed (nvm-managed npm, no sudo):** `markdownlint-cli2`.
   - Per-tool failures are warnings, not fatal — the rest of the toolchain still installs. The summary line reports how many failed.
   - **⚠️ Why our `yq` and not the one `apt` gives you:** `apt install yq` on Debian/Ubuntu installs `kislyuk/yq` (a Python wrapper around `jq`), which uses different syntax from `mikefarah/yq`. We pin mikefarah to close the cross-platform footgun. See [ADR-0011 § "Why mikefarah/yq specifically"](adrs/0011-toolchain-install-strategy.md#why-mikefarahyq-specifically) for the full comparison.
3. **§2 pi** — Install pi. Default path: fetch the pinned binary via [`fetch_pi_binary()`](scripts/lib/fetch-pi-binary.sh) (per [ADR-0009](adrs/0009-pi-runtime-acquisition-strategy.md) and [ADR-0012](adrs/0012-vendored-pi-default.md)) and symlink `~/.local/bin/pi`. Opt-out path: `PI_USE_VENDORED=0` falls back to the legacy `npm install -g @earendil-works/pi-coding-agent` flow, preserved indefinitely per ADR-0012.
4. **§2c Seed config** — Seed `agent/settings.json` and `agent/models.json` from their tracked `*.example.json` templates if absent (per [ADR-0049](adrs/0049-genericize-runtime-config-via-templates.md)). The live files are gitignored and operator-owned; an existing file is never overwritten, so your provider/model/theme choices are preserved across re-runs.
5. **§3 Symlink** — Symlink `~/.pi` to this repo. If a real `~/.pi` directory already exists, its runtime data (`auth.json`, `bin/`, `sessions/`) is migrated into the repo and the previous directory is moved aside as `~/.pi.preinstall.<ts>`.
6. **§4 Verify** — Verify all skills, agents, prompts, rules, and extensions are discoverable.

Useful flags and environment variables:

| Flag / env var | Effect |
|---|---|
| `--dry-run` | Print every install command without executing. Threads through every mutation site: `§1` nvm/node, `§1b` toolchain, `§2` pi acquisition, `§3` `~/.pi` symlink, `§5` git hook. |
| `--help` | Print the script's header block enumerating every flag and env-var. |
| `PI_CONFIG_SKIP_DEPS=1` | Umbrella opt-out: skip every install phase (`§1` + `§1b` + the active-install branches of `§2`). Preserves historical check-and-warn behavior. For power users with their own toolchain. |
| `PI_CONFIG_SKIP_NVM=1` | Skip just `§1` (nvm/node). `§1b` and `§2` still install. |
| `PI_CONFIG_SKIP_TOOLCHAIN=1` | Skip just `§1b` (developer toolchain, including Gitleaks). `§1` and `§2` still install. |
| `PI_CONFIG_SET_DEFAULT_NODE=1` | Set Node 24 as nvm's `default` alias. Off by default so we don't silently mutate users with another version pinned. |
| `PI_USE_VENDORED=0` | Opt out of the default vendored pi path; install via `npm install -g @earendil-works/pi-coding-agent` instead. Only the literal `0` selects the npm path; any other value (or unset) selects the default vendored path. Preserved indefinitely per [ADR-0012](adrs/0012-vendored-pi-default.md) for environments that prefer npm-managed installs (e.g. corporate networks that proxy npmjs.org but block GitHub release assets). |
| `PI_ALLOW_SUDO_NPM=1` | Allow the legacy `npm install -g` path to retry with `sudo` on permission failure. Off by default — the nvm-managed npm of the active-install path never needs sudo. |
| `PI_ALLOW_SUDO_APT=1` | Allow `§1b` toolchain distro installs (`jq`, `yamllint`) to invoke `sudo apt-get install` on Debian/Ubuntu. Off by default per [ADR-0011](adrs/0011-toolchain-install-strategy.md). |
| `PI_ALLOW_SUDO_DNF=1` | As `PI_ALLOW_SUDO_APT` but for Fedora/RHEL `dnf`. Off by default. |
| `PI_UPDATE=1` | Upgrade pi to the latest published version (npm path only). |
| `INSTALL_GIT_HOOKS=1` | Symlink [`hooks/secrets-guard.sh`](hooks/secrets-guard.sh) into `.git/hooks/pre-commit` AND [`hooks/gh-identity-guard.sh`](hooks/gh-identity-guard.sh) into `.git/hooks/pre-push` for this repo. |

For persistent local defaults, copy `setup.local.env.example` to `setup.local.env` in the repo root. `setup.sh` reads that file when present, but only for `PI_CONFIG_SET_DEFAULT_NODE` and `INSTALL_GIT_HOOKS`; explicit environment variables still take precedence.

Preview a fresh install before committing to it:

```bash
PI_ALLOW_SUDO_APT=1 ./setup.sh --dry-run
```

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 TheSemicolon.

The MIT grant covers the configuration content tracked in this repository. Vendored upstream binaries under [`agent/vendor/`](agent/vendor/) (pi, nvm, gh, mikefarah/yq, shellcheck, gitleaks) retain their own upstream licenses; see each subdirectory's `README.md` for provenance.
