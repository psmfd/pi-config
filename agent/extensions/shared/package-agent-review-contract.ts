/**
 * package-agent-review-contract.ts — shared contract for the package-agent
 * review-draft record (#916, ADR-0128).
 *
 * A review draft is PERMANENTLY NON-AUTHORIZING evidence of an operator's
 * direct-TUI review of a package-agent proposal. It cannot be consumed,
 * promoted, migrated, or upgraded into an active grant; #917 must reject
 * every record of this kind unconditionally as authorization evidence and
 * create active grants under its own distinct schema and digest domain
 * after complete provenance reconstruction and a fresh direct-TUI approval.
 *
 * Everything here is data shape + bounds. No IO, no side effects.
 */

// Type-only, and therefore erased at build time: the grant contract imports
// this module for its identity/evidence shapes, and this module needs only
// the receipt TYPE for the shared state image. No runtime cycle exists.
import type { GrantReceipt } from "./package-agent-grant-contract.ts";

/** Discriminator for every record this contract produces. */
export const REVIEW_DRAFT_KIND = "package-agent-review-draft";

/** Version of the review-draft schema (strict: unknown versions are refused). */
export const REVIEW_DRAFT_SCHEMA_VERSION = 1;

/**
 * Domain-separation string for the proposal digest. Deliberately distinct
 * from any active-grant domain #917 may define; a digest computed under this
 * domain can never equal one computed under another domain (the domain is
 * length-delimited into the canonical encoding).
 */
export const REVIEW_DRAFT_DIGEST_DOMAIN =
  "pi-config/package-agent-review-draft/v1";

/** Proposed draft lifetime: review evidence only, never authorization. */
export const DRAFT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Nonce length in bytes (crypto.randomBytes). Review evidence only. */
export const DRAFT_NONCE_BYTES = 32;

// ---------------------------------------------------------------------------
// Bounds (explicit count/depth/file/total-byte bounds per the #916 plan).
// ---------------------------------------------------------------------------

export const BOUNDS = {
  /** Maximum configured packages considered by discovery. */
  maxPackages: 64,
  /** Maximum agent descriptor files read per package. */
  maxAgentFilesPerPackage: 16,
  /** Maximum size of one descriptor JSON file. */
  maxDescriptorBytes: 64 * 1024,
  /** Maximum size of one wrapper / prompt markdown file. */
  maxWrapperBytes: 256 * 1024,
  /** Maximum total bytes read across one discovery pass. */
  maxTotalDiscoveryBytes: 4 * 1024 * 1024,
  /** Maximum JSON nesting depth in a descriptor. */
  maxJsonDepth: 8,
  /** Maximum entries in a JSON object or array in a descriptor. */
  maxJsonEntries: 256,
  /** Maximum length of one JSON string value in UTF-16 code units. */
  maxJsonStringLength: 256 * 1024,
  /** Maximum requested tool names in a descriptor. */
  maxTools: 32,
  /** Maximum environment-policy entries in a descriptor. */
  maxEnvironmentEntries: 32,
  /** Maximum size of the persisted state image. */
  maxStateBytes: 8 * 1024 * 1024,
  /** Maximum retained audit events (oldest are dropped, counted). */
  maxAuditEvents: 1000,
  /** Maximum drafts retained in state. */
  maxDrafts: 128,
} as const;

// ---------------------------------------------------------------------------
// Identity shapes (strict ASCII; confusable-hostile).
// ---------------------------------------------------------------------------

/** Agent name inside a package: lowercase kebab, 2..64 chars. */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Operator-selected local alias: lowercase kebab, 2..32 chars. */
export const ALIAS_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Tool name requested by a descriptor. */
export const TOOL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Environment-policy key. */
export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Qualified agent identity: `git:<host>/<path>@<ref>#<name>`.
 * Host, path, ref, and name are each validated separately before assembly;
 * the assembled form must satisfy this shape and be pure printable ASCII.
 */
