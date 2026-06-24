# cocoindex-code vendor pin

> **Pinned to cocoindex-code `0.2.35`** (source: [PyPI `cocoindex-code`](https://pypi.org/project/cocoindex-code/)), embedding model **`Snowflake/snowflake-arctic-embed-xs`** at HuggingFace revision `d8c86521100d3556476a063fc2342036d45c106f`.
>
> Trust posture: pin-not-copy ([ADR-0009](../../../adrs/0009-pi-runtime-acquisition-strategy.md)); adoption rationale: [ADR-0033](../../../adrs/0033-codebase-indexing.md). When bumping, record the new version in the commit message and refresh `CHECKSUMS`.

## Why this pin differs from the other vendor pins

The `gh`/`yq`/`shellcheck` pins (ADR-0011) and the `pi`/`nvm` pins (ADR-0009/0010)
record **downloadable platform binaries** verified by `sha256sum -c` against a
fixed four-triple asset matrix. `cocoindex-code` (`ccc`) is acquired differently:

- **The engine is a PyPI package**, installed out-of-band via
  `pipx install --python python3.13 'cocoindex-code[full]'` (Python ≥ 3.11). pip
  performs its own hash verification against PyPI; there is no platform tarball
  matrix to mirror here. `VERSION` records the exact engine version we built and
  verified against.
- **The embedding model is a HuggingFace download** fetched on first `ccc index`
  by `sentence-transformers`. HuggingFace verifies on first download but does not
  re-verify cached files (huggingface_hub#2364), so `CHECKSUMS` records the
  SHA-256 of the pinned model files as a trust-on-first-use mitigation, and the
  model is pinned to an immutable revision (above).

This pin is therefore a **verifiable record**, not a download manifest consumed by
`setup.sh`. It is the single source the extension's [`pin.ts`](../../extensions/indexing/pin.ts)
mirrors and that a future model-integrity check verifies against.

## What's here

| File | Purpose |
|---|---|
| `VERSION` | Single line, the pinned PyPI version (bare semver, e.g. `0.2.35`). |
| `CHECKSUMS` | `sha256  filename` pairs for the pinned embedding-model files (`model.safetensors` is the weights). |
| `README.md` | This file. |

## Security notes (ADR-0033)

- **No MCP.** `cocoindex-code` ships an MCP server (`ccc mcp`, plus the
  `cocoindex-code` console entry point). The indexing extension's
  `assertCliInvocation` guard fails closed on either — only the `ccc` CLI
  search/index/status path is ever launched. Per `agent/rules/no-mcp-servers.md`.
- **transformers CVE floor.** The `[full]` extra pulls `transformers`; pin
  `>= 5.3.0` to avoid CVE-2026-4372 (resolved 5.10.2 at pin time).
- **Telemetry.** The extension sets `COCOINDEX_DISABLE_USAGE_TRACKING=1` on every
  invocation so no usage events leave the host.

## License

- `cocoindex-code` and the `cocoindex` engine: **Apache-2.0**.
- `Snowflake/snowflake-arctic-embed-xs`: **Apache-2.0**.
- `sentence-transformers`, `sqlite-vec`: **Apache-2.0**.

No AGPL in the directly auditable closure (the LanceDB AGPL caveat applies to
`@pi-unipi/cocoindex`, which this extension does **not** use — see ADR-0033).
