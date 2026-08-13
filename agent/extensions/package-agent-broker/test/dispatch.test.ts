/**
 * dispatch.test.ts — the #930 dispatch transaction (ADR-0129 §6, ADR-0131).
 *
 * Driven with a FAKE runner: the transaction's ordering, refusal legs, audit
 * emission, and ticket discipline are pure-orchestration properties and must
 * be provable without creating processes. The real spawn boundary is covered
 * by `dispatch-runner.test.ts` and the live child-sandbox suite.
 *
 * The load-bearing case (the #929 hand-off's required interaction test): an
 * ADMITTED request whose grant is revoked mid-flight must be refused by the
 * in-lock revalidation — admission never substitutes for authority — and its
 * ticket must still be released.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { AuditEvent } from "../../shared/package-agent-review-contract.ts";
import { DispatchAdmission } from "../lib/dispatch-admission.ts";
import {
  attestArgv,
  DISPATCH_LIMITS,
  dispatchPackageAgent,
  resolveArgv,
  type DispatchDeps,
} from "../lib/dispatch.ts";
import type { CanaryResult, SpawnedChild } from "../lib/dispatch-runner.ts";
import { discoverProposals, type DiscoveryResult } from "../lib/discovery.ts";
import { GrantRegistry, type MonotonicClock } from "../lib/grant-registry.ts";
import { computeGrantDigest, reconstructEffectiveDefinition } from "../lib/reconstruct.ts";

const HOST = "github.com";
const REPO = "psmfd/pi-work-item-client";
const REF = "v1.0.0";
const AGENT = "work-item-planner";
const QID = `git:${HOST}/${REPO}@${REF}#${AGENT}`;
const COMMIT = "9".repeat(40);

function installPackage(agentDir: string): string {
  const root = path.join(agentDir, "git", HOST, ...REPO.split("/"));
  const agents = path.join(root, "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(
    path.join(agents, `${AGENT}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name: AGENT,
      description: "Plans work items.",
      prompt: "You are a proposal-only planner.",
      tools: ["read"],
    }),
  );
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), `${COMMIT}\n`);
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ packages: [`git:${HOST}/${REPO}@${REF}`] }),
  );
  return root;
}

function fakeRunnerBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pab-dispatch-runner-"));
  const p = path.join(dir, "pi");
  fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
  return p;
}

/** A verified suspend-inclusive test clock (settable). */
function testClock(): MonotonicClock & { advance(ms: number): void } {
  let now = 1_000_000;
  return {
    nowMs: () => now,
    suspendInclusive: true,
    advance(ms: number) {
      now += ms;
    },
  };
}

interface FakeRunnerLog {
  canaryRuns: number;
  spawns: Array<{ argv: readonly string[]; task: string; credentialVar: string | null }>;
  scratches: string[];
  removed: string[];
}

interface FakeRunnerControls {
  canaryResult: CanaryResult;
  /** Called between canary completion and its resolution (revoke window). */
  beforeCanaryResolves: (() => Promise<void>) | null;
  childExitCode: number;
}

function makeFakeRunner(controls: FakeRunnerControls): {
  runner: DispatchDeps["runner"];
  log: FakeRunnerLog;
} {
  const log: FakeRunnerLog = { canaryRuns: 0, spawns: [], scratches: [], removed: [] };
  const runner: DispatchDeps["runner"] = {
    createScratch: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pab-dispatch-scratch-"));
      log.scratches.push(dir);
      return dir;
    },
    removeScratch: (dir: string) => {
      log.removed.push(dir);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },
    runCanaryAsync: async () => {
      log.canaryRuns += 1;
      if (controls.beforeCanaryResolves !== null) await controls.beforeCanaryResolves();
      return controls.canaryResult;
    },
    spawnConfined: (spec, credential, childArgv, task): SpawnedChild => {
      log.spawns.push({
        argv: childArgv,
        task,
        credentialVar: credential === null ? null : credential.envVar,
      });
      void spec;
      return {
        pid: 4242,
        completion: Promise.resolve({
          outcome: "exit",
          exitCode: controls.childExitCode,
          stdout: '{"type":"session","version":3}\n',
        }),
        terminate: () => undefined,
      };
    },
  };
  return { runner, log };
}

