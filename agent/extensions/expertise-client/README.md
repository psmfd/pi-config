> **First-party** pi extension. Local client for `agent-expertise-api`. See [ADR-0028](../../../adrs/0028-agent-expertise-api-client.md) and tracking issue #149.

# expertise-client

A local-only pi extension that talks to a developer's locally-running
[`agent-expertise-api`](https://github.com/psmfd/agent-expertise-api). Phase 1
(per ADR-0028) is **Linux/macOS only, loopback only, API-key authenticated**.

This extension registers the read-side tool `expertise_search` (#317) and the
create-only `expertise_create` tool (#318).

## Coexistence (ADR-0029)

This client is installed globally (`~/.pi/agent/extensions/`), so it loads for
**every** pi session. The
[`agent-expertise-api`](https://github.com/psmfd/agent-expertise-api) repository
ships its **own** project-local extension (`.pi/extensions/expertise-api/`) that
registers `expertise_search`/`expertise_create` directly. Because pi requires
globally-unique tool names, launching pi inside that repo with both active fails
extension load with a tool-name conflict.

To avoid the collision, the client **stands down** (registers nothing) when the
current project already defines a conflicting expertise tool — the project-local
extension wins. Detection scans the project-local extension discovery paths
(`<cwd>/.pi/extensions/<dir>/index.ts` and the single-file form
`<cwd>/.pi/extensions/<name>.ts`) for a conflicting tool-name registration and
fails open (registers normally) on any read error. Set
`SKIP_EXPERTISE_CLIENT=1` to force stand-down unconditionally.

## Tools

| Tool | Kind | Notes |
|---|---|---|
| `expertise_search` | read-only | Queries the local API for expertise entries. Output is **advisory** and must be cross-checked against the static agent catalog. |
| `expertise_create` | create-only write | Creates a single entry. Double-gated: requires `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1` **and** a clean body-secret scan. No update/delete/archive/approve. |

## Configuration

Configuration comes from `process.env` and a single FIXED file —
`agent/extensions/expertise-client/.env.local` — and nothing else. The
extension never walks parent directories and never reads a repository's own
`.env`, so a checked-out project cannot redirect the endpoint or supply
credentials.

Precedence: `process.env` > `.env.local` > built-in defaults.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PI_EXPERTISE_API_BASE_URL` | no | `http://127.0.0.1:8080` | Loopback origin of the local API. Non-loopback hosts are refused. |
| `PI_EXPERTISE_API_KEY` | **yes** | — | Sent as `x-api-key` on every call. Never logged or surfaced. |
| `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE` | only for writes | `0` | Opt-in for `expertise_create`. Must be `1` to enable create. Ignored by search. |
| `SKIP_EXPERTISE_CLIENT` | no | `0` | Override: when truthy, the client registers no tools (see [Coexistence](#coexistence-adr-0029)). |

Copy `.env.example` to `.env.local` and fill in your key:

```bash
cp agent/extensions/expertise-client/.env.example agent/extensions/expertise-client/.env.local
# then edit .env.local and set PI_EXPERTISE_API_KEY
```

`.env.local` is gitignored. Only `.env.example` is tracked.

## Refusal policy (per-rule)

All of the following are **hard refusals** (fail closed, no override in phase 1):

| Condition | Result |
|---|---|
| `PI_EXPERTISE_API_BASE_URL` is not a valid URL | refuse |
| base URL host is not loopback (`localhost` / `127.0.0.0/8` / `::1`) | refuse |
| `PI_EXPERTISE_API_KEY` missing/empty | refuse |
| `/health/ready` returns non-200 or is unreachable | refuse |
| search request errors or returns non-2xx | refuse |
| `expertise_create` called with `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE` != `1` | refuse (before any network call) |
| `expertise_create` body field (`title`/`content`/`tags[]`/`source`) matches a credential pattern | refuse (category named, secret never echoed) |
| create request errors or returns non-2xx | refuse |

## Trust boundary

- Loopback is a network locality boundary, **not** an authentication boundary —
  hence the mandatory API key even for local calls.
- Returned content is **untrusted tool-call output**. It is surfaced only as the
  structured return value of `expertise_search`, framed as advisory, and is
  **never** injected as system context (see
  [`agent/rules/no-mcp-servers.md`](../../rules/no-mcp-servers.md)).
- Response bodies are bounded to 256 KB.
- The API key is never written to tool `content`, `details`, logs, errors, or
  refusal messages.
- **Create body-secret guard.** `secrets-guard` (the global extension) only sees
  `write`/`edit`/`artifact_review`/`bash` and is scoped to disk/commit
  persistence, so it never inspects `expertise_create`. Instead an
  extension-local lightweight guard (`lib/secret-scan.ts`) scans the create body
  before any network call and refuses if a field carries a credential pattern
  (PEM private-key block / AWS access key ID / GitHub PAT — the exact
  `secrets-guard` pattern set). It returns **category names only**, never the
  matched secret, so the refusal message cannot leak the value.

## Assumptions

Pending the frozen upstream contract (tracked under #149):

- Search route: `GET /expertise/search?query=...&limit=...` (centralized in
  `lib/search.ts`).
- Create route: `POST /expertise` with a JSON body
  (`title`, `content`, optional `tags[]`, optional `source`), a fresh
  `Idempotency-Key` header per request, and `content-type: application/json`
  (centralized in `lib/create.ts`). The per-call key satisfies ADR-0028's
  "generated per create request"; it does **not** de-duplicate retries across
  calls.
- Readiness route: `GET /health/ready` (200 ⇒ ready).
- Credential header: `x-api-key`.

These are single-edit constants and will be reconciled against a running API
instance before the client is declared production-usable.

## Tests

```bash
./scripts/test-expertise-client.sh
```

Tests are hermetic — they stub `fetch` and never touch the network.
