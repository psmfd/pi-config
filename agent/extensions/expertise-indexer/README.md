# expertise-indexer

Pure-library extension providing the deterministic **canonicalizer** used by every stage of the expertise-consumption pipeline (pi_config epic #595).

- **Source rule (planned):** `agent/rules/expertise-consumption.md` — to be added by #603
- **Tracking:** #598 — canonicalizer + cache & manifest

This extension does not register any pi tool. It exists only to hold pure library modules imported by the orchestrator collector (#599), the candidate-gate (#608), the CI expertise-audit stage (#601), and the pre-push hook (#604).

## Public API

### `computeCanonicalBlob(inputs) → { sha, blob }`

Deterministic serializer + SHA-256 digest. **Pure — no I/O.**

Inputs (fixed order, all normalized before hashing):

| Field | Type | Notes |
|---|---|---|
| `repoOrigin` | string | git `origin` remote URL |
| `headSha` | string | 40-char (SHA-1) or 64-char (SHA-256) lowercase hex |
| `files` | `{path, blobSha}[]` | sorted lexicographically by `path` internally; duplicates rejected |
| `taskString` | string | orchestrator brief / query text |
| `agentFrontmatter` | `Record<string, FrontmatterValue>` | scalars or scalar arrays; keys sorted internally |

Normalization:

- Strings: **NFKC** (Unicode canonical equivalence) + LF-only newlines + per-line trailing-whitespace strip.
- Object keys: lexicographic sort at every level.
- Numbers: `NaN`/`Infinity` rejected.

Serialization: **manual recursive sorted-key serializer**, not `JSON.stringify(x, sortedKeys)`. Locked byte-shape asserted by a golden fixture test; any change to the shape is semver-breaking and must bump `schemaVersion` (currently `1`).

### `writeCanonicalBlob(sha, blob, opts?) → { path, uncompressedBytes, compressedBytes }`

Persists the serialized JSON, gzip-encoded, at `${PI_CODING_AGENT_DIR:-$HOME/.pi}/expertise_cache/<sha>.json.gz`.

Invariants:

| Guarantee | Mechanism |
|---|---|
| Fail closed on credential match | `scanRawString` (from `expertise-client/lib/secret-scan.ts`) runs against the raw JSON **before any file open**. On match, throws `CanonicalBlobSecretError` — no file created, no cache polluted. Error message carries category names only (never the matched substring). |
| Parent dir 0700, file 0600 | `mkdirSync(..., mode: 0o700)`; final `chmodSync(..., 0o600)`; temp file created with `O_EXCL` + mode 0600 |
| No partial writes | Temp sibling + `fsync` + atomic `rename` |
| No symlink follow at leaf | `O_EXCL` on the temp path; `realpath` check on the resolved parent dir |
| Idempotent on re-write of same sha | Same content by construction; still atomic |

### `resolveCacheDir() → string`

Returns the cache directory path. Honors `PI_CODING_AGENT_DIR` when set and non-blank; otherwise falls back to `$HOME/.pi/expertise_cache/`.

### `normalizeText(s) → string` / `isValidGitSha(s) → boolean`

Exported normalization + validation helpers, reusable by consumers that need the same normalization for other inputs.

### `acceptCandidates(rawJson) → { accepted, rejected }` (#608)

Orchestrator-side gate that ingests the `EXPERTISE_CANDIDATES` transport payload emitted by subagents (contract in #600) and produces a strictly-projected, secret-scanned batch that is safe to surface to a human for approval.

**Pure — no I/O.** Consumed by the orchestrator collector (#599), the CI expertise-audit (#601), and the pre-push hook (#604).

Ordered checks (all fail-closed):

1. `JSON.parse` (Node 18+ safe against prototype pollution at parse time).
2. Payload must be a plain object with exactly `{schemaVersion, candidates}`; `schemaVersion === 1`.
3. Prototype-poisoning walk on the parsed candidate subtree (own-property `__proto__` / `constructor` / `prototype` at any depth in objects and arrays). Does **not** recurse into strings — a body legitimately discussing `__proto__` is fine.
4. Secret scan via `scanRawString` on the raw candidate serialization (catches secrets hidden in soon-to-be-dropped unknown fields, closing the terminal-scrollback leak vector). Category names only in the hint — never the matched substring.
5. Approval-state field rejection (`approved`, `approvedBy`, `approvalTimestamp`, `approvalToken`) with the specific `approval-state-field` signal, not silent stripping.
6. Unknown-field rejection with the offending key name.
7. Field validation: required strings, optional string types, `entryType` / `severity` enums, `Info` severity requires non-blank `justification`, `canonical_blob_sha` shape (40 or 64-char lowercase hex).
8. Projection to a frozen, prototype-less (`Object.create(null)`) object with only the allowlisted fields.

Rejection reasons are stable string codes (`RejectionReason` union type) safe to assert against in CI. The `hint` field carries structured context (field name, offending key, secret categories) never a leaked secret substring.

### Collector primitives (#599)

Orchestrator-side building blocks for the canonical-fanout methodology described in [`agent/rules/expertise-canonical-fanout.md`](../../rules/expertise-canonical-fanout.md). **Pure — no I/O, no tool invocations.** Consumed today by the orchestrator model's prompt-driven flow; will additionally be consumed by the subagent runtime wiring (#611), CI expertise-audit (#601), and pre-push hook (#604).

| Export | Contract |
|---|---|
| `buildCanonicalQuery(inputs)` | Structured inputs `{domain, technology, taskType, goalOrSymptom}` → canonical query string: NFKC + lowercase + punctuation/URL/emoji strip + whitespace collapse + adjacent-token dedupe + `MAX_CANONICAL_QUERY_TOKENS` (12) clamp. Returns `""` when all inputs normalize to empty (caller skips search). Deterministic. |
| `renderCanonicalResultsBlock(results, canonicalBlobSha)` | Byte-locked fenced-block string ready to prepend to a subagent brief. Format: `<!-- BEGIN CANONICAL_EXPERTISE_RESULTS canonical_blob_sha=<sha> schemaVersion=1 -->\n{JSON}\n<!-- END CANONICAL_EXPERTISE_RESULTS -->`. Caps: per-body `MAX_INJECTED_BODY_BYTES` (4 KB, UTF-8-boundary-safe cut, suffix reserved so rendered body fits within the cap); overall `MAX_INJECTION_BLOCK_BYTES` (24 KB, tail-truncated result-by-result with `truncated: true` flag). End-marker-collision defense: any `-->` in the stringified JSON payload is substituted with `--\u003e` so a body legitimately containing the END marker does not corrupt parse. Throws on invalid `canonicalBlobSha`. |
| `parseCanonicalResultsBlock(input)` | Round-trip parser. Returns `null` when no valid block present; throws `TypeError` (uniform error contract; `SyntaxError` from `JSON.parse` is rewrapped with `cause`) on any structural failure inside the block. Used by CI audit. |
| `extractCandidatePayloads(childOutput)` | Extracts `EXPERTISE_CANDIDATES` transport payloads from a subagent's raw output blob per #600. Form B: fenced-block `rawJson` (caller feeds to `acceptCandidates`). Form A: validated `reportFile` path against the strict allowlist `^/tmp/subagent-expertise-[a-z0-9-]+-\d+\.candidates\.json$` (no `..`, no double-slash, no NUL, no non-ASCII). Duplicate Form A paths collapse at extraction. Multiple blocks per output supported; malformed blocks silently skipped (fail-open at extraction; fail-closed at ingestion). |
| `coalesceCandidates(inputs)` | Gates each `{rawJson, proposedBy}` through `acceptCandidates`, then fingerprints accepted candidates by SHA-256 of the normalized `{domain, title}` pair (NFKC + lowercase + whitespace-collapsed). Identical fingerprints merge into one `CoalescedGroup` with `proposalCount`, order-independent `variantCount` (distinct concrete-shape count computed via a `Set`), sorted-deduplicated `proposedByList`, and — when `variantCount > 1` — a frozen prototype-less `bodyHashesByProposer` map so the approval UI can enforce per-proposer body inspection (defense against body-smuggling under merged provenance). Representative selection: longest-body wins; deterministic on tie. Group order: stable by first-seen fingerprint. Rejections carry `proposedBy` forward. `proposedByList` and `bodyHashesByProposer` are both sourced from the ORCHESTRATOR-supplied `CoalesceInput.proposedBy` (never the untrusted `candidate.proposedBy` field) so attribution cannot be forged by a subagent. |

#### Fingerprint byte shape (byte-locked)

`fingerprintCandidate` serializes to `{"domain":<json-string>,"title":<json-string>}` in that fixed key order, then SHA-256 hashes the UTF-8 bytes. A test locks this against a known-input digest. Changing the shape is semver-breaking for the coalesce contract.

#### Trust boundary preserved

- `renderCanonicalResultsBlock` output is user-role `Task:` content, never `--append-system-prompt` (satisfies `no-mcp-servers.md`).
- `extractCandidatePayloads` performs no file I/O — Form A returns a validated path; the caller reads inside its own boundary with `realpath` + O_NOFOLLOW-equivalent checks.
- `coalesceCandidates` runs every candidate through the #608 universal-first-scan invariant, so no code path here can echo a secret substring into a rejection surface.

#### Consumers

The collector primitives are wired into the vendored `subagent` extension's runtime as of #611 (LOCAL PATCH #6, "Option A"). The sibling module `agent/extensions/subagent/expertise-wiring.ts`:

- prepends the orchestrator-supplied canonical block to each child's user-role `Task:` framing (via the `subagent` tool's `expertiseInjection` param) — the extension does **not** call `expertise_search` itself (autonomous search deferred to #613);
- extracts Form B `EXPERTISE_CANDIDATES` payloads from each child return via `extractCandidatePayloads`, coalesces them via `coalesceCandidates` with `proposedBy` set to the orchestrator-attributed `SingleResult.agent`, and surfaces the result on `SubagentDetails.expertiseCandidates` (structured data, never merged into the tool-result text);
- detects but does **not** open Form A (`REPORT_FILE`) payloads — a hardened `O_NOFOLLOW`+`fstat` reader is deferred (no catalog agent produces Form A today), and a one-line stderr warning fires if one is ever seen.

## Secret-scan reuse

`writeCanonicalBlob` and `acceptCandidates` both import `scanRawString` from `../shared/secret-scan.ts`. The canonical `SECRET_PATTERNS` set + `scanRawString` live in `shared/` (ADR-0088, #635) so that both this config-mirror-shipped extension and `expertise-client` (a mirror-excluded, standalone extension) can consume them without a cross-mirror import — the earlier `../expertise-client/lib/secret-scan.ts` import broke `pi` on every distributed install, since `expertise-client` never co-ships as a sibling. The move keeps the pattern set single-sourced within a lockstep target (`scripts/validate.sh` §6b-bis, ADR-0071) — it is a relocation, not a fourth copy.

## Tests

`agent/extensions/expertise-indexer/test/` — 71 node:test cases across two suites:

**`canonicalize.test.ts`** (28) covers:

- Normalization: NFKC, CRLF/CR → LF, trailing-whitespace strip, idempotency.
- Determinism: 5-run stability, file-order invariance, frontmatter-key-order invariance, CRLF vs LF, NFKC-equivalent strings.
- Byte-stable **golden fixture**: locks serialization and SHA.
- Validation: invalid `headSha`, invalid `blobSha`, duplicate paths, `NaN` frontmatter.
- Persistence: 0600/0700 mode enforcement, gzip round-trip, secret-scan refusal (AWS + PEM fixtures constructed programmatically), leaf-symlink refusal, ancestor-symlink tolerance (macOS `/var → /private/var` pattern).
- Cache dir resolution: env-override + fallback.

**`candidate-gate.test.ts`** (43) covers:

- Happy paths: single `Warning`, single `Critical`, single `Info + justification`, mixed batch, 64-char SHA, optional fields round-trip, empty batch.
- Payload rejections: invalid JSON, non-object, unknown top-level key, wrong `schemaVersion`, non-array `candidates`.
- Field rejections: missing required, wrong type, invalid enum, `Info` without / with blank `justification`, missing / malformed `canonical_blob_sha`, non-string `tags`, unknown per-candidate field, candidate not an object.
- Approval-state rejection: `approved` / `approvedBy` / `approvalTimestamp` / `approvalToken` each fail with the `approval-state-field` signal (not silent strip); batch semantics preserve independent indexing; belt-and-suspenders check that no approval key appears in accepted output.
- Prototype poisoning: `__proto__` / `constructor` / `prototype` at candidate root; `__proto__` nested inside a `tags` array element; `__proto__` in a body **string** is NOT rejected (we do not re-parse strings); `__proto__` at payload root fails closed as either `unknown-top-level-key` or `prototype-poisoning`.
- Secret detection: AWS key in body, PEM header in title, GitHub PAT in tags; secret in an unknown field still routes to `secret-detected` (raw-scan defense); multiple categories deduplicated + sorted; matched substring never appears anywhere in the rejection surface.
- Batch semantics: one rejection does not poison the batch (indexes preserved).
- Structural invariants: accepted objects are frozen, `tags` array frozen, no prototype-chain leaks in `Reflect.ownKeys`; enum tuples locked.

Run:

```sh
./scripts/test-expertise-indexer.sh
VERBOSE=1 ./scripts/test-expertise-indexer.sh    # raw node:test output
```

Invoked from `scripts/validate.sh`.

## Non-goals

- Registering a pi tool.
- Wiring into any consumer — that lives in the tracked issues above.
- Owning the `EXPERTISE_CANDIDATES` transport contract — that is #600.