interface Rig {
  deps: DispatchDeps;
  registry: GrantRegistry;
  admission: DispatchAdmission;
  clock: ReturnType<typeof testClock>;
  log: FakeRunnerLog;
  controls: FakeRunnerControls;
  agentDir: string;
  packageRoot: string;
  grantDigest: string;
}

/** Build a rig with one INSTALLED grant (the real approval-path primitives). */
async function makeRig(overrides: Partial<Pick<DispatchDeps, "mintCredential">> = {}): Promise<Rig> {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pab-dispatch-agent-"));
  const packageRoot = installPackage(agentDir);
  const clock = testClock();
  const registry = new GrantRegistry({ clock });
  const admission = new DispatchAdmission();

  const runDiscovery = (): DiscoveryResult =>
    discoverProposals({
      agentDir,
      settingsPackages: [`git:${HOST}/${REPO}@${REF}`],
    });

  const runnerBinary = fakeRunnerBinary();
  const proposal = runDiscovery().proposals.find((p) => p.qualifiedId === QID);
  assert.ok(proposal, "fixture package must be discoverable");
  const binding = registry.mintApprovalBinding(QID);
  const definition = reconstructEffectiveDefinition(proposal, null, binding, {
    runnerPath: runnerBinary,
  });
  const grantDigest = computeGrantDigest(definition);
  await registry.withApprovalLock(QID, () => {
    registry.install(definition, grantDigest);
  });

  const controls: FakeRunnerControls = {
    canaryResult: { ok: true, anomalies: [] },
    beforeCanaryResolves: null,
    childExitCode: 0,
  };
  const { runner, log } = makeFakeRunner(controls);

  const deps: DispatchDeps = {
    registry,
    admission,
    runDiscovery,
    agentDir,
    runner,
    mintCredential: overrides.mintCredential ?? (() => ({ envVar: "ANTHROPIC_AUTH_TOKEN", value: "test-bearer" })),
    providerHostPort: null,
    monotonicNowMs: () => clock.nowMs(),
    platform: "darwin",
    toolBinDir: null,
  };
  return { deps, registry, admission, clock, log, controls, agentDir, packageRoot, grantDigest };
}

function reasons(audits: AuditEvent[]): string[] {
  return audits.map((a) => `${a.kind}:${a.reason}`);
}

// ---------------------------------------------------------------------------
// Happy path.
// ---------------------------------------------------------------------------

test("a dispatch revalidates, spawns from the grant's argv, and audits the lifecycle", async () => {
  const rig = await makeRig();
  const result = await dispatchPackageAgent({ qualifiedId: QID, task: "plan the work" }, rig.deps);

  assert.equal(result.outcome.dispatched, true);
  if (!result.outcome.dispatched) return;
  assert.equal(result.outcome.grantDigest, rig.grantDigest);
  assert.equal(result.outcome.completion.outcome, "exit");
  assert.equal(rig.log.canaryRuns, 1, "the canary runs before every spawn");
  assert.equal(rig.log.spawns.length, 1);

  const spawn = rig.log.spawns[0];
  assert.equal(spawn.task, "plan the work", "the task rides stdin, not argv");
  assert.ok(!spawn.argv.includes("plan the work"), "task text must never enter argv");
  assert.ok(spawn.argv.includes("--no-extensions"), "isolation flags are attested in argv");
  const toolsIdx = spawn.argv.indexOf("--tools");
  assert.equal(spawn.argv[toolsIdx + 1], "read", "the granted allowlist rides --tools");
  assert.equal(spawn.credentialVar, "ANTHROPIC_AUTH_TOKEN");

  assert.deepEqual(reasons(result.audits), ["dispatch-spawned:ok", "dispatch-completed:child-exit"]);
  assert.equal(rig.admission.activeCount, 0, "the ticket is released after completion");
  // Both scratches (canary + real) are torn down.
  assert.deepEqual([...rig.log.removed].sort(), [...rig.log.scratches].sort());
});

// ---------------------------------------------------------------------------
// Refusal legs — every one fails closed, audits, and releases the ticket.
// ---------------------------------------------------------------------------

