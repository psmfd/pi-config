/**
 * lifecycle-evidence.test.ts — persisted grant-lifecycle evidence (#929).
 *
 * Covers audit-event construction for revocation/expiry/shutdown, the
 * approval-identity guard on receipt terminal stamping, the closed-schema
 * validation failing a whole batch before any write, and the best-effort
 * (swallowed-failure) contract of the shutdown path vs the loud contract of
 * the command path.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  GRANT_RECEIPT_KIND,
  GRANT_SCHEMA_VERSION,
  type ActiveGrant,
  type GrantReceipt,
} from "../../shared/package-agent-grant-contract.ts";
import {
  recordLifecycleEvidence,
  recordShutdownEvidence,
} from "../lib/lifecycle-evidence.ts";
import { StateError, StateStore } from "../lib/state-store.ts";

const QID = "git:github.com/psmfd/pkg@v1.0.0#agent-a";
const RUNTIME_ID = "a".repeat(64);
const DIGEST = "d".repeat(64);

function makeStore(overrides: { lockAttempts?: number } = {}): StateStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pab-lifecycle-"));
  fs.chmodSync(root, 0o700);
  return new StateStore({ rootOverride: root, lockDelayMs: 1, ...overrides });
}

/** Minimal grant stand-in carrying exactly the fields evidence records. */
function grant(sequence = 1, qualifiedId = QID): ActiveGrant {
  return {
    qualifiedId,
    digest: DIGEST,
    approval: { runtimeInstanceId: RUNTIME_ID, sequence },
    expiresAtMs: 1_800_000_000_000,
    definition: {
      packageIdentity: { source: "git:github.com/psmfd/pkg@v1.0.0" },
    },
  } as unknown as ActiveGrant;
}

function receipt(sequence = 1): GrantReceipt {
  return {
    kind: GRANT_RECEIPT_KIND,
    schemaVersion: GRANT_SCHEMA_VERSION,
    authorizing: false,
    qualifiedId: QID,
    runtimeInstanceId: RUNTIME_ID,
    approvalSequence: sequence,
    observedGrantDigest: DIGEST,
    approvedAtMs: 1_700_000_000_000,
    expiresAtMs: 1_800_000_000_000,
  };
}

async function seedReceipt(store: StateStore, sequence = 1): Promise<void> {
  await store.commit(0, (state) => {
    state.grantReceipts[QID] = receipt(sequence);
    return state;
  });
}

test("a revocation observation appends audit and stamps the matching receipt", async () => {
  const store = makeStore();
  await seedReceipt(store);
  await recordLifecycleEvidence(store, [{ grant: grant(), state: "revoked", atMs: 1_700_000_100_000 }]);

  const state = store.load();
  assert.equal(state.audit.length, 1);
  const event = state.audit[0];
  assert.equal(event.kind, "grant-revoked");
  assert.equal(event.qualifiedId, QID);
  assert.equal(event.grantDigest, DIGEST);
  assert.equal(event.approvalSequence, 1);
  assert.equal(event.outcome, "committed");
  assert.equal(event.reason, "operator-declined");
  assert.deepEqual(state.grantReceipts[QID].terminal, { state: "revoked", atMs: 1_700_000_100_000 });
});

test("an expiry observation uses its own kind and reason", async () => {
  const store = makeStore();
  await seedReceipt(store);
  await recordLifecycleEvidence(store, [{ grant: grant(), state: "expired", atMs: 1_700_000_100_000 }]);

  const state = store.load();
  assert.equal(state.audit[0].kind, "grant-expired");
  assert.equal(state.audit[0].reason, "grant-expired");
  assert.deepEqual(state.grantReceipts[QID].terminal, { state: "expired", atMs: 1_700_000_100_000 });
});