export const QUALIFIED_ID_RE =
  /^git:[a-z0-9.-]{1,128}\/[A-Za-z0-9._/-]{1,256}@[A-Za-z0-9._/-]{1,128}#[a-z0-9][a-z0-9-]{1,63}$/;

/** Printable ASCII (no control chars) — the only bytes identities may hold. */
export function isPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Unresolved provenance — the fields a review draft can NEVER resolve.
// Their presence is what keeps the record non-authorizing (ADR-0128).
// ---------------------------------------------------------------------------

export const UNRESOLVED_PROVENANCE_FIELDS = [
  "effective-tool-implementations",
  "runner-identity-and-content",
  "argv-policy",
  "event-handler-set",
  "extension-closure",
  "transitive-module-closure",
] as const;

export type UnresolvedProvenanceField =
  (typeof UNRESOLVED_PROVENANCE_FIELDS)[number];

// ---------------------------------------------------------------------------
// Record shapes.
// ---------------------------------------------------------------------------

/** One source file's immutable evidence (bytes were hashed as read). */
export interface SourceFileEvidence {
  /** Path relative to the package install root (validated, no `..`). */
  relPath: string;
  /** Byte length as read. */
  byteLength: number;
  /** sha256 hex of the exact bytes read. */
  sha256: string;
}

/** Immutable source identity of the installed package, as observed. */
export interface PackageSourceIdentity {
  /** The configured source string, e.g. `git:github.com/psmfd/pi-x@v1.2.3`. */
  source: string;
  host: string;
  path: string;
  /** The configured pin (tag or commit). */
  ref: string;
  /**
   * Commit sha observed in the install tree's git metadata at read time, or
   * null when unreadable. Evidence only: the tree contents are NOT verified
   * against this sha by the broker (that reconstruction is #917's work).
   */
  observedCommit: string | null;
}

/**
 * The immutable review snapshot displayed to the operator and bound by the
 * proposal digest. Derived from package bytes and trusted broker policy,
 * never from unverified package provenance claims.
 */
export interface ReviewSnapshot {
  schemaVersion: typeof REVIEW_DRAFT_SCHEMA_VERSION;
  digestDomain: typeof REVIEW_DRAFT_DIGEST_DOMAIN;
  qualifiedId: string;
  packageIdentity: PackageSourceIdentity;
  agentName: string;
  /** Operator-proposed local alias, or null. */
  proposedAlias: string | null;
  /** Exact descriptor JSON bytes (UTF-8 decoded string, verbatim). */
  descriptorText: string;
  descriptorEvidence: SourceFileEvidence;
  /** Exact wrapper/prompt markdown bytes, or null when absent. */
  wrapperText: string | null;
  wrapperEvidence: SourceFileEvidence | null;
  /** Complete prompt bytes from the descriptor (`prompt` field, verbatim). */
  promptText: string;
  /** Requested finite tool names (validated, deduplicated, sorted). */
  requestedTools: string[];
  /** Environment policy from the descriptor (sorted keys), or empty. */
  environmentPolicy: Record<string, string>;
  /** Model policy string from the descriptor, or null. */
  modelPolicy: string | null;
  /** Guard-profile string from the descriptor, or null. */
  guardPolicy: string | null;
  /** Context policy string from the descriptor, or null. */
  contextPolicy: string | null;
  /** The provenance this record explicitly does NOT resolve. */
  unresolvedProvenance: readonly UnresolvedProvenanceField[];
}

/** The persisted, permanently inert review draft. */
export interface ReviewDraft {
  kind: typeof REVIEW_DRAFT_KIND;
  schemaVersion: typeof REVIEW_DRAFT_SCHEMA_VERSION;
  /** Hard-wired false: this record can never activate anything. */
  activatable: false;
  /** Hard-wired true: #917 requires a fresh direct-TUI approval. */
  requiresFreshApproval: true;
  /** Hard-wired null: no authorization digest exists for a draft. */
  authorizationDigest: null;
  qualifiedId: string;
  /** Monotonic per-proposal revision (changes when the draft changes). */
  draftRevision: number;
  /** sha256 hex over the canonical snapshot encoding (evidence, not grant). */
  proposalDigest: string;
  /** The reviewed snapshot, verbatim. */
  snapshot: ReviewSnapshot;
  /** 32-byte hex nonce — review evidence only, never authorization. */
  nonce: string;
  /** Issue time, ms since epoch UTC. */
  issuedAtMs: number;
  /** Proposed expiry, ms since epoch UTC (issuedAt + 30 days). */
  expiresAtMs: number;
}

