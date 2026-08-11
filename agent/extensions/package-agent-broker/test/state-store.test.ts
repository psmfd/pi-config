/**
 * state-store.test.ts — atomic persistence, generation CAS, lock behavior,
 * integrity refusal, crash injection, and the non-authorizing state
 * invariant (#916).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  REVIEW_DRAFT_DIGEST_DOMAIN,
  REVIEW_DRAFT_KIND,
  REVIEW_DRAFT_SCHEMA_VERSION,
  UNRESOLVED_PROVENANCE_FIELDS,
  initialBrokerState,
  type ReviewDraft,
} from "../../shared/package-agent-review-contract.ts";
import { makeAuditEvent } from "../lib/audit.ts";
import { StateStore, StateError, pushAudit } from "../lib/state-store.ts";

const QID = "git:github.com/psmfd/pi-work-item-client@v1.0.0#work-item-planner";

function mkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pab-state-"));
  // mkdtemp gives 0700 on macOS/Linux; enforce anyway for the ownership check.
  fs.chmodSync(root, 0o700);
  return root;
}

function store(root: string, extra: ConstructorParameters<typeof StateStore>[0] = {}): StateStore {
  return new StateStore({ rootOverride: root, lockAttempts: 2, lockDelayMs: 10, ...extra });
}

function sampleDraft(): ReviewDraft {
  return {
    kind: REVIEW_DRAFT_KIND,
    schemaVersion: REVIEW_DRAFT_SCHEMA_VERSION,
    activatable: false,
    requiresFreshApproval: true,
    authorizationDigest: null,
    qualifiedId: QID,
    draftRevision: 1,
    proposalDigest: "d".repeat(64),
    snapshot: {
      schemaVersion: REVIEW_DRAFT_SCHEMA_VERSION,
      digestDomain: REVIEW_DRAFT_DIGEST_DOMAIN,
      qualifiedId: QID,
      packageIdentity: {
        source: "git:github.com/psmfd/pi-work-item-client@v1.0.0",
        host: "github.com",
        path: "psmfd/pi-work-item-client",
        ref: "v1.0.0",
        observedCommit: null,
      },
      agentName: "work-item-planner",
      proposedAlias: null,
      descriptorText: "{}",
      descriptorEvidence: { relPath: "agents/work-item-planner.json", byteLength: 2, sha256: "b".repeat(64) },
      wrapperText: null,
      wrapperEvidence: null,
      promptText: "p",
      requestedTools: ["read"],
      environmentPolicy: {},
      modelPolicy: null,
      guardPolicy: null,
      contextPolicy: null,
      unresolvedProvenance: UNRESOLVED_PROVENANCE_FIELDS,
    },
    nonce: "e".repeat(64),
    issuedAtMs: 1000,
    expiresAtMs: 1000 + 30 * 24 * 60 * 60 * 1000,
  };
}

test("fresh root loads the initial state", () => {
  const s = store(mkRoot());
  const state = s.load();
  assert.deepEqual(state, initialBrokerState());
});

test("commit persists atomically and advances the generation", async () => {
  const root = mkRoot();
  const s = store(root);
  const next = await s.commit(0, (current) => {
    current.drafts[QID] = sampleDraft();
    current.draftRevisions[QID] = 1;
    return current;
  });
  assert.equal(next.generation, 1);
  const reloaded = s.load();
  assert.equal(reloaded.generation, 1);
  assert.equal(reloaded.drafts[QID].activatable, false);
  // State file has restrictive permissions.
  const st = fs.statSync(path.join(root, "state.json"));
  assert.equal(st.mode & 0o777, 0o600);
  // No temp files or lock left behind.
  assert.deepEqual(
    fs.readdirSync(root).sort(),
    ["state.json"],
  );
});

test("generation CAS refuses a stale commit", async () => {
  const root = mkRoot();
  const s = store(root);
  await s.commit(0, (c) => c);
  await assert.rejects(
    () => s.commit(0, (c) => c),
    (err: unknown) => err instanceof StateError && err.reason === "generation-conflict",
  );
});

test("a held lock is refused after bounded attempts, never stolen", async () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, "lock"), "12345 2020-01-01T00:00:00Z\n", { mode: 0o600 });
  const s = store(root);
  await assert.rejects(
    () => s.commit(0, (c) => c),
    (err: unknown) => err instanceof StateError && err.reason === "lock-unavailable",
  );
  // The foreign lock file is still there — refusal, not theft.
  assert.ok(fs.existsSync(path.join(root, "lock")));
});

test("stale lock is reported with manual guidance but still refused", async () => {
  const root = mkRoot();
  const lockPath = path.join(root, "lock");
  fs.writeFileSync(lockPath, "12345 old\n", { mode: 0o600 });
  const old = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(lockPath, old / 1000, old / 1000);
  const s = store(root, { lockStaleMs: 1000 });
  await assert.rejects(
    () => s.commit(0, (c) => c),
    (err: unknown) =>
      err instanceof StateError &&
      err.reason === "lock-unavailable" &&
      err.message.includes("stale"),
  );
  assert.ok(fs.existsSync(lockPath));
});

test("symlinked state file is refused", () => {
  const root = mkRoot();
  const target = path.join(root, "elsewhere.json");
  fs.writeFileSync(target, JSON.stringify(initialBrokerState()), { mode: 0o600 });
  fs.symlinkSync(target, path.join(root, "state.json"));
  assert.throws(
    () => store(root).load(),
    (err: unknown) => err instanceof StateError && err.reason === "state-integrity-refused",
  );
});

test("over-broad state file permissions are refused", async () => {
  const root = mkRoot();
  const s = store(root);
  await s.commit(0, (c) => c);
  fs.chmodSync(path.join(root, "state.json"), 0o644);
  assert.throws(
    () => s.load(),
    (err: unknown) => err instanceof StateError && err.reason === "state-integrity-refused",
  );
});

test("over-broad state directory permissions are refused", async () => {
  const root = mkRoot();
  const s = store(root);
  await s.commit(0, (c) => c);
  fs.chmodSync(root, 0o755);
  assert.throws(
    () => s.load(),
    (err: unknown) => err instanceof StateError && err.reason === "state-integrity-refused",
  );
});

test("corrupt state fails closed", async () => {
  const root = mkRoot();
  const s = store(root);
  await s.commit(0, (c) => c);
  fs.writeFileSync(path.join(root, "state.json"), "{not json", { mode: 0o600 });
  assert.throws(
    () => s.load(),
    (err: unknown) => err instanceof StateError && err.reason === "state-integrity-refused",
  );
});

test("a draft violating the non-authorizing contract is refused at load", async () => {
  const root = mkRoot();
  const s = store(root);
  await s.commit(0, (current) => {
    current.drafts[QID] = sampleDraft();
    return current;
  });
  // Same-user tampering: flip activatable to true on disk. The store must
  // refuse the whole image rather than surface an "activatable" draft.
  const p = path.join(root, "state.json");
  const image = JSON.parse(fs.readFileSync(p, "utf8"));
  image.drafts[QID].activatable = true;
  fs.writeFileSync(p, JSON.stringify(image), { mode: 0o600 });
  assert.throws(
    () => s.load(),
    (err: unknown) => err instanceof StateError && err.reason === "state-integrity-refused",
  );
});

test("crash before rename leaves the previous image intact", async () => {
  const root = mkRoot();
  const s = store(root);
  await s.commit(0, (c) => c); // generation 1 on disk

  const crashing = store(root, {
    hooks: {
      beforeRename: () => {
        throw new Error("injected crash before rename");
      },
    },
  });
  await assert.rejects(() =>
    crashing.commit(1, (current) => {
      current.drafts[QID] = sampleDraft();
      return current;
    }),
  );
  // Durable image is still generation 1 with no drafts; no temp debris.
  const reloaded = store(root).load();
  assert.equal(reloaded.generation, 1);
  assert.deepEqual(reloaded.drafts, {});
  assert.ok(!fs.readdirSync(root).some((f) => f.includes("tmp")));
});

test("crash during temp write leaves the previous image intact", async () => {
  const root = mkRoot();
  const s = store(root);
  await s.commit(0, (c) => c);
  const crashing = store(root, {
    hooks: {
      beforeTempWrite: () => {
        throw new Error("injected crash before temp write");
      },
    },
  });
  await assert.rejects(() => crashing.commit(1, (c) => c));
  assert.equal(store(root).load().generation, 1);
});

test("audit events are capped with a drop counter", () => {
  const state = initialBrokerState();
  for (let i = 0; i < 1005; i++) {
    pushAudit(
      state,
      makeAuditEvent("draft-rejected", i + 1, {
        qualifiedId: QID,
        outcome: "refused",
        reason: "operator-declined",
      }),
    );
  }
  assert.equal(state.audit.length, 1000);
  assert.equal(state.auditDropped, 5);
  assert.equal(state.audit[0].atMs, 6); // oldest five dropped
});

test("appendAudit persists without a generation precondition", async () => {
  const root = mkRoot();
  const s = store(root);
  await s.appendAudit(
    makeAuditEvent("review-aborted", 42, {
      outcome: "refused",
      reason: "not-interactive-tui",
    }),
  );
  const state = s.load();
  assert.equal(state.audit.length, 1);
  assert.equal(state.generation, 1);
});

test("rollback to an older image is detectable via the generation", async () => {
  const root = mkRoot();
  const s = store(root);
  await s.commit(0, (c) => c);
  const olderImage = fs.readFileSync(path.join(root, "state.json"));
  await s.commit(1, (current) => {
    current.drafts[QID] = sampleDraft();
    return current;
  });
  // Same-user rollback: restore the older bytes. The next CAS from the
  // newer generation refuses; and because drafts are non-authorizing, the
  // rollback grants nothing either way (ADR-0128).
  fs.writeFileSync(path.join(root, "state.json"), olderImage, { mode: 0o600 });
  await assert.rejects(
    () => s.commit(2, (c) => c),
    (err: unknown) => err instanceof StateError && err.reason === "generation-conflict",
  );
});
