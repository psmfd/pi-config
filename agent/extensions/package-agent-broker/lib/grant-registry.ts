/**
 * grant-registry.ts — the in-memory active-grant registry and the
 * per-identity authority lock (#928, ADR-0129).
 *
 * Authority lives here and nowhere else. There is no persistence in this
 * file, deliberately: ADR-0129's guarantee is that the dispatch path trusts
 * no file, so a grant that could be written and read back would defeat the
 * decision it implements. Authority dies with the runtime — process exit and
 * `/reload` are complete revocations.
 *
 * Two locks appear in this design and must not be conflated (ADR-0129, "The
 * two locks are distinct, ordered, and bounded"):
 *
 *   - the AUTHORITY LOCK, implemented here: an in-process mutex serializing
 *     reads, creation, and revocation of the in-memory grant. It is
 *     per-qualified-identity, not runtime-global, so dispatching agent A
 *     never serializes behind agent B.
 *   - the STORE LOCK, #916's cross-process `O_EXCL` file lock, which
 *     serializes receipt and audit writes only and is NEVER an authorization
 *     input.
 *
 * ORDERING RULE: the authority lock is never held while acquiring the store
 * lock. Callers must complete their in-memory mutation, release the authority
 * lock, and only then perform receipt/audit I/O. A revocation must never wait
 * behind the store lock's retry-with-backoff.
 *
 * The waiter queue is priority-aware even though #928 only ever enqueues
 * normal waiters: #929 must be able to make revocation preempt every queued
 * and subsequently-arriving dispatch waiter (a plain FIFO mutex is
 * insufficient — sustained dispatch traffic would let queued waiters spawn
 * children after the operator revoked). Building the queue shape now means
 * that requirement is a caller change rather than a lock rewrite.
 */

import { randomBytes } from "node:crypto";

import {
  ACTIVE_GRANT_KIND,
  GRANT_BOUNDS,
  GRANT_LIFETIME_MS,
  GRANT_NONCE_BYTES,
  GRANT_SCHEMA_VERSION,
  RUNTIME_INSTANCE_ID_BYTES,
  type ActiveGrant,
  type ApprovalBinding,
  type EffectiveDefinition,
} from "../../shared/package-agent-grant-contract.ts";
import { packageIdentityConflict } from "./collisions.ts";

export class GrantError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "grant-cap-reached"
      | "identity-mismatch"
      | "package-identity-collision"
      | "clock-unverified"
      | "stale-approval"
      | "runtime-closed",
  ) {
    super(message);
    this.name = "GrantError";
  }
}

// ---------------------------------------------------------------------------
// Monotonic clock seam.
// ---------------------------------------------------------------------------

/**
 * A monotonic time source for expiry accounting.
 *
 * ADR-0129 requires a SUSPEND-INCLUSIVE source (`CLOCK_BOOTTIME` or
 * `mach_continuous_time`), for two distinct reasons: wall-clock is rejected
 * because moving the system clock backward would extend a grant, and plain
 * `CLOCK_MONOTONIC` is rejected because it excludes time the host is
 * suspended — and suspending is reachable through the bash tool
 * (`systemctl suspend`, `pmset sleepnow`), so repeated suspend/resume cycles
 * could stall the countdown across far more wall-clock time than intended.
 * Darwin needs the same care, not less: its `CLOCK_MONOTONIC` /
 * `mach_absolute_time` also pause across sleep.
 *
 * #929 owns resolving and VERIFYING such a source on both platforms.
 */
export interface MonotonicClock {
  /** Milliseconds since an arbitrary fixed origin. */
  nowMs(): number;
  /**
   * True only when this source has been verified suspend-inclusive on the
   * running platform. Grants created under a false value carry
   * `clockSuspendInclusive: false`, and dispatch (#930) must refuse them.
   */
  readonly suspendInclusive: boolean;
}

/**
 * Default clock: `process.hrtime.bigint()`, which is NOT suspend-inclusive on
 * either supported platform. It is safe as the #928 default only because #928
 * introduces no dispatch path — nothing yet enforces expiry, so nothing can
 * yet be extended by stalling it. It must not survive #929.
 */
export const hrtimeClock: MonotonicClock = {
  nowMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  suspendInclusive: false,
};

// ---------------------------------------------------------------------------
// Per-identity authority lock.
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: () => void;
}

/** An in-process mutex with a preemptive queue ahead of the normal queue. */
class AuthorityLock {
  private held = false;
  private readonly preemptive: Waiter[] = [];
  private readonly normal: Waiter[] = [];

  async acquire(priority: "normal" | "preemptive" = "normal"): Promise<void> {
    if (!this.held) {
      this.held = true;
      return;
    }
    await new Promise<void>((resolve) => {
      (priority === "preemptive" ? this.preemptive : this.normal).push({ resolve });
    });
  }

  release(): void {
    const next = this.preemptive.shift() ?? this.normal.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.held = false;
  }