test("a terminal stamp never lands on a receipt from a different approval", async () => {
  const store = makeStore();
  await seedReceipt(store, 2); // the persisted receipt is a LATER approval
  await recordLifecycleEvidence(store, [{ grant: grant(1), state: "revoked", atMs: 1_700_000_100_000 }]);

  const state = store.load();
  assert.equal(state.audit.length, 1, "the audit event still lands");
  assert.equal(state.grantReceipts[QID].terminal, undefined, "the newer receipt must not be mislabelled");
});

test("an empty observation batch performs no store I/O", async () => {
  const store = makeStore();
  await recordLifecycleEvidence(store, []);
  assert.equal(store.load().generation, 0);
});

test("an out-of-schema observation fails the whole batch before any write", async () => {
  const store = makeStore();
  const bad = grant();
  (bad as { digest: string }).digest = "not-a-digest";
  await assert.rejects(
    recordLifecycleEvidence(store, [
      { grant: grant(), state: "revoked", atMs: 1_700_000_100_000 },
      { grant: bad, state: "revoked", atMs: 1_700_000_100_000 },
    ]),
  );
  assert.equal(store.load().audit.length, 0, "no partial batch may persist");
});

test("a store failure propagates loudly from the command path", async () => {
  const store = makeStore({ lockAttempts: 1 });
  fs.writeFileSync(path.join(store.root, "lock"), "held\n");
  await assert.rejects(
    recordLifecycleEvidence(store, [{ grant: grant(), state: "revoked", atMs: 1_700_000_100_000 }]),
    (err: unknown) => err instanceof StateError && err.reason === "lock-unavailable",
  );
});

test("shutdown evidence records one event per cleared grant", async () => {
  const store = makeStore();
  const other = "git:github.com/psmfd/pkg-b@v1.0.0#agent-b";
  await recordShutdownEvidence(store, [grant(1), grant(1, other)], 1_700_000_200_000);

  const state = store.load();
  assert.equal(state.audit.length, 2);
  for (const event of state.audit) {
    assert.equal(event.kind, "grant-shutdown-invalidated");
    assert.equal(event.reason, "runtime-shutdown");
    assert.equal(event.outcome, "committed");
  }
  assert.deepEqual(state.audit.map((e) => e.qualifiedId).sort(), [other, QID].sort());
});

test("shutdown evidence swallows store failure by design", async () => {
  const store = makeStore({ lockAttempts: 1 });
  fs.writeFileSync(path.join(store.root, "lock"), "held\n");
  await recordShutdownEvidence(store, [grant()], 1_700_000_200_000); // must not throw
  fs.unlinkSync(path.join(store.root, "lock"));
  assert.equal(store.load().audit.length, 0);
});

// --- load-time terminal-stamp integrity --------------------------------------

function writeStateImage(store: StateStore, terminal: unknown): void {
  const image = {
    schemaVersion: 1,
    generation: 1,
    draftRevisions: {},
    drafts: {},
    grantReceipts: { [QID]: { ...receipt(), ...(terminal === undefined ? {} : { terminal }) } },
    audit: [],
    auditDropped: 0,
  };
  const p = path.join(store.root, "state.json");
  fs.writeFileSync(p, JSON.stringify(image), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

test("a well-formed terminal stamp loads", () => {
  const store = makeStore();
  writeStateImage(store, { state: "revoked", atMs: 1_700_000_100_000 });
  assert.deepEqual(store.load().grantReceipts[QID].terminal, {
    state: "revoked",
    atMs: 1_700_000_100_000,
  });
});

test("a malformed terminal stamp refuses the whole state image", () => {
  const store = makeStore();
  for (const forged of [
    { state: "shutdown", atMs: 1_700_000_100_000 }, // not a terminal state
    { state: "revoked", atMs: -5 },
    { state: "revoked" },
    "revoked",
    42,
  ]) {
    writeStateImage(store, forged);
    assert.throws(
      () => store.load(),
      (err: unknown) => err instanceof StateError && err.reason === "state-integrity-refused",
      `forged terminal ${JSON.stringify(forged)} must refuse the load`,
    );
  }
});
