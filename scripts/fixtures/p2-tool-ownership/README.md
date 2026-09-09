# P2 installed-pi tool-ownership fixtures

These fixtures prove registry ownership and contract feasibility only, the P2
gate of [ADR-0157](../../../adrs/0157-provenance-checked-final-expertise-mutation-executors.md).
They are loaded only by `scripts/test-p2-tool-ownership.sh`, a required
`scripts/validate.sh` stage, and are not production extensions. The ownership
fixture registers its `write`/`bash` owners only when `PI_P2_ENABLE_OVERRIDES=1`,
which is what the harness's red-first legs rely on.

- `ownership-extension.mjs` registers same-name `write` and `bash` definitions
  from the pinned pi runtime, records effective `sourceInfo` and active-tool
  state, and exposes reload commands. Its tagged operations prove which executor
  produced a disk effect without changing the model-visible contract.
- `collision-extension.mjs` deliberately competes for `write`, `edit`, or `bash`;
  installed pi must refuse each collision before startup completes.
- `late-registration-extension.mjs` registers nothing at load; its
  `/p2-late-register <tool>` command registers a same-name pinned factory
  definition from inside a handler, proving post-load replacement semantics.
- `rpc-lifecycle.mjs` drives reload, session replacement, and active-tool changes
  (`--scenario lifecycle`) or the post-load registration sequence
  (`--scenario late`) over the documented LF-delimited RPC protocol.
- `tool-call-provider.mjs` uses pi-ai's in-process faux provider to emit fixed
  tool calls without credentials or external network access.

The positive fixture proves registry ownership and contract feasibility only.
Its `bash` owner runs pi's unconfined local operations; it does not invoke the
confinement wrapper or launcher. It does not provide P3's installed generation,
P5's Landlock-confined final mutation executors, or P6's protected-root race
canaries.
