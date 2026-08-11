/**
 * dispatch-admission.ts — the runtime-local dispatch-admission seam (#929,
 * ADR-0129 "per-runtime dispatch concurrency and rate bound").
 *
 * This module is RESOURCE CONTAINMENT, not authorization. Admission never
 * reads a grant, never proves authority, and never substitutes for the
 * dispatch-time digest revalidation #930 performs under the authority lock.
 * Its purpose is to keep model-reachable dispatch volume bounded so that
 * sustained traffic can neither exhaust the host nor delay a revocation.
 *
 * No caller exists in #929: the broker instantiates the controller and wires
 * revocation-cancellation and shutdown, but nothing user-visible can request
 * admission until #930 lands the dispatch ingress (gated on #934). Shipping
 * the seam first means #930 consumes a reviewed contract instead of
 * retrofitting one around live dispatch code.
 *
 * The limits are implementation parameters under ADR-0129, fixed on issue
 * #929 (2026-07-29). Materially raising or removing any of them needs
 * renewed security review:
 *
 *   - 4 concurrently active callbacks;
 *   - 16 queued requests globally, at most 4 per qualified identity;
 *   - 12 promoted starts per exact rolling 60 seconds;
 *   - 60-second maximum queue age.
 *
 * Semantics fixed by the same decision:
 *
 *   - retries, parallel work items, and chain steps are INDEPENDENT requests
 *     — nothing here recognizes or coalesces a "retry";
 *   - a promoted attempt consumes a rate-window start even if the dispatch
 *     it admitted later fails revalidation or spawn (release() frees the
 *     concurrency slot, never refunds the start);
 *   - revocation and re-approval BYPASS admission entirely — they ride the
 *     preemptive authority-lock path and must never queue behind
 *     model-driven dispatch traffic;
 *   - revocation cancels every queued request for its identity
 *     (`cancelIdentity`), so no request admitted after the operator revoked
 *     can be sitting in this queue waiting to run.
 */

export const ADMISSION_LIMITS = {
  /** Concurrently active (promoted, unreleased) dispatch callbacks. */
  maxActive: 4,
  /** Queued requests across all identities. */
  maxQueued: 16,
  /** Queued requests per qualified identity. */
  maxQueuedPerIdentity: 4,
  /** Promoted starts permitted per rolling window. */
  maxStartsPerWindow: 12,
  /** The exact rolling window over promoted starts. */
  startWindowMs: 60_000,
  /** A queued request older than this is refused, not promoted. */
  maxQueueAgeMs: 60_000,
} as const;

export type AdmissionRefusal =
  | "queue-full"
  | "identity-queue-full"
  | "queue-expired"
  | "revoked"
  | "closed";

export interface AdmissionTicket {
  /** Free the concurrency slot. Idempotent. Never refunds the rate start. */
  release(): void;
}

export type AdmissionDecision =
  | { admitted: true; ticket: AdmissionTicket }
  | { admitted: false; reason: AdmissionRefusal };

interface QueueEntry {
  qualifiedId: string;
  enqueuedAtMs: number;
  resolve: (decision: AdmissionDecision) => void;
}

interface ScheduledWake {
  cancel(): void;
}

export interface DispatchAdmissionOptions {
  /** Test seam: monotonic time source. Defaults to process.hrtime. */
  nowMs?: () => number;
  /** Test seam: one-shot wake scheduler. Defaults to an unref'd setTimeout. */
  schedule?: (fn: () => void, delayMs: number) => ScheduledWake;
}

function defaultSchedule(fn: () => void, delayMs: number): ScheduledWake {
  const timer = setTimeout(fn, delayMs);
  // Never keep the process alive for a queue pump; a missed wake only delays
  // a promotion or an age-refusal, never authority.
  (timer as unknown as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(timer) };
}

export class DispatchAdmission {
  private readonly nowMs: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => ScheduledWake;
  private readonly queue: QueueEntry[] = [];
  /** Promotion timestamps inside the current rolling window, oldest first. */
  private starts: number[] = [];
  private active = 0;
  private wake: ScheduledWake | null = null;
  private closed = false;