test("an unknown identity fails closed with no canary and no prompt", async () => {
  const rig = await makeRig();
  const other = `git:${HOST}/${REPO}@v2.0.0#${AGENT}`;
  const result = await dispatchPackageAgent({ qualifiedId: other, task: "x" }, rig.deps);
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  assert.equal(result.outcome.reason, "grant-missing");
  assert.equal(rig.log.canaryRuns, 0, "no grant, no canary work");
  assert.equal(rig.log.spawns.length, 0);
  assert.deepEqual(reasons(result.audits), ["dispatch-refused:grant-missing"]);
  assert.equal(rig.admission.activeCount, 0);
});

test("a canary anomaly refuses dispatch with no unconfined fallback", async () => {
  const rig = await makeRig();
  rig.controls.canaryResult = { ok: false, anomalies: ["must-fail-read-0-succeeded"] };
  const result = await dispatchPackageAgent({ qualifiedId: QID, task: "x" }, rig.deps);
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  assert.equal(result.outcome.reason, "canary-anomaly");
  assert.equal(rig.log.spawns.length, 0, "an unverified sandbox never spawns");
  assert.deepEqual(reasons(result.audits), ["dispatch-refused:canary-anomaly"]);
  assert.equal(rig.admission.activeCount, 0);
});

test("an unverified expiry clock refuses dispatch (fail closed on the flag)", async () => {
  // A registry whose clock was NOT verified suspend-inclusive mints grants
  // carrying clockSuspendInclusive: false — dispatch must refuse them.
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pab-dispatch-agent-"));
  installPackage(agentDir);
  const registry = new GrantRegistry(); // default hrtimeClock: NOT suspend-inclusive
  const admission = new DispatchAdmission();
  const runDiscovery = (): DiscoveryResult =>
    discoverProposals({ agentDir, settingsPackages: [`git:${HOST}/${REPO}@${REF}`] });
  const proposal = runDiscovery().proposals.find((p) => p.qualifiedId === QID);
  assert.ok(proposal);
  const binding = registry.mintApprovalBinding(QID);
  const definition = reconstructEffectiveDefinition(proposal, null, binding, {
    runnerPath: fakeRunnerBinary(),
  });
  const digest = computeGrantDigest(definition);
  await registry.withApprovalLock(QID, () => {
    registry.install(definition, digest);
  });
  const controls: FakeRunnerControls = { canaryResult: { ok: true, anomalies: [] }, beforeCanaryResolves: null, childExitCode: 0 };
  const { runner, log } = makeFakeRunner(controls);
  const result = await dispatchPackageAgent(
    { qualifiedId: QID, task: "x" },
    {
      registry,
      admission,
      runDiscovery,
      agentDir,
      runner,
      mintCredential: () => ({ envVar: "ANTHROPIC_AUTH_TOKEN", value: "t" }),
      providerHostPort: null,
      monotonicNowMs: () => 0,
      platform: "darwin",
      toolBinDir: null,
    },
  );
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  assert.equal(result.outcome.reason, "clock-unverified");
  assert.equal(log.spawns.length, 0);
  assert.deepEqual(reasons(result.audits), ["dispatch-refused:clock-unverified"]);
});

test("package bytes changed after approval refuse at the digest match", async () => {
  const rig = await makeRig();
  // A same-user edit lands between approval and dispatch: the full-tree
  // digest (ADR-0131 D1) must catch content the operator never approved.
  fs.writeFileSync(path.join(rig.packageRoot, "planted.md"), "post-approval bytes");
  const result = await dispatchPackageAgent({ qualifiedId: QID, task: "x" }, rig.deps);
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  assert.equal(result.outcome.reason, "digest-mismatch");
  assert.equal(rig.log.spawns.length, 0);
  assert.deepEqual(reasons(result.audits), ["dispatch-refused:digest-mismatch"]);
  assert.equal(rig.admission.activeCount, 0);
});

