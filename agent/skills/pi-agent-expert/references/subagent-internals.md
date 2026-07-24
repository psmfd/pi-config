# Subagent extension internals

Authoritative sources are `agent/extensions/subagent/*.ts`, its tests,
`PATCH_MANIFEST.json`, and `agent/extensions/subagent/README.md`. This reference
summarizes stable seams without pinning brittle line numbers.

## Provenance and patch inventory

The extension is paired to upstream pi's 0.80.2 subagent example and was audited
against the installed v0.80.6-psmfd.1 runtime. Upstream's example remained
byte-identical across that interval. The README patch table is the canonical
inventory for local patches #3–#14; `PATCH_MANIFEST.json` plus
`scripts/validate-subagent-drift.sh` fail closed on unrecorded vendored drift.

Patches #1 and #2 (full parallel output and failed-task diagnostics) were dropped
when upstream adopted them. Do not infer the current patch count from historical
issue prose; read the table and manifest.

## File layout

```text
agent/extensions/subagent/
├── index.ts                 # tool schema, policy, subprocesses, concurrency, rendering
├── agents.ts                # discovery, frontmatter, shadow gate
├── model-pin.ts             # registry/live gate and fallback helpers
├── policy-model.ts          # matrix/tier/local-eligibility selection
├── sanitize-env.ts          # default and strict child environments
├── expertise-wiring.ts      # canonical expertise injection/collection
├── test/                    # focused policy, spawn, env, shadow, expertise tests
├── PATCH_MANIFEST.json      # recorded local patch signatures
└── README.md                # upstream pairing and authoritative patch table
```

## Agent discovery and frontmatter

User wrappers are loaded from `~/.pi/agent/agents/*.md`. Project wrappers are
loaded from the nearest ancestor `.pi/agents/*.md` when `agentScope` is
`project` or `both`. Under `both`, project names override user names, subject to
the guard-profile shadowing gate.

`AgentConfig` parses these wrapper fields:

| Field | Meaning |
|---|---|
| `name`, `description` | Required catalog identity and summary. |
| `tools` | Optional comma-separated child `--tools` allowlist. Omission leaves pi's default tool surface and is structurally local-forbidden. |
| `model` | Optional explicit model escape hatch. No first-party wrapper currently uses it. |
| `guard-profile` | Recognized enforcement profile (`report-only` today). |
| `env-strict` | Literal-true strict child environment mode. |
| `env-allow`, `env-allow-prefix` | Per-wrapper strict-environment extensions. |
| `local-llm` | Literal-true local eligibility tag; never overrides the bash/unrestricted floor. |
| `capability-tier` | `frontier`, `capable`, or `fast` matrix quality request. |

The Markdown body becomes the child's appended system prompt. Fields such as
`thinking`, `max_turns`, `extensions`, and `skills` are not parsed.

### Guard-profile shadowing

A project wrapper colliding with a guard-profiled user wrapper is inspected even
under project-only scope. Tool widening is refused. Profile weakening requires
interactive confirmation, fails closed headlessly, and inherits the stronger
user profile when approved. This gate is deliberately independent of the
caller-controlled `confirmProjectAgents` parameter.

## Tool schema and modes

Exactly one mode is accepted:

| Mode | Parameters |
|---|---|
| Single | `agent`, `task`, optional `cwd`, optional `expertiseInjection` |
| Parallel | `tasks[]` containing agent/task/cwd/expertiseInjection |
| Chain | `chain[]`; `{previous}` expands to the prior step's output |

Shared parameters are `agentScope` and `confirmProjectAgents`. Parallel mode is
runtime-capped at eight tasks and uses a four-worker concurrency limiter.

Project-agent confirmation and guard-profile shadow confirmation are distinct:
the latter cannot be disabled by a tool parameter.

## Canonical model policy

At tool execution, the extension obtains ADR-0104's canonical availability
snapshot and the reviewed routing matrix:

