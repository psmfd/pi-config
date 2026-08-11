/**
 * grant-registry.test.ts — the in-memory authority registry (#928).
 *
 * Covers the grant cap, re-approval's atomic retire-and-replace, approval
 * sequence semantics, the per-identity authority lock (including the
 * preemptive queue #929 needs for revocation), and the clock seam's
 * fail-visible default.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GRANT_BOUNDS,
  GRANT_LIFETIME_MS,
  type EffectiveDefinition,
} from "../../shared/package-agent-grant-contract.ts";
import { GrantError, GrantRegistry, hrtimeClock, type MonotonicClock } from "../lib/grant-registry.ts";

const RUNTIME_ID = "a".repeat(64);

const verifiedClock: MonotonicClock = { nowMs: () => 0, suspendInclusive: true };

function makeRegistry(clock: MonotonicClock = verifiedClock): GrantRegistry {
  return new GrantRegistry({
    runtimeInstanceIdOverride: RUNTIME_ID,
    wallClockMs: () => 1_800_000_000_000,
    clock,
  });
}

/**
 * A minimal definition stand-in. The registry never inspects definition
 * contents beyond the identity and approval fields, so a partial object cast
 * here keeps the test focused on registry behaviour rather than digest shape.
 */
function definition(qualifiedId: string, sequence: number, ref = "v1.0.0"): EffectiveDefinition {
  return {
    qualifiedId,
    agentName: qualifiedId.slice(qualifiedId.indexOf("#") + 1),
    packageIdentity: { source: `git:github.com/o/p@${ref}`, host: "github.com", path: "o/p", ref, observedCommit: "b".repeat(40) },
    approval: { runtimeInstanceId: RUNTIME_ID, sequence },
    expiresAtMs: 1_800_000_000_000 + GRANT_LIFETIME_MS,
    expiresAtMonotonicMs: GRANT_LIFETIME_MS,
    clockSuspendInclusive: true,
  } as unknown as EffectiveDefinition;
}

function qid(n: number): string {
  return `git:github.com/psmfd/pkg${n}@v1.0.0#agent-${n}`;
}

// --- cap --------------------------------------------------------------------

test("the grant cap refuses rather than evicting", async () => {
  const registry = makeRegistry();
  for (let i = 0; i < GRANT_BOUNDS.maxActiveGrants; i++) {
    await registry.withAuthorityLock(qid(i), () => registry.install(definition(qid(i), 1), "d".repeat(64)));
  }
  assert.equal(registry.size, GRANT_BOUNDS.maxActiveGrants);

  const over = qid(GRANT_BOUNDS.maxActiveGrants);
  await assert.rejects(
    registry.withAuthorityLock(over, () => registry.install(definition(over, 1), "d".repeat(64))),
    (err: unknown) => err instanceof GrantError && err.reason === "grant-cap-reached",
  );
  // Nothing was evicted: authority an operator granted in person survives a
  // refused approval.
  assert.equal(registry.size, GRANT_BOUNDS.maxActiveGrants);
  assert.ok(await registry.get(qid(0)));
});

test("re-approving an existing identity is allowed at the cap", async () => {
  const registry = makeRegistry();
  for (let i = 0; i < GRANT_BOUNDS.maxActiveGrants; i++) {
    await registry.withAuthorityLock(qid(i), () => registry.install(definition(qid(i), 1), "d".repeat(64)));
  }
  const replaced = await registry.withAuthorityLock(qid(0), () =>
    registry.install(definition(qid(0), 2), "e".repeat(64)),
  );
  assert.equal(replaced.approval.sequence, 2);
  assert.equal(registry.size, GRANT_BOUNDS.maxActiveGrants);
});

// --- re-approval ------------------------------------------------------------

test("re-approval replaces the prior grant, leaving exactly one resolvable", async () => {
  const registry = makeRegistry();
  const id = qid(1);
  await registry.withAuthorityLock(id, () => registry.install(definition(id, 1), "d".repeat(64)));
  await registry.withAuthorityLock(id, () => registry.install(definition(id, 2), "e".repeat(64)));

  const grants = await registry.list();
  assert.equal(grants.length, 1);
  assert.equal(grants[0].approval.sequence, 2);
  assert.equal(grants[0].digest, "e".repeat(64));
});