test("package bytes mutated INSIDE the dispatch window refuse at the in-lock match", async () => {
  const rig = await makeRig();
  // Distinct from "package bytes changed after approval": that edit lands
  // before dispatch begins, so the pre-lock peek can catch it. This one lands
  // AFTER pre-lock discovery and the canary have already read the package, in
  // the window the in-lock revalidation exists to close (ADR-0131 Decision 9).
  //
  // If the transaction ever trusted its pre-lock read, this is the case that
  // would spawn over bytes no one approved — and it would still look green in
  // every other test in this file.
  let planted = false;
  rig.controls.beforeCanaryResolves = async () => {
    planted = true;
    fs.writeFileSync(path.join(rig.packageRoot, "planted-mid-flight.md"), "bytes swapped in-window");
  };

  const result = await dispatchPackageAgent({ qualifiedId: QID, task: "x" }, rig.deps);

  assert.ok(planted, "the mutation must land inside the dispatch window");
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  assert.equal(result.outcome.reason, "digest-mismatch");
  assert.equal(rig.log.spawns.length, 0, "nothing may be spawned");
  assert.deepEqual(reasons(result.audits), ["dispatch-refused:digest-mismatch"]);
  assert.equal(rig.admission.activeCount, 0, "the ticket must still be released");
});

test("an expired grant refuses at dispatch and is retired", async () => {
  const rig = await makeRig();
  rig.clock.advance(5 * 60 * 60 * 1000); // beyond the 4h lifetime
  const result = await dispatchPackageAgent({ qualifiedId: QID, task: "x" }, rig.deps);
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  // The pre-lock peek already retires the expired grant atomically, so the
  // attempt reads as grant-missing; either reason is a fail-closed refusal
  // and the retirement lands in the registry's expiry log for audit.
  assert.ok(["grant-missing", "grant-expired"].includes(result.outcome.reason));
  assert.equal(rig.log.spawns.length, 0);
  assert.equal(rig.registry.drainExpired().length, 1, "the expiry retirement is observable");
});

test("credential minting failure refuses dispatch (bearer-only, no fallback)", async () => {
  const rig = await makeRig({ mintCredential: () => null });
  const result = await dispatchPackageAgent({ qualifiedId: QID, task: "x" }, rig.deps);
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  assert.equal(result.outcome.reason, "credential-unavailable");
  assert.equal(rig.log.spawns.length, 0);
  assert.equal(rig.admission.activeCount, 0);
});

test("malformed requests are refused before any admission or grant work", async () => {
  const rig = await makeRig();
  for (const [request, label] of [
    [{ qualifiedId: "not-a-qid", task: "x" }, "bad id"],
    [{ qualifiedId: QID, task: "" }, "empty task"],
    [{ qualifiedId: QID, task: "y".repeat(DISPATCH_LIMITS.maxTaskBytes + 1) }, "oversized task"],
  ] as const) {
    const result = await dispatchPackageAgent(request, rig.deps);
    assert.equal(result.outcome.dispatched, false, label);
    if (result.outcome.dispatched) continue;
    assert.equal(result.outcome.reason, "malformed-input", label);
  }
  assert.equal(rig.log.canaryRuns, 0);
  assert.equal(rig.admission.activeCount, 0);
});

// ---------------------------------------------------------------------------
// The required interaction test (#929 hand-off): admitted ticket vs revoke.
// ---------------------------------------------------------------------------

test("a promoted admission ticket cannot spawn after a concurrent revoke", async () => {
  const rig = await makeRig();
  // The request is ADMITTED and its canary is in flight when the operator's
  // revocation completes (preemptive priority). The subsequent in-lock
  // revalidation must find no grant and fail closed — admission is resource
  // containment, never authority.
  rig.controls.beforeCanaryResolves = async () => {
    const removed = await rig.registry.revoke(QID);
    assert.ok(removed !== null, "the revoke must find the grant");
  };
  const result = await dispatchPackageAgent({ qualifiedId: QID, task: "x" }, rig.deps);
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  assert.equal(result.outcome.reason, "grant-missing");
  assert.equal(rig.log.spawns.length, 0, "no child may be created after the revocation");
  assert.deepEqual(reasons(result.audits), ["dispatch-refused:grant-missing"]);
  assert.equal(rig.admission.activeCount, 0, "the ticket is released even on the refused leg");
});

test("revocation cancels queued dispatch requests with an auditable outcome", async () => {
  const rig = await makeRig();
  // Saturate the concurrency slots so a further admit() queues.
  const tickets = [];
  for (let i = 0; i < 4; i++) {
    const d = await rig.admission.admit(QID);
    assert.ok(d.admitted);
    if (d.admitted) tickets.push(d.ticket);
  }
  const pending = dispatchPackageAgent({ qualifiedId: QID, task: "x" }, rig.deps);
  // Give the queued admit a tick, then revoke: the queued request must be
  // cancelled (never promoted post-revocation).
  await new Promise((r) => setTimeout(r, 10));
  rig.admission.cancelIdentity(QID);
  await rig.registry.revoke(QID);
  const result = await pending;
  for (const t of tickets) t.release();
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  assert.equal(result.outcome.reason, "revoked");
  assert.deepEqual(reasons(result.audits), ["dispatch-request-cancelled:operator-declined"]);
});

