/**
 * dispatch-admission.test.ts — the runtime-local admission seam (#929).
 *
 * Covers the four fixed limits (active, global queue, per-identity queue,
 * rolling start rate), queue aging, FIFO promotion, revocation cancellation
 * of queued requests, close semantics, and the no-refund rule for promoted
 * starts. Time and wakes are fully injected — no real timers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMISSION_LIMITS,
  DispatchAdmission,
  type AdmissionDecision,
} from "../lib/dispatch-admission.ts";

const QID_A = "git:github.com/psmfd/pkg@v1.0.0#agent-a";
const QID_B = "git:github.com/psmfd/pkg-b@v1.0.0#agent-b";

interface Clockwork {
  admission: DispatchAdmission;
  advance: (ms: number) => void;
  now: () => number;
  /** Scheduled wakes not yet fired or cancelled (dangling-timer assertions). */
  pendingWakes: () => number;
}

function makeClockwork(): Clockwork {
  let now = 0;
  const wakes: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  const admission = new DispatchAdmission({
    nowMs: () => now,
    schedule: (fn, delayMs) => {
      const wake = { fn, at: now + delayMs, cancelled: false };
      wakes.push(wake);
      return { cancel: () => { wake.cancelled = true; } };
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    // Fire due wakes (earliest first); firing may schedule new ones.
    for (;;) {
      let dueIndex = -1;
      for (let i = 0; i < wakes.length; i++) {
        const w = wakes[i];
        if (!w.cancelled && w.at <= now && (dueIndex === -1 || w.at < wakes[dueIndex].at)) {
          dueIndex = i;
        }
      }
      if (dueIndex === -1) break;
      const [due] = wakes.splice(dueIndex, 1);
      due.fn();
    }
  };
  return {
    admission,
    advance,
    now: () => now,
    pendingWakes: () => wakes.filter((w) => !w.cancelled).length,
  };
}

function admitted(d: AdmissionDecision): d is Extract<AdmissionDecision, { admitted: true }> {
  return d.admitted;
}

async function admitNow(cw: Clockwork, qid = QID_A): Promise<AdmissionDecision> {
  const decision = await cw.admission.admit(qid);
  return decision;
}

// --- concurrency ------------------------------------------------------------

test("admits immediately below the active limit and frees slots on release", async () => {
  const cw = makeClockwork();
  const tickets = [];
  for (let i = 0; i < ADMISSION_LIMITS.maxActive; i++) {
    const d = await admitNow(cw);
    assert.ok(admitted(d), `request ${i} must be admitted`);
    tickets.push(d.ticket);
  }
  assert.equal(cw.admission.activeCount, ADMISSION_LIMITS.maxActive);
  tickets.forEach((t) => t.release());
  assert.equal(cw.admission.activeCount, 0);
});

test("requests beyond the active limit queue and promote FIFO on release", async () => {
  const cw = makeClockwork();
  const first = [];
  for (let i = 0; i < ADMISSION_LIMITS.maxActive; i++) {
    const d = await admitNow(cw);
    assert.ok(admitted(d));
    first.push(d.ticket);
  }
  const order: number[] = [];
  const queuedA = cw.admission.admit(QID_A).then((d) => { order.push(1); return d; });
  const queuedB = cw.admission.admit(QID_B).then((d) => { order.push(2); return d; });
  assert.equal(cw.admission.queueDepth, 2);

  first[0].release();
  const dA = await queuedA;
  assert.ok(admitted(dA), "the oldest queued request promotes first");
  assert.equal(cw.admission.queueDepth, 1);
  first[1].release();
  const dB = await queuedB;
  assert.ok(admitted(dB));
  assert.deepEqual(order, [1, 2], "promotion must be FIFO");
});

test("a released ticket is idempotent and cannot free two slots", async () => {
  const cw = makeClockwork();
  const d = await admitNow(cw);
  assert.ok(admitted(d));
  d.ticket.release();
  d.ticket.release();
  assert.equal(cw.admission.activeCount, 0);
});

// --- queue bounds -----------------------------------------------------------

test("the global queue bound refuses the 17th queued request", async () => {
  const cw = makeClockwork();
  for (let i = 0; i < ADMISSION_LIMITS.maxActive; i++) assert.ok(admitted(await admitNow(cw)));
  // Fill the queue with distinct identities to stay under the per-identity cap.
  for (let i = 0; i < ADMISSION_LIMITS.maxQueued; i++) {
    void cw.admission.admit(`git:github.com/psmfd/pkg${i}@v1.0.0#agent-${i}`);
  }
  assert.equal(cw.admission.queueDepth, ADMISSION_LIMITS.maxQueued);
  const overflow = await cw.admission.admit(QID_B);
  assert.deepEqual(overflow, { admitted: false, reason: "queue-full" });
});

test("the per-identity queue bound refuses a 5th queued request for one identity", async () => {
  const cw = makeClockwork();
  for (let i = 0; i < ADMISSION_LIMITS.maxActive; i++) assert.ok(admitted(await admitNow(cw, QID_B)));
  for (let i = 0; i < ADMISSION_LIMITS.maxQueuedPerIdentity; i++) void cw.admission.admit(QID_A);
  const overflow = await cw.admission.admit(QID_A);
  assert.deepEqual(overflow, { admitted: false, reason: "identity-queue-full" });
  // The global queue still has room for another identity.
  assert.ok(cw.admission.queueDepth < ADMISSION_LIMITS.maxQueued);
});

// --- rate window ------------------------------------------------------------

test("a promoted start is consumed even when the attempt fails immediately", async () => {
  const cw = makeClockwork();
  // 12 promote-and-fail cycles: every release frees the slot but never
  // refunds the start.
  for (let i = 0; i < ADMISSION_LIMITS.maxStartsPerWindow; i++) {
    const d = await admitNow(cw);
    assert.ok(admitted(d));
    d.ticket.release();
  }
  assert.equal(cw.admission.activeCount, 0);
  let resolved: AdmissionDecision | null = null;
  void cw.admission.admit(QID_A).then((d) => { resolved = d; });
  await Promise.resolve();
  assert.equal(resolved, null, "the 13th start inside the window must wait");
  assert.equal(cw.admission.queueDepth, 1);
});

test("the rolling window frees starts exactly as they age out", async () => {
  const cw = makeClockwork();
  for (let i = 0; i < ADMISSION_LIMITS.maxStartsPerWindow; i++) {
    const d = await admitNow(cw);
    assert.ok(admitted(d));
    d.ticket.release();
  }
  cw.advance(10_000);
  let resolved: AdmissionDecision | null = null;
  void cw.admission.admit(QID_A).then((d) => { resolved = d; });
  await Promise.resolve();
  assert.equal(resolved, null);

  // One millisecond before the oldest start leaves the window: still queued.
  cw.advance(ADMISSION_LIMITS.startWindowMs - 10_000 - 1);
  await Promise.resolve();
  assert.equal(resolved, null);

  // The oldest start rolls out; the queued request promotes.
  cw.advance(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(resolved !== null && admitted(resolved), "promotion at the exact window roll");
});

// --- queue aging ------------------------------------------------------------

test("a queued request ages out at the maximum queue age", async () => {
  const cw = makeClockwork();
  const held = [];
  for (let i = 0; i < ADMISSION_LIMITS.maxActive; i++) {
    const d = await admitNow(cw, QID_B);
    assert.ok(admitted(d));
    held.push(d.ticket);
  }
  let resolved: AdmissionDecision | null = null;
  void cw.admission.admit(QID_A).then((d) => { resolved = d; });
  cw.advance(ADMISSION_LIMITS.maxQueueAgeMs - 1);
  await Promise.resolve();
  assert.equal(resolved, null, "one ms early must still be queued");
  cw.advance(1);
  await Promise.resolve();
  assert.deepEqual(resolved, { admitted: false, reason: "queue-expired" });
});

// --- revocation cancellation -------------------------------------------------

test("cancelIdentity refuses queued requests for that identity only", async () => {
  const cw = makeClockwork();
  const held = [];
  for (let i = 0; i < ADMISSION_LIMITS.maxActive; i++) {
    const d = await admitNow(cw, QID_B);
    assert.ok(admitted(d));
    held.push(d.ticket);
  }
  let a1: AdmissionDecision | null = null;
  let a2: AdmissionDecision | null = null;
  let b1: AdmissionDecision | null = null;
  void cw.admission.admit(QID_A).then((d) => { a1 = d; });
  void cw.admission.admit(QID_B).then((d) => { b1 = d; });
  void cw.admission.admit(QID_A).then((d) => { a2 = d; });

  const cancelled = cw.admission.cancelIdentity(QID_A);
  await Promise.resolve();
  assert.equal(cancelled, 2);
  assert.deepEqual(a1, { admitted: false, reason: "revoked" });
  assert.deepEqual(a2, { admitted: false, reason: "revoked" });
  assert.equal(b1, null, "the other identity's queued request is untouched");

  // No request for the revoked identity can promote after cancellation.
  held[0].release();
  await Promise.resolve();
  assert.ok(b1 !== null && admitted(b1 as AdmissionDecision), "the surviving request promotes instead");
});

test("cancelIdentity re-arms the wake against the live queue", async () => {
  const cw = makeClockwork();
  const held = [];
  for (let i = 0; i < ADMISSION_LIMITS.maxActive; i++) {
    const d = await admitNow(cw, QID_B);
    assert.ok(admitted(d));
    held.push(d.ticket);
  }
  void cw.admission.admit(QID_A);
  assert.equal(cw.pendingWakes(), 1, "a queued entry arms a wake");
  cw.admission.cancelIdentity(QID_A);
  await Promise.resolve();
  assert.equal(cw.pendingWakes(), 0, "an emptied queue must not leave a dangling timer");

  // A surviving entry keeps (or re-establishes) its own wake.
  void cw.admission.admit(QID_A);
  void cw.admission.admit(QID_B);
  cw.admission.cancelIdentity(QID_A);
  assert.equal(cw.pendingWakes(), 1, "the surviving entry's wake is re-armed");
});

test("cancelIdentity does not disturb already-promoted attempts", async () => {
  const cw = makeClockwork();
  const d = await admitNow(cw, QID_A);
  assert.ok(admitted(d));
  assert.equal(cw.admission.cancelIdentity(QID_A), 0);
  assert.equal(cw.admission.activeCount, 1, "a promoted attempt is ADR-0129's pre-revocation child");
  d.ticket.release();
});

// --- close ------------------------------------------------------------------

test("close refuses everything queued and every future request", async () => {
  const cw = makeClockwork();
  const held = [];
  for (let i = 0; i < ADMISSION_LIMITS.maxActive; i++) {
    const d = await admitNow(cw, QID_B);
    assert.ok(admitted(d));
    held.push(d.ticket);
  }
  let queued: AdmissionDecision | null = null;
  void cw.admission.admit(QID_A).then((d) => { queued = d; });
  cw.admission.close();
  await Promise.resolve();
  assert.deepEqual(queued, { admitted: false, reason: "closed" });
  assert.deepEqual(await cw.admission.admit(QID_A), { admitted: false, reason: "closed" });
});