test("a grant minted by another runtime is refused", async () => {
  const registry = makeRegistry();
  const id = qid(1);
  const foreign = {
    ...definition(id, 1),
    approval: { runtimeInstanceId: "f".repeat(64), sequence: 1 },
  } as EffectiveDefinition;
  await assert.rejects(
    registry.withAuthorityLock(id, () => registry.install(foreign, "d".repeat(64))),
    (err: unknown) => err instanceof GrantError && err.reason === "identity-mismatch",
  );
});

// --- approval identifiers ---------------------------------------------------

test("approval sequences are monotonic per identity and independent across identities", () => {
  const registry = makeRegistry();
  assert.equal(registry.mintApprovalBinding(qid(1)).approval.sequence, 1);
  assert.equal(registry.mintApprovalBinding(qid(1)).approval.sequence, 2);
  assert.equal(registry.mintApprovalBinding(qid(2)).approval.sequence, 1);
  assert.equal(registry.mintApprovalBinding(qid(1)).approval.sequence, 3);
});

test("a sequence is consumed even when the approval never commits", () => {
  // An aborted approval must stay distinguishable in the audit trail from
  // the retry that follows it.
  const registry = makeRegistry();
  const first = registry.mintApprovalBinding(qid(1));
  const second = registry.mintApprovalBinding(qid(1));
  assert.notEqual(first.approval.sequence, second.approval.sequence);
  assert.notEqual(first.nonce, second.nonce);
});

test("nonces are 32-byte hex and unique per approval", () => {
  const registry = makeRegistry();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { nonce } = registry.mintApprovalBinding(qid(1));
    assert.match(nonce, /^[0-9a-f]{64}$/);
    assert.ok(!seen.has(nonce), "nonce reuse");
    seen.add(nonce);
  }
});

test("the runtime instance id is high-entropy hex, not derived from the pid", () => {
  const a = new GrantRegistry();
  const b = new GrantRegistry();
  assert.match(a.runtimeInstanceId, /^[0-9a-f]{64}$/);
  assert.notEqual(a.runtimeInstanceId, b.runtimeInstanceId);
  assert.ok(!a.runtimeInstanceId.includes(String(process.pid)) || a.runtimeInstanceId.length === 64);
});

// --- expiry and the clock seam ----------------------------------------------

test("expiry is the operator-set absolute lifetime from approval", () => {
  const registry = makeRegistry();
  const binding = registry.mintApprovalBinding(qid(1));
  assert.equal(binding.expiresAtMs, 1_800_000_000_000 + GRANT_LIFETIME_MS);
  assert.equal(GRANT_LIFETIME_MS, 4 * 60 * 60 * 1000);
});

test("the legacy hrtime clock remains visibly unverified", () => {
  assert.equal(hrtimeClock.suspendInclusive, false);
  assert.equal(makeRegistry(hrtimeClock).mintApprovalBinding(qid(1)).clockSuspendInclusive, false);
});

test("a verified suspend-inclusive clock propagates into the binding", () => {
  const verified: MonotonicClock = { nowMs: () => 5_000, suspendInclusive: true };
  const binding = makeRegistry(verified).mintApprovalBinding(qid(1));
  assert.equal(binding.clockSuspendInclusive, true);
  assert.equal(binding.expiresAtMonotonicMs, 5_000 + GRANT_LIFETIME_MS);
});

test("monotonic expiry does not follow a backward wall-clock jump", () => {
  let wall = 1_800_000_000_000;
  let mono = 1_000;
  const registry = new GrantRegistry({
    runtimeInstanceIdOverride: RUNTIME_ID,
    wallClockMs: () => wall,
    clock: { nowMs: () => mono, suspendInclusive: true },
  });
  const before = registry.mintApprovalBinding(qid(1));
  wall -= 60 * 60 * 1000; // operator (or attacker) moves the system clock back
  mono += 1_000;
  const after = registry.mintApprovalBinding(qid(1));
  assert.ok(after.expiresAtMs < before.expiresAtMs, "wall-clock expiry follows the jump");
  assert.ok(after.expiresAtMonotonicMs > before.expiresAtMonotonicMs, "monotonic expiry must not");
});

// --- authority lock ---------------------------------------------------------