// ---------------------------------------------------------------------------
// Bounded lock hold.
// ---------------------------------------------------------------------------

test("an exhausted authority-hold budget refuses with no spawn attempted", async () => {
  const rig = await makeRig();
  // Every monotonic read after the canary advances the clock past the
  // budget, so the in-lock elapsed check trips before process creation.
  let calls = 0;
  rig.deps.monotonicNowMs = () => {
    calls += 1;
    return calls > 2 ? rig.clock.nowMs() + DISPATCH_LIMITS.authorityHoldBudgetMs + 1 : rig.clock.nowMs();
  };
  const result = await dispatchPackageAgent({ qualifiedId: QID, task: "x" }, rig.deps);
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  // Depending on where the budgeted reads land, the refusal is the timeout
  // itself or the expiry read that consumed the same clock — both are
  // fail-closed with zero spawns, which is the property under test.
  assert.equal(rig.log.spawns.length, 0, "no process creation after the budget elapsed");
});

// ---------------------------------------------------------------------------
// Argv resolution and attestation units.
// ---------------------------------------------------------------------------

test("resolveArgv resolves placeholders only from the grant and attests clean", async () => {
  const rig = await makeRig();
  const grant = await rig.registry.get(QID);
  assert.ok(grant);
  const argv = resolveArgv(grant.definition);
  assert.ok(argv.includes("--no-extensions"));
  assert.ok(argv.includes(grant.definition.promptText), "the system prompt resolves from the grant");
  assert.equal(attestArgv(grant.definition, argv), null);

  // Attestation fails closed on a dropped isolation flag, a placeholder, and
  // a tool-list drift.
  assert.notEqual(attestArgv(grant.definition, argv.filter((a) => a !== "--no-extensions")), null);
  assert.notEqual(attestArgv(grant.definition, [...argv, "{{tools}}"]), null);
  const idx = argv.indexOf("--tools");
  const drifted = [...argv];
  drifted[idx + 1] = "read,bash";
  assert.notEqual(attestArgv(grant.definition, drifted), null);
});

// ---------------------------------------------------------------------------
// Regressions pinned from the 2026-07-31 replicated security review.
// ---------------------------------------------------------------------------

test("attestation is byte-identical to the grant's template (and tolerates literal {{)", async () => {
  const rig = await makeRig();
  const grant = await rig.registry.get(QID);
  assert.ok(grant);
  // A legitimate operator-approved prompt containing Handlebars-like text
  // must NOT be misread as an unresolved placeholder (R1 Info): attestation
  // compares against a fresh resolution instead of substring-sniffing.
  const withBraces = {
    ...grant.definition,
    promptText: "Use {{name}} in your template examples.",
  } as typeof grant.definition;
  const argv = resolveArgv(withBraces);
  assert.equal(attestArgv(withBraces, argv), null);
  // Any drift from the template is still refused, including an appended arg.
  assert.notEqual(attestArgv(withBraces, [...argv, "--extra"]), null);
  assert.notEqual(attestArgv(withBraces, argv.slice(0, -1)), null);
});

test("the authority-hold budget is re-checked during revalidation, not only at spawn", async () => {
  const rig = await makeRig();
  // Trip the budget on the FIRST in-lock check (right after discovery), so
  // the refusal must occur before reconstruction/spawn work continues.
  let reads = 0;
  const base = rig.clock.nowMs();
  rig.deps.monotonicNowMs = () => {
    reads += 1;
    return reads <= 1 ? base : base + DISPATCH_LIMITS.authorityHoldBudgetMs + 1;
  };
  const result = await dispatchPackageAgent({ qualifiedId: QID, task: "x" }, rig.deps);
  assert.equal(result.outcome.dispatched, false);
  if (result.outcome.dispatched) return;
  assert.equal(rig.log.spawns.length, 0, "an elapsed budget never reaches process creation");
});
