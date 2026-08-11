/**
 * package-agent-grant-contract.ts — shared contract for the package-agent
 * ACTIVE GRANT (#928, ADR-0129; digest contents from ADR-0127 §5).
 *
 * An active grant is RUNTIME-SCOPED AUTHORITY: an in-memory object held for
 * the lifetime of one pi runtime, created only by a fresh direct interactive
 * TUI approval over a completely reconstructed effective definition. It is
 * never serialized into any form the dispatch path reads back as
 * authorization (ADR-0129, "The authority object").
 *
 * Relationship to #916's review drafts:
 *   - a `package-agent-review-draft` is PERMANENTLY NON-AUTHORIZING and is
 *     rejected unconditionally as authorization evidence — it can never
 *     shorten, pre-fill, or satisfy any part of an approval;
 *   - grants live under their own schema and their own digest domain, so a
 *     digest computed for a draft can never equal one computed for a grant
 *     (the domain is length-delimited into the canonical encoding).
 *
 * Everything here is data shape + bounds. No IO, no side effects.
 */

import type {
  PackageSourceIdentity,
  SourceFileEvidence,
} from "./package-agent-review-contract.ts";

/** Discriminator for the in-memory authority object. */
export const ACTIVE_GRANT_KIND = "package-agent-active-grant";

/** Discriminator for the persisted, NON-AUTHORIZING approval receipt. */
export const GRANT_RECEIPT_KIND = "package-agent-grant-receipt";

/** Version of the grant schema (strict: unknown versions are refused). */
export const GRANT_SCHEMA_VERSION = 1;

/**
 * Version of the broker POLICY that produced the effective definition — the
 * argv template, the isolation flag set, and the built-in tool allowlist.
 * ADR-0127 §5 requires schema AND policy versions in the digest: changing
 * broker policy must invalidate existing grants even when package bytes are
 * byte-identical.
 *
 * v2 (#934, ADR-0130): file built-ins are dispatchable only under verified
 * OS-level filesystem confinement. The bump invalidates every grant approved
 * under v1's unconfined-tool semantics by digest — the intended effect.
 *
 * v3 (#930, ADR-0131 Decision 1): the asset-tree digest widens from
 * descriptor+wrapper to the full package install tree (minus the masked
 * top-level `.git`), because ADR-0130's sandbox lets the child read the
 * whole tree. Grants whose digest covers less than the child can read are
 * invalidated by digest — the intended effect.
 */
export const GRANT_POLICY_VERSION = 3;

/**
 * Domain-separation string for the grant digest. Deliberately distinct from
 * `REVIEW_DRAFT_DIGEST_DOMAIN`; the two can never collide.
 */
export const GRANT_DIGEST_DOMAIN = "pi-config/package-agent-active-grant/v1";

/**
 * Absolute grant lifetime measured from approval (ADR-0129, "Nonce and
 * expiry"; operator-set to 4 hours on 2026-07-28). The value is a design
 * parameter; the enforcement is not optional. #929 owns enforcement and the
 * suspend-inclusive clock this bound must be measured against.
 */
export const GRANT_LIFETIME_MS = 4 * 60 * 60 * 1000;

/** Nonce length in bytes: one-shot randomness binding one approval instance. */
export const GRANT_NONCE_BYTES = 32;

/**
 * Runtime instance identifier length in bytes. High-entropy random, generated
 * once at runtime start. Deriving it from the PID is prohibited — PIDs are
 * reused (ADR-0129, "Reconciling ADR-0127 §5 and §6").
 */
export const RUNTIME_INSTANCE_ID_BYTES = 32;