// ---------------------------------------------------------------------------
// Audit (closed schema — positive allowlist only).
// ---------------------------------------------------------------------------

export const AUDIT_EVENT_KINDS = [
  "draft-recorded",
  "draft-rejected",
  "draft-revoked",
  "review-aborted",
  "discovery-refused",
  "state-refused",
  // #928 (ADR-0129): active-grant approval. The audit record is evidence,
  // never authority — the grant itself is in-memory only.
  "grant-approved",
  "grant-approval-aborted",
  // #929 (ADR-0129): grant lifecycle decision points. Each is evidence of an
  // authority transition that already happened in memory — recording one
  // grants or revokes nothing.
  "grant-revoked",
  "grant-expired",
  "grant-shutdown-invalidated",
  // #930 (ADR-0131): dispatch ingress outcomes. Added together with their
  // emitters, per the #929 hand-off (a closed schema does not carry codes
  // nothing can emit). Evidence only — recording one dispatches nothing.
  //   dispatch-admission-refused — admission refused a request outright
  //     (queue-full / identity-queue-full / queue-expired legs).
  //   dispatch-request-cancelled — a QUEUED request was cancelled by
  //     revocation or runtime close before promotion.
  //   dispatch-refused          — an admitted request failed a dispatch gate
  //     (grant missing/expired, unverified clock, digest mismatch, canary
  //     anomaly, attestation mismatch, spawn timeout/failure).
  //   dispatch-spawned          — revalidation passed and process creation
  //     succeeded under the authority lock.
  //   dispatch-completed        — a spawned child reached a terminal outcome
  //     (exit, execution-timeout termination, or output-cap termination).
  "dispatch-admission-refused",
  "dispatch-request-cancelled",
  "dispatch-refused",
  "dispatch-spawned",
  "dispatch-completed",
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

/**
 * Closed reason vocabulary for persisted audit events.
 *
 * Note on per-file discovery skips: `descriptor-invalid` and
 * `unsafe-file-refused` are deliberately NOT in this list. Those are
 * continue-eligible per-file outcomes surfaced in the UI skip list only —
 * auditing every malformed file in an installed package would let package
 * content drive unbounded audit growth. Only systemic refusals (which abort
 * a whole pass) and decision points are audited.
 */
export const AUDIT_REASON_CODES = [
  "ok",
  "operator-declined",
  "source-changed-during-review",
  "generation-conflict",
  "identity-retype-mismatch",
  "digest-retype-mismatch",
  "not-interactive-tui",
  "malformed-input",
  "collision-refused",
  "bounds-exceeded", // configured package count exceeded
  "total-budget-exceeded", // global discovery byte budget exhausted (whole pass)
  "state-integrity-refused",
  "lock-unavailable",
  "draft-missing",
  "draft-expired",
  "proposal-missing",
  // #928 (ADR-0129) grant-approval refusals. Each names a reconstruction or
  // policy gate that a review draft could never have satisfied.
  "revision-unresolvable",
  "runner-unresolvable",
  "tool-policy-refused",
  "argv-policy-inconsistent",
  "grant-cap-reached",
  // #929 grant-lifecycle causes. Operator revocation reuses the existing
  // `operator-declined` code (the draft-revoked precedent); these two name
  // the causes that have no operator in the loop.
  "grant-expired",
  "runtime-shutdown",
  // #930 (ADR-0131) dispatch-outcome causes. Reused codes are deliberate:
  // `grant-expired` (expiry observed at revalidation), `operator-declined`
  // (revocation cancelled a queued request), `runtime-shutdown` (close
  // cancelled a queued request), `bounds-exceeded` (asset-tree walk bounds
  // at reconstruction), `malformed-input` (dispatch request shape).
  "asset-tree-refused", // full-tree digest walk refused (unwalkable/over-bound tree)
  "grant-missing", // no grant exists for the named identity in this runtime
  "clock-unverified", // clockSuspendInclusive=false — lifetime unenforceable
  "credential-unavailable", // the short-lived bearer could not be minted
  "digest-mismatch", // reconstructed definition != approved grant digest
  "canary-anomaly", // confinement probe failed or mechanism unavailable
  "attestation-mismatch", // argv/env/closure attestation failed closed
  "queue-full", // admission: global queue bound
  "identity-queue-full", // admission: per-identity queue bound
  "queue-expired", // admission: queued request aged out
  "spawn-timeout", // authority-lock hold bound exceeded; best-effort terminate
  "spawn-failed", // process creation failed
  "child-exit", // terminal: child exited on its own (code recorded separately)
  "execution-timeout", // terminal: dispatch execution bound; terminated
  "output-cap-exceeded", // terminal: stdout caps; terminated
] as const;

export type AuditReasonCode = (typeof AUDIT_REASON_CODES)[number];

/**
 * A closed-schema audit event. Never carries raw paths, package bytes,
 * prompts, descriptor bodies, environment values, command output, exception
 * strings, or confirmation/retype input.
 */
export interface AuditEvent {
  kind: AuditEventKind;
  /** UTC ms timestamp. */
  atMs: number;
  /** Qualified identity, or null when the event precedes identification. */
  qualifiedId: string | null;
  /** Safe source identifier (the configured source string), or null. */
  source: string | null;
  /** Observed commit sha, or null. */
  observedCommit: string | null;
  /** Proposal digest (review-draft domain), or null. */
  proposalDigest: string | null;
  /**
   * Grant digest (active-grant domain), or null. Optional because it was
   * added by #928: audit events persisted before it simply lack the key.
   * Kept distinct from `proposalDigest` so the two digest domains are never
   * conflated in one audit column.
   */
  grantDigest?: string | null;
  /** Per-identity approval sequence for a grant event, or null (#928). */
  approvalSequence?: number | null;
  /** Draft revision, or null. */
  draftRevision: number | null;
  /** State generation after the event, or null for refused operations. */
  stateGeneration: number | null;
  /** Draft expiry ms, or null. */
  expiresAtMs: number | null;
  /** Outcome: fixed enum, never free text. */
  outcome: "committed" | "refused" | "noop";
  reason: AuditReasonCode;
}

// ---------------------------------------------------------------------------
// State image.
// ---------------------------------------------------------------------------

export const STATE_SCHEMA_VERSION = 1;

/** The single authoritative state image persisted by the broker. */
export interface BrokerState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  /** Monotonic state generation, advanced by every committed mutation. */
  generation: number;
  /** Per-qualified-id monotonic draft revision counters. */
  draftRevisions: Record<string, number>;
  /** Drafts keyed by qualified id. */
  drafts: Record<string, ReviewDraft>;
  /**
   * #928 approval receipts keyed by qualified id — NON-AUTHORIZING. The
   * dispatch path never reads this map; forging an entry grants nothing,
   * because authority is the in-memory grant and nothing else (ADR-0129).
   * Absent in state images written before #928; `StateStore` normalizes it.
   */
  grantReceipts: Record<string, GrantReceipt>;
  /** Closed-schema audit events, oldest first, capped (drops counted). */
  audit: AuditEvent[];
  /** Count of audit events dropped by the retention cap. */
  auditDropped: number;
}

export function initialBrokerState(): BrokerState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    generation: 0,
    draftRevisions: {},
    drafts: {},
    grantReceipts: {},
    audit: [],
    auditDropped: 0,
  };
}