test("the authority lock serializes holders for one identity", async () => {
  const registry = makeRegistry();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = registry.withAuthorityLock(qid(1), async () => {
    order.push("first-enter");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    order.push("first-exit");
  });
  // Give the first holder a turn to enter before queueing the second.
  await Promise.resolve();
  const second = registry.withAuthorityLock(qid(1), () => {
    order.push("second-enter");
  });
  assert.equal(registry.queueDepth(qid(1)), 1);
  (releaseFirst as () => void)();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
});

test("locks are per identity, so one agent never serializes behind another", async () => {
  const registry = makeRegistry();
  let release: (() => void) | undefined;
  const blocking = registry.withAuthorityLock(qid(1), async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await Promise.resolve();
  // A different identity proceeds immediately rather than queueing.
  let ran = false;
  await registry.withAuthorityLock(qid(2), () => {
    ran = true;
  });
  assert.ok(ran);
  assert.equal(registry.queueDepth(qid(2)), 0);
  (release as () => void)();
  await blocking;
});

test("a preemptive waiter takes the lock ahead of queued normal waiters", async () => {
  // #929 needs this: a plain FIFO mutex would let sustained dispatch traffic
  // spawn children after the operator revoked but before the revocation runs.
  const registry = makeRegistry();
  const order: string[] = [];
  let release: (() => void) | undefined;
  const holder = registry.withAuthorityLock(qid(1), async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await Promise.resolve();

  const normalA = registry.withAuthorityLock(qid(1), () => void order.push("normal-a"));
  const normalB = registry.withAuthorityLock(qid(1), () => void order.push("normal-b"));
  const preemptive = registry.withApprovalLock(qid(1), () => void order.push("preemptive"));
  assert.equal(registry.queueDepth(qid(1)), 3);

  (release as () => void)();
  await Promise.all([holder, normalA, normalB, preemptive]);
  assert.equal(order[0], "preemptive", `preemptive waiter must run first, saw ${order.join(",")}`);
});

// --- reads take the lock ----------------------------------------------------

test("list returns grants in deterministic identity order", async () => {
  const registry = makeRegistry();
  for (const n of [3, 1, 2]) {
    await registry.withAuthorityLock(qid(n), () => registry.install(definition(qid(n), 1), "d".repeat(64)));
  }
  const ids = (await registry.list()).map((g) => g.qualifiedId);
  assert.deepEqual(ids, [...ids].sort());
});

test("get returns null for an unknown identity rather than throwing", async () => {
  assert.equal(await makeRegistry().get(qid(9)), null);
});

test("the exact monotonic expiry boundary retires authority", async () => {
  let now = 0;
  const registry = makeRegistry({ nowMs: () => now, suspendInclusive: true });
  const id = qid(9);
  await registry.withApprovalLock(id, () => registry.install(definition(id, 1), "d".repeat(64)));
  now = GRANT_LIFETIME_MS - 1;
  assert.ok(await registry.get(id));
  now = GRANT_LIFETIME_MS;
  assert.equal(await registry.get(id), null);
  assert.equal(registry.size, 0);
});

test("expiry while queued behind authority work cannot return a stale grant", async () => {
  let now = 0;
  const registry = makeRegistry({ nowMs: () => now, suspendInclusive: true });
  const id = qid(10);
  await registry.withApprovalLock(id, () => registry.install(definition(id, 1), "d".repeat(64)));
  let release: (() => void) | undefined;
  const holder = registry.withAuthorityLock(id, async () => {
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await Promise.resolve();
  const reader = registry.get(id);
  now = GRANT_LIFETIME_MS;
  (release as () => void)();
  assert.equal(await reader, null);
  await holder;
  assert.equal(registry.size, 0);
});

// --- package-identity collisions are enforced at install --------------------
//
// Regression guards for the post-implementation security review of #928. The
// authority lock is keyed by qualified id, and a qualified id includes the
// ref — so two approvals for two refs of the same package agent take
// DIFFERENT locks and do not serialize. A caller-side pre-check alone could
// be passed by both. `install` is therefore the enforcement point.

test("install refuses a second ref of the same package agent", async () => {
  const registry = makeRegistry();
  const v1 = "git:github.com/psmfd/pkg1@v1.0.0#agent-1";
  const v2 = "git:github.com/psmfd/pkg1@v2.0.0#agent-1";
  await registry.withAuthorityLock(v1, () => registry.install(definition(v1, 1, "v1.0.0"), "d".repeat(64)));
  await assert.rejects(
    registry.withAuthorityLock(v2, () => registry.install(definition(v2, 1, "v2.0.0"), "e".repeat(64))),
    (err: unknown) => err instanceof GrantError && err.reason === "package-identity-collision",
  );
  assert.equal(registry.size, 1);
});

test("two different-ref approvals cannot both install by racing their locks", async () => {
  // The lock keys differ, so both callbacks genuinely run concurrently. Only
  // one may end up installed.
  const registry = makeRegistry();
  const v1 = "git:github.com/psmfd/pkg1@v1.0.0#agent-1";
  const v2 = "git:github.com/psmfd/pkg1@v2.0.0#agent-1";
  const results = await Promise.allSettled([
    registry.withAuthorityLock(v1, () => registry.install(definition(v1, 1, "v1.0.0"), "d".repeat(64))),
    registry.withAuthorityLock(v2, () => registry.install(definition(v2, 1, "v2.0.0"), "e".repeat(64))),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one must install");
  assert.equal(registry.size, 1);
});

test("install still permits a different agent in the same package", async () => {
  const registry = makeRegistry();
  const a = "git:github.com/psmfd/pkg1@v1.0.0#agent-1";
  const b = "git:github.com/psmfd/pkg1@v1.0.0#agent-2";
  await registry.withAuthorityLock(a, () => registry.install(definition(a, 1), "d".repeat(64)));
  await registry.withAuthorityLock(b, () => registry.install(definition(b, 1), "e".repeat(64)));
  assert.equal(registry.size, 2);
});

test("snapshotUnlocked is usable while holding an authority lock", async () => {
  // `list()` would deadlock in this position: it re-acquires the very lock
  // the caller holds.
  const registry = makeRegistry();
  const id = qid(1);
  await registry.withAuthorityLock(id, () => registry.install(definition(id, 1), "d".repeat(64)));
  const seen = await registry.withAuthorityLock(id, () => registry.snapshotUnlocked().length);
  assert.equal(seen, 1);
});

test("revocation preempts queued normal users and removes authority", async () => {
  const registry = makeRegistry();
  const id = qid(1);
  await registry.withAuthorityLock(id, () => registry.install(definition(id, 1), "d".repeat(64)));
  let release: (() => void) | undefined;
  const holder = registry.withAuthorityLock(id, async () => {
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await Promise.resolve();
  const normal = registry.withAuthorityLock(id, () =>
    registry.snapshotUnlocked().find((grant) => grant.qualifiedId === id) ?? null,
  );
  const revoke = registry.revoke(id);
  (release as () => void)();
  const [removed, after] = await Promise.all([revoke, normal]);
  await holder;
  assert.ok(removed);
  assert.equal(after, null);
  assert.equal(await registry.get(id), null);
});

test("close makes queued and future authority operations fail closed", async () => {
  const registry = makeRegistry();
  registry.close();
  await assert.rejects(
    registry.get(qid(1)),
    (err: unknown) => err instanceof GrantError && err.reason === "runtime-closed",
  );
});

// --- lifecycle evidence seams (#929) ----------------------------------------

test("an expiry retirement is drainable exactly once", async () => {
  let t = 0;
  const registry = makeRegistry({ nowMs: () => t, suspendInclusive: true });
  const id = qid(1);
  await registry.withAuthorityLock(id, () => registry.install(definition(id, 1), "d".repeat(64)));
  assert.deepEqual(registry.drainExpired(), [], "nothing expired yet");

  t = GRANT_LIFETIME_MS;
  assert.equal(await registry.get(id), null, "the grant is retired at expiry");
  const drained = registry.drainExpired();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].qualifiedId, id);
  assert.deepEqual(registry.drainExpired(), [], "a retirement drains exactly once");
});

test("close returns the grants that were live, as evidence only", async () => {
  const registry = makeRegistry();
  await registry.withAuthorityLock(qid(1), () => registry.install(definition(qid(1), 1), "d".repeat(64)));
  await registry.withAuthorityLock(qid(2), () => registry.install(definition(qid(2), 1), "e".repeat(64)));
  const cleared = registry.close();
  assert.deepEqual(cleared.map((g) => g.qualifiedId).sort(), [qid(1), qid(2)].sort());
  assert.equal(registry.size, 0, "the returned grants are already unreachable");
  assert.deepEqual(registry.close(), [], "a second close has nothing left to report");
});
