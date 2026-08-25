# Subagent extension internals

The vendored extension lives at `agent/extensions/subagent/` and is paired with upstream pi 0.80.2 while audited against the current runtime pin. Local differences are registered in `README.md` and hash-locked by `PATCH_MANIFEST.json`.

## Modes

| Mode | Parameters | Semantics |
|---|---|---|
| Single | `agent`, `task`, optional `cwd`/`expertiseInjection` | One isolated child |
| Sequence | `sequence[]` items | Independent serial execution, max 8, concurrency 1, continue after failures, aggregate all results |
| Chain | `chain[]` steps | Dependent serial execution, optional `{previous}`, fail-fast |

`agentScope` and `confirmProjectAgents` are shared. Exactly one mode must be supplied.

Sequence and chain are intentionally distinct. Sequence never substitutes previous output. This protects divergent research and consensus replicas from anchoring. Chain is appropriate only when a later step depends on the preceding output.

## Dispatch

One availability snapshot, registry set, routing matrix, and local-role value are captured per tool call. Each child still resolves live provider-breaker state at spawn time. Sequence iterates with `await runSingleAgent(...)`; queued items use `exitCode: -2`, the active item uses `-1`, and completed results retain real exit codes.

A failed sequence item is recorded and execution continues. A failed chain step returns immediately with `isError: true`.

## Rendering and Results

`SubagentDetails.mode` is `single | sequence | chain`. Multi-result rendering shows queued, running, completed, and failed states plus aggregate usage. Final sequence text includes every child's full summary in input order; each item is capped at 50 KiB in text while complete messages remain in tool details.

## Expertise Wiring

Each single/sequence/chain item may carry `expertiseInjection`. `buildInjectedTaskArg` prepends it to the user-role `Task:` argument. It never uses `--append-system-prompt`.

For research-shaped sequences, the historically named `expertise-fanout-gate` performs one canonical search and injects the identical block into every sequence item. `expertise-wiring.ts` extracts Form A/B candidate payloads and coalesces them across completed children.

## Isolation and Safety

- Each child runs in a separate pi process.
- Spawn depth defaults to one; children cannot delegate grandchildren.
- Wrapper tool lists, guard profiles, strict environment policy, and context-file suppression apply per child.
- Project wrapper shadowing is checked before any child starts.
- Explicit pins, provider policy, runtime failover, and session deny state are resolved at spawn.

## Validation

Run:

```sh
./scripts/test-subagent.sh
./scripts/validate-subagent-drift.sh --regenerate
./scripts/typecheck-extensions.sh
./scripts/lint-extensions.sh
```

Any `index.ts` or `agents.ts` change requires both patch-table documentation and manifest regeneration.
