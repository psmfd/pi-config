---
status: Accepted
date: 2026-06-07
---

# ADR-0026: Forward-fix new GitHub Copilot models via `agent/models.json` rather than waiting for pi releases

**Status:** Accepted
**Date:** 2026-06-07
**Related:** None (this is the first ADR touching pi's custom-provider mechanism)

## Context and Problem Statement

Pi treats its `github-copilot` provider's model catalog as release-pinned: per the installed `docs/providers.md`, *"For each provider, pi knows all available models. The list is updated with every pi release."* New Copilot models therefore become usable through pi only after (a) GitHub adds them to the Copilot Chat catalog server-side, (b) the operator enables them in VS Code's Copilot Chat model picker, AND (c) the pi maintainers ship a release with the new id baked into their provider definition.

Step (c) is the bottleneck. The lag between Copilot exposing a model and pi shipping a release that knows about it is open-ended — measured in weeks for prior models. During that window, the orchestrator cannot reach the model from pi even though Copilot would serve it.

The triggering question: *"Can we update the Pi Agent's Copilot integration to support all CLI-available Copilot models?"* — specifically including MAI-Code-1-Flash. Investigation established:

1. Pi 0.78.1 ships 22 Copilot models in its hardcoded catalog (`pi --list-models | grep -c '^github-copilot'` returns `22`); MAI-Code-1-Flash is not one of them.
2. The user's VS Code Copilot Chat debug log (2026-04-30 snapshot) shows 38 models served by `api.githubcopilot.com/models` to the account; MAI-Code-1-Flash is not in that list either.
3. The user's Copilot subscription is Enterprise tier, and MAI-Code-1-Flash is not exposed to Business or Enterprise tiers as of 2026-06-07.

(3) means MAI-Code-1-Flash is *upstream-gated*: no local pi_config change can unlock it. But (1) is a recurring drag that any new Copilot model will hit — patternable, solvable here.

## Considered Options

- **A. Wait for upstream pi releases for every new Copilot model.** Rejected: lag is open-ended; we have already observed it (raptor-mini, gpt-5.5 entries arrived only in 0.78.x); contradicts the orchestrator's needs.
- **B. Fork pi and maintain a downstream patch with our own catalog.** Rejected: enormous maintenance surface for a per-release one-line change; the framework already provides a documented override mechanism.
- **C. Add models via `~/.pi/agent/models.json` provider override (chosen).** Pi's `docs/models.md` documents an explicit "Overriding Built-in Providers" mechanism with merge-by-id semantics: custom models with new ids are added alongside built-ins; matching ids replace. JSONC comments and trailing commas are supported. This is the same mechanism pi documents for Ollama/vLLM/local-model registration — not a hack.
- **D. Dynamic catalog-sync script.** Considered as a complement, not a replacement. Deferred: the scaffold in option C is what the override file needs to look like regardless, and the user has not asked for a sync cadence.

## Decision Outcome

### Scope

- **`agent/models.json`** is added to the repo as the canonical override file. It carries an empty `providers["github-copilot"].models` array plus a JSONC header documenting:
  - merge-by-id semantics (verbatim from `docs/models.md`),
  - VS Code Copilot Chat enablement prerequisite (verbatim from `docs/providers.md`: *"If you get 'model not supported', enable it in VS Code: Copilot Chat → model selector → select model → 'Enable'"*),
  - upstream tier gating as an irreducible constraint (MAI-Code-1-Flash cited as the worked example),
  - verification recipe (`pi --list-models <pattern>`).

- **`setup.sh`** is extended to mirror the existing `settings.json` backup-if-differs block: if the operator's pre-installation `~/.pi/agent/models.json` differs from the repo's, back it up with the `.preinstall.<ts>` suffix before the symlink swap. New blocks at both the dry-run and real paths.

- **`agent/skills/pi-agent-expert/references/settings-and-config.md`** is updated with a `models.json` subsection so the skill's authoritative reference points future runs at this file.

- **`README.md`** directory tree is updated to include `agent/models.json` per the documentation-sync rule.

### Non-scope

- **No live model is added in this ADR's PR.** The scaffold is empty. Adding any specific model (MAI-Code-1-Flash or otherwise) requires that model to be enabled in the operator's VS Code Copilot Chat picker AND exposed to the operator's tier, neither of which we can verify from CI.
- **No changes to `defaultModel` or any subagent `model:` frontmatter.** Both currently reference exact ids that exist in `pi --list-models`. Pattern-based resolution was investigated and rejected for this use (`opus` matches sonnets; `gpt-5` matches Gemini and Claude entries — pi's matcher is fuzzy across the version-number `.5` token).
- **No catalog-sync script.** Out of scope for this decision; can be a separate ADR if/when ongoing drift becomes a problem.

### Threat model

- **Upstream id collision.** If a future pi release adds a model with the same id we previously added via `models.json`, the override silently *replaces* the built-in entry. This is by design per pi's documented merge semantics. Mitigation: when a pi release lands, the operator inspects the changelog and prunes any now-redundant entries from `models.json`.
- **Stale entries.** A model id that Copilot later removes server-side will appear in `pi --list-models` until the operator removes it. Resolution failures at request time will be loud (pi surfaces the proxy error). No silent data loss.
- **No new attack surface.** `models.json` runs only inside pi; it does not introduce network listeners, MCP servers, or external content injection (compatible with `no-mcp-servers` rule). The Copilot proxy still authenticates via the same OAuth flow Pi already uses for the built-in `github-copilot` provider.

## Consequences

- New Copilot models become usable without waiting for upstream pi releases, gated only by Copilot's own enablement and tier rules.
- The repo carries one more documentation-sync pair (`agent/models.json` + this ADR + the pi-agent-expert reference); the post-implementation-review rule's per-task gate already covers maintaining it.
- MAI-Code-1-Flash specifically remains unreachable until Microsoft enables it for the Enterprise tier; this ADR codifies why the local override path cannot help, so the next "can we add MAI?" question lands in this file's history rather than re-running the investigation.

## Verification

After this ADR's PR merges:

1. `pi --list-models` still shows the 22 baseline Copilot models (no regression).
2. `setup.sh` dry-run reports the new `models.json` line in its preview output.
3. `scripts/validate.sh` passes.
