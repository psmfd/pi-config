/**
 * audit.ts — closed-schema audit event construction (#916).
 *
 * Positive allowlist only. Constructors take exactly the safe fields the
 * schema names; free-text, raw paths, package bytes, prompts, descriptor
 * bodies, environment values, command output, exception strings, and
 * confirmation/retype input have no parameter to arrive through. Secret
 * scanning elsewhere is defense in depth; this shape is the control.
 */

import {
  AUDIT_EVENT_KINDS,
  AUDIT_REASON_CODES,
  QUALIFIED_ID_RE,
  type AuditEvent,
  type AuditEventKind,
  type AuditReasonCode,
} from "../../shared/package-agent-review-contract.ts";

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditError";
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SOURCE_RE = /^git:[\x20-\x7e]{1,508}$/;

export interface AuditFields {
  qualifiedId?: string | null;
  source?: string | null;
  observedCommit?: string | null;
  proposalDigest?: string | null;
  grantDigest?: string | null;
  approvalSequence?: number | null;
  draftRevision?: number | null;
  stateGeneration?: number | null;
  expiresAtMs?: number | null;
  outcome: "committed" | "refused" | "noop";
  reason: AuditReasonCode;
}

function checkOrNull<T>(
  value: T | null | undefined,
  name: string,
  ok: (v: T) => boolean,
): T | null {
  if (value === null || value === undefined) return null;
  if (!ok(value)) throw new AuditError(`audit field ${name} failed validation`);
  return value;
}

/** Build a validated, frozen audit event. Throws on any out-of-schema value. */
export function makeAuditEvent(
  kind: AuditEventKind,
  atMs: number,
  fields: AuditFields,
): AuditEvent {
  if (!AUDIT_EVENT_KINDS.includes(kind)) throw new AuditError("unknown audit event kind");
  if (!AUDIT_REASON_CODES.includes(fields.reason)) throw new AuditError("unknown audit reason code");
  if (!Number.isSafeInteger(atMs) || atMs <= 0) throw new AuditError("audit timestamp invalid");
  if (!["committed", "refused", "noop"].includes(fields.outcome)) {
    throw new AuditError("audit outcome invalid");
  }
  const event: AuditEvent = {
    kind,
    atMs,
    qualifiedId: checkOrNull(fields.qualifiedId, "qualifiedId", (v) => QUALIFIED_ID_RE.test(v)),
    source: checkOrNull(fields.source, "source", (v) => SOURCE_RE.test(v)),
    observedCommit: checkOrNull(fields.observedCommit, "observedCommit", (v) => COMMIT_RE.test(v)),
    proposalDigest: checkOrNull(fields.proposalDigest, "proposalDigest", (v) => SHA256_HEX_RE.test(v)),
    grantDigest: checkOrNull(fields.grantDigest, "grantDigest", (v) => SHA256_HEX_RE.test(v)),
    approvalSequence: checkOrNull(fields.approvalSequence, "approvalSequence", (v) => Number.isSafeInteger(v) && v > 0),
    draftRevision: checkOrNull(fields.draftRevision, "draftRevision", (v) => Number.isSafeInteger(v) && v > 0),
    stateGeneration: checkOrNull(fields.stateGeneration, "stateGeneration", (v) => Number.isSafeInteger(v) && v >= 0),
    expiresAtMs: checkOrNull(fields.expiresAtMs, "expiresAtMs", (v) => Number.isSafeInteger(v) && v > 0),
    outcome: fields.outcome,
    reason: fields.reason,
  };
  return Object.freeze(event);
}