  constructor(options: DispatchAdmissionOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /**
   * Request admission for one dispatch attempt of `qualifiedId`.
   *
   * Resolves admitted (with a ticket the caller MUST release when the
   * dispatch attempt ends, however it ends) or refused. A queued request
   * resolves later — on promotion, age-out, identity cancellation, or close.
   */
  admit(qualifiedId: string): Promise<AdmissionDecision> {
    if (this.closed) return Promise.resolve({ admitted: false, reason: "closed" });
    this.pump();
    if (this.canPromote()) {
      return Promise.resolve(this.promote());
    }
    if (this.queue.length >= ADMISSION_LIMITS.maxQueued) {
      return Promise.resolve({ admitted: false, reason: "queue-full" });
    }
    const perIdentity = this.queue.filter((e) => e.qualifiedId === qualifiedId).length;
    if (perIdentity >= ADMISSION_LIMITS.maxQueuedPerIdentity) {
      return Promise.resolve({ admitted: false, reason: "identity-queue-full" });
    }
    return new Promise<AdmissionDecision>((resolve) => {
      this.queue.push({ qualifiedId, enqueuedAtMs: this.nowMs(), resolve });
      this.armWake();
    });
  }

  /**
   * Cancel every QUEUED request for one identity (revocation path). Requests
   * already promoted are untouched: a child created before the revocation
   * linearization point may already be active (ADR-0129, "Revocation and
   * lifetime"); dispatch-time revalidation under the authority lock is what
   * stops the not-yet-spawned ones.
   */
  cancelIdentity(qualifiedId: string): number {
    let cancelled = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].qualifiedId === qualifiedId) {
        const [entry] = this.queue.splice(i, 1);
        entry.resolve({ admitted: false, reason: "revoked" });
        cancelled += 1;
      }
    }
    // Re-arm against the live queue: the armed wake may have been keyed to
    // an entry just cancelled (stale-firing self-heals, but an emptied queue
    // must not leave a dangling timer).
    if (cancelled > 0) this.armWake();
    return cancelled;
  }

  /** Refuse everything queued and every future request. Idempotent. */
  close(): void {
    this.closed = true;
    this.wake?.cancel();
    this.wake = null;
    for (const entry of this.queue.splice(0)) {
      entry.resolve({ admitted: false, reason: "closed" });
    }
  }

  /** Queued request count (tests and status display). */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Active (promoted, unreleased) count (tests and status display). */
  get activeCount(): number {
    return this.active;
  }

  private pruneStarts(nowMs: number): void {
    const cutoff = nowMs - ADMISSION_LIMITS.startWindowMs;
    let drop = 0;
    while (drop < this.starts.length && this.starts[drop] <= cutoff) drop += 1;
    if (drop > 0) this.starts = this.starts.slice(drop);
  }

  private canPromote(): boolean {
    this.pruneStarts(this.nowMs());
    return (
      this.active < ADMISSION_LIMITS.maxActive &&
      this.starts.length < ADMISSION_LIMITS.maxStartsPerWindow
    );
  }

  private promote(): AdmissionDecision {
    this.starts.push(this.nowMs());
    this.active += 1;
    let released = false;
    const ticket: AdmissionTicket = {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.pump();
      },
    };
    return { admitted: true, ticket };
  }

  /**
   * Age out stale queued entries, promote FIFO while capacity and rate
   * allow, and arm the next wake if anything remains queued.
   */
  private pump(): void {
    if (this.closed) return;
    const nowMs = this.nowMs();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (nowMs - this.queue[i].enqueuedAtMs >= ADMISSION_LIMITS.maxQueueAgeMs) {
        const [entry] = this.queue.splice(i, 1);
        entry.resolve({ admitted: false, reason: "queue-expired" });
      }
    }
    while (this.queue.length > 0 && this.canPromote()) {
      const entry = this.queue.shift() as QueueEntry;
      entry.resolve(this.promote());
    }
    this.armWake();
  }

  /**
   * Schedule the next pump at the earliest event that could change a queued
   * request's outcome: the oldest rate-window start rolling out, or the
   * oldest queued entry aging out. Concurrency-slot frees pump directly via
   * release(), so no timer is needed for them.
   */
  private armWake(): void {
    this.wake?.cancel();
    this.wake = null;
    if (this.closed || this.queue.length === 0) return;
    const nowMs = this.nowMs();
    const delays: number[] = [];
    if (this.starts.length >= ADMISSION_LIMITS.maxStartsPerWindow) {
      delays.push(this.starts[0] + ADMISSION_LIMITS.startWindowMs - nowMs);
    }
    delays.push(this.queue[0].enqueuedAtMs + ADMISSION_LIMITS.maxQueueAgeMs - nowMs);
    const delay = Math.max(1, Math.min(...delays));
    this.wake = this.schedule(() => {
      this.wake = null;
      this.pump();
    }, delay);
  }
}