  /** Waiters currently queued (tests and #929's starvation assertions). */
  get queueDepth(): number {
    return this.preemptive.length + this.normal.length;
  }
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

export interface GrantRegistryOptions {
  clock?: MonotonicClock;
  /** Test seam: fixed runtime instance id. Production always randomizes. */
  runtimeInstanceIdOverride?: string;
  /** Test seam: wall-clock source. */
  wallClockMs?: () => number;
}

export class GrantRegistry {
  /** High-entropy, generated once per runtime. Never derived from the PID. */
  readonly runtimeInstanceId: string;

  private readonly clock: MonotonicClock;
  private readonly wallClockMs: () => number;
  private readonly grants = new Map<string, ActiveGrant>();
  private readonly locks = new Map<string, AuthorityLock>();
  private readonly sequences = new Map<string, number>();
  /**
   * Grants retired by expiry, awaiting `drainExpired`. Growth is bounded in
   * practice: expiry is only observed inside command-driven registry calls,
   * and every broker command drains this log before returning (#929). The
   * log is evidence for the audit trail, never authority — an entry here
   * proves the grant is already gone.
   */
  private readonly expiredLog: ActiveGrant[] = [];
  private closed = false;

  constructor(options: GrantRegistryOptions = {}) {
    this.runtimeInstanceId =
      options.runtimeInstanceIdOverride ??
      randomBytes(RUNTIME_INSTANCE_ID_BYTES).toString("hex");
    this.clock = options.clock ?? hrtimeClock;
    this.wallClockMs = options.wallClockMs ?? (() => Date.now());
  }

  private lockFor(qualifiedId: string): AuthorityLock {
    let lock = this.locks.get(qualifiedId);
    if (!lock) {
      lock = new AuthorityLock();
      this.locks.set(qualifiedId, lock);
    }
    return lock;
  }

  /**
   * Run `fn` under one identity's authority lock.
   *
   * Callers must not perform receipt or audit I/O inside `fn` — see the
   * ordering rule in this file's header.
   */
  async withAuthorityLock<T>(
    qualifiedId: string,
    fn: () => T | Promise<T>,
    priority: "normal" | "preemptive" = "normal",
  ): Promise<T> {
    if (this.closed) throw new GrantError("runtime authority is closed", "runtime-closed");
    const lock = this.lockFor(qualifiedId);
    await lock.acquire(priority);
    try {
      if (this.closed) throw new GrantError("runtime authority is closed", "runtime-closed");
      return await fn();
    } finally {
      lock.release();
    }
  }

  /** Re-approval must not be starved by queued normal authority work. */
  withApprovalLock<T>(qualifiedId: string, fn: () => T | Promise<T>): Promise<T> {
    return this.withAuthorityLock(qualifiedId, fn, "preemptive");
  }

  /**
   * Mint the approval-instance material for a new approval of `qualifiedId`.
   *
   * The sequence is monotonic per identity per runtime and is consumed
   * whether or not the approval ultimately commits: a sequence number is an
   * ordering token, and reusing one after an aborted approval would make two
   * distinct approval attempts indistinguishable in the audit trail.
   */
  mintApprovalBinding(qualifiedId: string): ApprovalBinding {
    if (this.closed) throw new GrantError("runtime authority is closed", "runtime-closed");
    const sequence = (this.sequences.get(qualifiedId) ?? 0) + 1;
    this.sequences.set(qualifiedId, sequence);
    const nowMs = this.wallClockMs();
    const nowMonotonicMs = this.clock.nowMs();
    return {
      approval: { runtimeInstanceId: this.runtimeInstanceId, sequence },
      nonce: randomBytes(GRANT_NONCE_BYTES).toString("hex"),
      expiresAtMs: nowMs + GRANT_LIFETIME_MS,
      expiresAtMonotonicMs: nowMonotonicMs + GRANT_LIFETIME_MS,
      clockSuspendInclusive: this.clock.suspendInclusive,
    };
  }