1. Explicit `model:` remains authoritative when present.
2. Otherwise `selectSubagentPolicyModel()` applies capability/tier policy to the
   snapshot candidates.
3. `local-llm: true` permits the local lane only when the global
   `extensionSettings.localLlm.role` is `full` and the wrapper is not
   structurally local-forbidden.
4. Wrappers with omitted tools or a `bash` tool remove local candidates. If no
   non-local matrix candidate exists, spawn fails closed.
5. Every explicit or policy-selected qualified model passes the spawn-time
   registry/live gate. A dropped non-Copilot model may use the configured
   Copilot fallback rung before session-default behavior; the result note names
   the effective rung.
6. ADR-0122 runtime failover applies only to an unpinned policy-selected child:
   one structured 429 before any tool edge marks the exact model in the shared
   session deny set and permits one deterministic reselection. Explicit pins,
   session-default children, generic errors, and post-tool failures never replay.

Parent and child policy share Copilot, Anthropic, and oMLX evidence from one
frozen generation plus one process-local dynamic session deny set. Provider
discovery is not repeated per child. Session start clears snapshot/provider and
deny state; parent `/auto matrix refresh` explicitly replaces snapshot evidence
and clears deny state only with `--retry-unavailable`.

## Child environment and prompt boundary

Children run as direct subprocesses (`shell: false`) in JSON print mode with
`--no-session`. The wrapper system prompt is written to a mode-0600 temporary
file so prompt contents do not enter argv; cleanup runs after process exit.

`buildChildEnv()` applies always-denied expertise credentials and either:

- default passthrough with explicit denies, or
- `env-strict: true` allowlist mode plus justified wrapper extensions.

Secret-suffix keys remain denied unless exactly re-allowed, and always-deny wins.
A recognized guard profile is exported by the parent; children cannot self-certify.

Canonical expertise is injected into the user-role `Task:` framing, never via a
network-sourced system message. Returned `EXPERTISE_CANDIDATES` are extracted,
coalesced, and surfaced as structured result details. Child output cannot invoke
expertise creation.

## Event stream and rendering

Stdout is parsed line-by-line as JSON. Assistant `message_end` events accumulate
messages, usage, model, stop reason, and errors. All three tool execution edges
(`tool_execution_start`, `tool_execution_update`, `tool_execution_end`) refresh
the parent UI without being added to final message accumulation.

The effective model appears in invocation/progress/result labels. A selected
model is known at spawn; otherwise the label remains `model pending` until child
telemetry identifies it. Runtime failover details retain attempted models,
failed/fallback IDs, outcome, and snapshot generation/hash; rendering shows the
model path while usage aggregates both bounded attempts.

Collapsed rendering shows per-agent usage summaries. Expanded rendering shows
full transcripts and tool previews. Parallel result text is capped at 50 KiB per
task. Abort signals terminate the child and surface an aborted result.

## Stable constants and limits

| Limit | Value |
|---|---|
| Parallel task count | 8 |
| Concurrent parallel children | 4 |
| Per-task returned parallel output | 50 KiB |
| Child session persistence | Disabled (`--no-session`) |

## Known boundaries

- Project agent path is `.pi/agents`, not `.pi/agent/agents`.
- Unknown wrapper frontmatter is ignored.
- `-p` children have no documented parent-to-child stdin steering channel.
- Explicit slash-less model patterns remain delegated to pi's own matching.
- Qualified-pin registry unreadability retains the documented fail-open pin
  behavior, while provider-matrix selection has no candidates.

## Adding wrapper features

A new frontmatter feature normally requires coordinated changes to:

1. `AgentConfig` and parsing in `agents.ts`;
2. policy, argv, or environment composition in `index.ts` and its helper module;
3. focused tests and the strict type/lint gates;
4. the subagent README patch table and `PATCH_MANIFEST.json` when vendored source
   changes.

Subagent source changes must run the drift validator/regenerator described in
the README. Do not update this reference as a substitute for patch provenance.
