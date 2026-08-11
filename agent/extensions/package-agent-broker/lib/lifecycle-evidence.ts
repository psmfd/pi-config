/**
 * lifecycle-evidence.ts — persisted evidence of grant lifecycle transitions
 * (#929, ADR-0129).
 *
 * Everything here runs AFTER the authority-lock work that actually changed
 * authority: revocation and expiry drop the in-memory grant first, then this
 * module records what happened. Per the ADR-0129 ordering rule, no caller
 * may invoke these functions while holding an authority lock.
 *
 * Two artifacts are written, both non-authorizing:
 *
 *   - a closed-schema audit event per transition (`grant-revoked`,
 *     `grant-expired`, `grant-shutdown-invalidated`);
 *   - a `terminal` stamp on the matching persisted receipt, so an operator
 *     inspecting state after the runtime exits can see the grant did not
 *     merely lapse with the process. Shutdown is deliberately not stamped —
 *     every grant dies with its runtime by construction.
 *
 * Receipt stamping is guarded by approval identity: the stamp lands only on
 * a receipt whose runtimeInstanceId AND approvalSequence match the observed
 * grant, so evidence from one approval can never mislabel a later one.
 */

import type {
  ActiveGrant,
  GrantTerminalState,
} from "../../shared/package-agent-grant-contract.ts";
import { makeAuditEvent } from "./audit.ts";
import type { StateStore } from "./state-store.ts";
import { pushAudit } from "./state-store.ts";

export interface LifecycleObservation {
  grant: ActiveGrant;
  state: GrantTerminalState;
  /** Wall-clock observation time (human-readable evidence only). */
  atMs: number;
}

/**
 * Persist audit events and receipt terminal stamps for a batch of lifecycle
 * observations in one state image. Throws StateError on store failure — the
 * caller decides how loudly to surface it (the in-memory transition already
 * happened either way).
 */
export async function recordLifecycleEvidence(
  store: StateStore,
  observations: readonly LifecycleObservation[],
): Promise<void> {
  if (observations.length === 0) return;
  // Validate every event BEFORE taking the store lock: an out-of-schema
  // value must fail the whole batch, not persist a partial image.
  const prepared = observations.map((o) => ({
    observation: o,
    event: makeAuditEvent(
      o.state === "revoked" ? "grant-revoked" : "grant-expired",
      o.atMs,
      {
        qualifiedId: o.grant.qualifiedId,
        source: o.grant.definition.packageIdentity.source,
        grantDigest: o.grant.digest,
        approvalSequence: o.grant.approval.sequence,
        expiresAtMs: o.grant.expiresAtMs,
        outcome: "committed",
        reason: o.state === "revoked" ? "operator-declined" : "grant-expired",
      },
    ),
  }));
  await store.appendEvidence((current) => {
    for (const { observation, event } of prepared) {
      pushAudit(current, event);
      const receipt = current.grantReceipts[observation.grant.qualifiedId];
      if (
        receipt !== undefined &&
        receipt.runtimeInstanceId === observation.grant.approval.runtimeInstanceId &&
        receipt.approvalSequence === observation.grant.approval.sequence
      ) {
        receipt.terminal = { state: observation.state, atMs: observation.atMs };
      }
    }
  });
}

/**
 * Best-effort shutdown audit (#929): one `grant-shutdown-invalidated` event
 * per grant that was live when the runtime closed. Failure is swallowed —
 * at shutdown there is no UI left to warn, the process may die before the
 * write lands, and the transition this records is already implied by the
 * runtime ending (which is why receipts carry no shutdown stamp).
 */
export async function recordShutdownEvidence(
  store: StateStore,
  cleared: readonly ActiveGrant[],
  atMs: number,
): Promise<void> {
  if (cleared.length === 0) return;
  try {
    const events = cleared.map((grant) =>
      makeAuditEvent("grant-shutdown-invalidated", atMs, {
        qualifiedId: grant.qualifiedId,
        source: grant.definition.packageIdentity.source,
        grantDigest: grant.digest,
        approvalSequence: grant.approval.sequence,
        expiresAtMs: grant.expiresAtMs,
        outcome: "committed",
        reason: "runtime-shutdown",
      }),
    );
    await store.appendEvidence((current) => {
      for (const event of events) pushAudit(current, event);
    });
  } catch {
    // Best effort by design; see the function comment.
  }
}