export const GRANT_BOUNDS = {
  /**
   * Simultaneous active grants per runtime (ADR-0129 Consequences;
   * operator-affirmed at 32). Each requires its own operator approval, so
   * this is a backstop rather than a practical limit. Refuse at the cap:
   * evicting the oldest would silently destroy authority an operator granted
   * in person.
   */
  maxActiveGrants: 32,
  /** Maximum runner executable size that will be digested. */
  maxRunnerBytes: 512 * 1024 * 1024,
  /** Maximum effective tools bound into one grant. */
  maxEffectiveTools: 32,
  /** Maximum argv template entries. */
  maxArgvEntries: 64,
  /** Maximum retained approval receipts (non-authorizing). */
  maxGrantReceipts: 128,
  /**
   * Bounds on the full-tree asset digest walk (#930, ADR-0131 Decision 1).
   * A package exceeding either refuses reconstruction — an unbounded walk
   * would let package content drive unbounded approval-time work.
   */
  maxAssetFiles: 4096,
  maxAssetTreeBytes: 256 * 1024 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Closure shapes.
//
// "Empty" is always a POSITIVE ASSERTION (`mode: "none"`), never an absent or
// null field. #916 records six provenance fields it cannot resolve; a grant
// must resolve all six, and an unresolved field must be indistinguishable
// from a refusal — never from an empty one.
// ---------------------------------------------------------------------------

/**
 * `none`     — the closure is empty BY CONSTRUCTION (the child disables
 *              discovery and is given no explicit entries).
 * `explicit` — the closure is exactly the listed, content-addressed entries.
 */
export type ClosureMode = "none" | "explicit";

/** One content-addressed closure member. */
export interface ClosureEntry {
  /** Path relative to the broker-owned snapshot root (validated, no `..`). */
  relPath: string;
  byteLength: number;
  sha256: string;
}

/** An ordered, content-addressed closure. Order is part of the digest. */
export interface Closure {
  mode: ClosureMode;
  entries: readonly ClosureEntry[];
}

/** The child's event-handler set (extension-registered handlers). */
export interface EventHandlerSet {
  mode: ClosureMode;
  handlers: readonly string[];
}

/** Child runner identity and content (ADR-0127 §5). */
export interface RunnerIdentity {
  /** Absolute, symlink-resolved path of the executable that will be spawned. */
  path: string;
  byteLength: number;
  /** sha256 over the exact executable bytes. */
  sha256: string;
}

/**
 * The argv policy the broker will enact. `template` is the ordered argv the
 * child is spawned with, and `isolation` restates — as data bound into the
 * digest — the isolation guarantees that template must carry. Listing them
 * separately is deliberate: a future edit that drops `--no-extensions` from
 * the template without dropping it from `isolation` is caught by the
 * consistency check in `reconstruct.ts` rather than shipping silently.
 */
export interface ArgvPolicy {
  template: readonly string[];
  isolation: readonly string[];
}

/**
 * One effective tool. In this version every effective tool is a pi built-in,
 * so its implementation is the runner's own bytes and its implementation
 * digest is the runner digest (ADR-0127 §6: "Built-in tools are bound to the
 * approved runner digest"). Extension-provided tools are refused, because an
 * isolated child loads no extensions and therefore cannot have them.
 */
export interface EffectiveTool {
  name: string;
  provenance: "builtin";
  implementationDigest: string;
}

/**
 * Runtime-scoped approval identifier — ADR-0129's replacement for ADR-0127
 * §5's durable "grant revision". It occupies the same digest position and
 * distinguishes two approvals of otherwise-identical content, without
 * implying durability. Retained ALONGSIDE the nonce, not instead of it: the
 * sequence makes re-approval and audit ordering well-defined, the nonce makes
 * two byte-identical approvals distinguishable. Dropping either is a mistake.
 */
export interface ApprovalIdentifier {
  /** Hex of RUNTIME_INSTANCE_ID_BYTES random bytes, fixed per runtime. */
  runtimeInstanceId: string;
  /** Monotonic per-qualified-identity approval sequence, starting at 1. */
  sequence: number;
}

/**
 * Approval-instance material that is generated once, at approval, and then
 * carried by the in-memory grant. Dispatch-time reconstruction re-derives
 * every OTHER field from current state but takes these from the grant it is
 * validating against — they are properties of the approval event, not of the
 * package on disk.
 */
export interface ApprovalBinding {
  approval: ApprovalIdentifier;
  /** Hex of GRANT_NONCE_BYTES random bytes. */
  nonce: string;
  /** Wall-clock expiry, ms since epoch UTC — receipts and display only. */
  expiresAtMs: number;
  /**
   * Authoritative expiry reading on the suspend-inclusive monotonic source
   * (ADR-0129). Wall-clock is rejected because moving the system clock
   * backward would extend a grant.
   */
  expiresAtMonotonicMs: number;
  /**
   * Whether the monotonic source backing `expiresAtMonotonicMs` has been
   * VERIFIED suspend-inclusive on this platform. #928 records it; #929 owns
   * the verification. Dispatch (#930) MUST refuse a grant whose value is
   * false — an unverified clock cannot enforce the lifetime bound, and
   * suspending the host is reachable through the bash tool.
   */
  clockSuspendInclusive: boolean;
}

/**
 * The completely reconstructed effective definition of a package agent.
 *
 * Every ADR-0127 §5 field is present and non-null. There is no "unresolved"
 * escape hatch: reconstruction either resolves a field or refuses outright.
 * That is the whole difference between this record and a #916 review draft.
 */
export interface EffectiveDefinition {
  schemaVersion: typeof GRANT_SCHEMA_VERSION;
  policyVersion: typeof GRANT_POLICY_VERSION;
  digestDomain: typeof GRANT_DIGEST_DOMAIN;

  /** Qualified agent identity and operator-selected local alias. */
  qualifiedId: string;
  agentName: string;
  alias: string | null;

  /** Qualified package identity and source. */
  packageIdentity: PackageSourceIdentity;
  /**
   * Resolved immutable revision. REQUIRED — a grant may not be created for a
   * package whose commit could not be read, where #916 tolerated null because
   * a draft authorizes nothing.
   */
  resolvedCommit: string;
  /**
   * Ordered content-addressed digest over every package byte that can reach
   * the child: the full install tree minus the sandbox-masked top-level
   * `.git` (#930, ADR-0131 Decisions 1–2). The walk and the sandbox mask
   * must stay byte-for-byte aligned — see `reconstruct.ts`.
   */
  assetTreeDigest: string;

  /** Descriptor and wrapper bytes. */
  descriptorText: string;
  descriptorEvidence: SourceFileEvidence;
  wrapperText: string | null;
  wrapperEvidence: SourceFileEvidence | null;

  /** Complete system prompt. */
  promptText: string;

  /** Finite tool allowlist plus each effective tool's implementation digest. */
  effectiveTools: readonly EffectiveTool[];

  /** Child runner, argv policy, and the ordered content-addressed closures. */
  runner: RunnerIdentity;
  argvPolicy: ArgvPolicy;
  extensionClosure: Closure;
  moduleClosure: Closure;
  eventHandlerSet: EventHandlerSet;

  /** Environment, model/capability, guard, and context-file policies. */
  environmentPolicy: Record<string, string>;
  modelPolicy: string | null;
  guardPolicy: string | null;
  contextPolicy: string | null;

  /** Approval identifier, nonce, and expiry. */
  approval: ApprovalIdentifier;
  nonce: string;
  expiresAtMs: number;
  expiresAtMonotonicMs: number;
  clockSuspendInclusive: boolean;
}

/**
 * The in-memory authority object. Never persisted, never serialized into
 * anything the dispatch path reads back as authorization.
 */
export interface ActiveGrant {
  kind: typeof ACTIVE_GRANT_KIND;
  schemaVersion: typeof GRANT_SCHEMA_VERSION;
  qualifiedId: string;
  approval: ApprovalIdentifier;
  /** sha256 hex over the canonical encoding of `definition`. */
  digest: string;
  definition: EffectiveDefinition;
  approvedAtMs: number;
  approvedAtMonotonicMs: number;
  expiresAtMs: number;
  expiresAtMonotonicMs: number;
}

/**
 * The ADR-0127 §5 field enumeration, as digest-coverage slugs.
 *
 * This list is the machine-checkable form of "the grant digest covers every
 * §5 field". `test/grant-digest.test.ts` holds one mutator per slug and
 * asserts (a) that its mutator set is exactly this list, and (b) that every
 * mutator changes the digest. Adding a §5 field without a mutator fails the
 * suite rather than silently shipping an uncovered field.
 */
export const GRANT_DIGEST_FIELDS = [
  "schema-and-policy-versions",
  "qualified-package-identity-and-source",
  "resolved-revision-and-tree-digest",
  "descriptor-and-wrapper-bytes",
  "complete-system-prompt",
  "finite-tool-allowlist-and-implementations",
  "runner-identity-and-content",
  "argv-policy",
  "extension-and-module-closure",
  "event-handler-set",
  "environment-model-guard-and-context-policies",
  "qualified-agent-identity-and-alias",
  "approval-identifier",
  "nonce",
  "expiry",
] as const;

export type GrantDigestField = (typeof GRANT_DIGEST_FIELDS)[number];

/**
 * A persisted approval receipt. NON-AUTHORIZING: the dispatch path never
 * reads it, and forging one grants nothing. It exists so an operator can see
 * what they approved in a runtime that has since exited.
 */
export interface GrantReceipt {
  kind: typeof GRANT_RECEIPT_KIND;
  schemaVersion: typeof GRANT_SCHEMA_VERSION;
  /** Hard-wired false: a receipt is never an authorization input. */
  authorizing: false;
  qualifiedId: string;
  runtimeInstanceId: string;
  approvalSequence: number;
  /**
   * The grant digest as observed at approval. Recorded for the operator's
   * benefit; it is NEVER compared against at dispatch, because the dispatch
   * trust set contains no file (ADR-0129, "The dispatch trust set").
   */
  observedGrantDigest: string;
  approvedAtMs: number;
  expiresAtMs: number;
  /**
   * Terminal lifecycle observation for this approval (#929), or absent/null
   * while none was observed in the granting runtime. Evidence only — the
   * dispatch path never reads receipts, and a receipt with no terminal entry
   * proves nothing about liveness (the grant may have died with its runtime).
   * Runtime shutdown is deliberately not stamped here: every grant dies with
   * its runtime by construction, and the shutdown write window is too
   * unreliable to promise. Absent in receipts written before #929.
   */
  terminal?: { state: GrantTerminalState; atMs: number } | null;
}

/** Terminal lifecycle states observable within the granting runtime (#929). */
export type GrantTerminalState = "revoked" | "expired";