  /**
   * Install a grant, atomically retiring any prior grant for the same
   * identity (ADR-0129: two approval identifiers for one identity are never
   * simultaneously resolvable, so a later `revoke` always has exactly one
   * target).
   *
   * MUST be called inside `withAuthorityLock` for the same identity; the
   * assertion below is a coding-error guard, not a security control.
   *
   * This method is the ENFORCEMENT POINT for the package-identity collision,
   * not merely a second opinion. The authority lock is keyed by qualified id,
   * and a qualified id includes the ref — so two approvals for two refs of the
   * same package agent take *different* locks and do not serialize against
   * each other. A caller-side pre-check alone could therefore be passed by
   * both and leave two coexisting grants for what an operator reads as one
   * agent. Checking here closes that: this method contains no `await`, so the
   * conflict scan and the map insertion cannot interleave.
   *
   * The cap is enforced by REFUSING at the limit rather than evicting the
   * oldest grant: eviction would silently destroy authority the operator
   * granted in person, and a fail-closed refusal is recoverable by revoking
   * something.
   */
  install(definition: EffectiveDefinition, digest: string): ActiveGrant {
    if (this.closed) throw new GrantError("runtime authority is closed", "runtime-closed");
    const qualifiedId = definition.qualifiedId;
    const newestSequence = this.sequences.get(qualifiedId) ?? 0;
    if (definition.approval.sequence < newestSequence) {
      throw new GrantError("approval was superseded by a newer approval attempt", "stale-approval");
    }
    if (definition.approval.runtimeInstanceId !== this.runtimeInstanceId) {
      throw new GrantError(
        "approval identifier was not minted by this runtime",
        "identity-mismatch",
      );
    }
    const conflict = packageIdentityConflict(
      {
        qualifiedId,
        host: definition.packageIdentity.host,
        path: definition.packageIdentity.path,
        ref: definition.packageIdentity.ref,
        agentName: definition.agentName,
      },
      [...this.grants.values()].map((g) => ({
        qualifiedId: g.qualifiedId,
        host: g.definition.packageIdentity.host,
        path: g.definition.packageIdentity.path,
        ref: g.definition.packageIdentity.ref,
        agentName: g.definition.agentName,
      })),
    );
    if (conflict !== null) {
      throw new GrantError(
        `an active grant already exists for this package agent at ref ${conflict.ref}`,
        "package-identity-collision",
      );
    }
    if (!this.grants.has(qualifiedId) && this.grants.size >= GRANT_BOUNDS.maxActiveGrants) {
      throw new GrantError(
        `active grant cap reached (${GRANT_BOUNDS.maxActiveGrants}); revoke a grant before approving another`,
        "grant-cap-reached",
      );
    }
    const grant: ActiveGrant = Object.freeze({
      kind: ACTIVE_GRANT_KIND,
      schemaVersion: GRANT_SCHEMA_VERSION,
      qualifiedId,
      approval: { ...definition.approval },
      digest,
      definition,
      approvedAtMs: this.wallClockMs(),
      approvedAtMonotonicMs: this.clock.nowMs(),
      expiresAtMs: definition.expiresAtMs,
      expiresAtMonotonicMs: definition.expiresAtMonotonicMs,
    });
    this.grants.set(qualifiedId, grant);
    return grant;
  }

  private expireUnlocked(qualifiedId: string): ActiveGrant | null {
    const grant = this.grants.get(qualifiedId) ?? null;
    if (grant !== null && this.clock.nowMs() >= grant.expiresAtMonotonicMs) {
      this.grants.delete(qualifiedId);
      this.expiredLog.push(grant);
      return grant;
    }
    return null;
  }

  /**
   * Return and clear the expiry-retirement log (#929). Callers audit the
   * returned grants OUTSIDE any authority lock, per the ordering rule in
   * this file's header.
   */
  drainExpired(): ActiveGrant[] {
    return this.expiredLog.splice(0);
  }

  /** Read one usable grant under its authority lock, retiring expiry atomically. */
  async get(qualifiedId: string): Promise<ActiveGrant | null> {
    return this.withAuthorityLock(qualifiedId, () => {
      this.expireUnlocked(qualifiedId);
      return this.grants.get(qualifiedId) ?? null;
    });
  }

  /** Preemptively remove one grant; the returned grant is evidence only. */
  async revoke(qualifiedId: string): Promise<ActiveGrant | null> {
    return this.withAuthorityLock(qualifiedId, () => {
      this.expireUnlocked(qualifiedId);
      const grant = this.grants.get(qualifiedId) ?? null;
      if (grant !== null) this.grants.delete(qualifiedId);
      return grant;
    }, "preemptive");
  }

  /**
   * Synchronously invalidate this runtime before shutdown work can await.
   * Returns the grants that were live at the moment of invalidation —
   * evidence for a best-effort shutdown audit record, never authority (they
   * are already unreachable by the time the caller sees them).
   */
  close(): ActiveGrant[] {
    this.closed = true;
    const cleared = [...this.grants.values()];
    this.grants.clear();
    return cleared;
  }

  /**
   * Snapshot every grant, taking each identity's authority lock in a
   * deterministic (sorted) order. Read-only display paths take the lock
   * because a status read that raced a revocation would otherwise report
   * authority that no longer exists — and status is the operator's only
   * window onto an object they cannot otherwise see.
   */
  async list(): Promise<ActiveGrant[]> {
    const ids = [...this.grants.keys()].sort();
    const out: ActiveGrant[] = [];
    for (const id of ids) {
      const grant = await this.get(id);
      if (grant) out.push(grant);
    }
    return out;
  }

  /**
   * Synchronous, LOCK-FREE snapshot of the current grants.
   *
   * Intended for callers that already hold an authority lock: `list()` would
   * deadlock in that position, because it re-acquires the very lock the caller
   * is holding. The value it returns is advisory — it feeds operator-facing
   * refusal messages, never an authorization decision. The authoritative
   * package-identity check happens inside `install`, which is synchronous and
   * therefore cannot interleave.
   */
  snapshotUnlocked(): ActiveGrant[] {
    return [...this.grants.values()];
  }

  /** Current grant count. Not lock-protected: a count is not authority. */
  get size(): number {
    return this.grants.size;
  }

  /** Queued authority-lock waiters for one identity (tests). */
  queueDepth(qualifiedId: string): number {
    return this.lockFor(qualifiedId).queueDepth;
  }
}
