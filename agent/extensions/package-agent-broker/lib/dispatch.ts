/**
 * dispatch.ts — the #930 dispatch transaction (ADR-0129 §6, ADR-0130,
 * ADR-0131). PURE ORCHESTRATION: no process creation (that is
 * `dispatch-runner.ts`, the sole spawn boundary) and no store I/O (audit
 * events are COLLECTED here and flushed by the caller strictly outside the
 * authority lock, per the ADR-0129 lock-ordering rule).
 *
 * One dispatch attempt, in order:
 *
 *   1. request validation           — {qualifiedId, task} and nothing else;
 *   2. admission                    — resource containment (#929); the ticket
 *                                     is released on EVERY exit path and a
 *                                     promoted start is never refunded;
 *   3. canary                       — the full ADR-0130 probe plan through
 *                                     the identical wrapper, OUTSIDE the
 *                                     authority lock (ADR-0130 mandates the
 *                                     lock-external ordering: a slow canary
 *                                     must never starve a revocation), on a
 *                                     THROWAWAY scratch;
 *   4. authority lock (normal prio) — re-fetch the grant (expiry retired
 *                                     atomically), refuse an unverified
 *                                     expiry clock, re-run discovery and
 *                                     full reconstruction with the binding
 *                                     taken from the in-memory grant, require
 *                                     an exact digest match, rebuild every
 *                                     spawn artifact from the REVALIDATED
 *                                     definition (never from pre-lock state),
 *                                     and spawn synchronously — all within a
 *                                     bounded hold (5s, ADR-0129 rule 2);
 *   5. after release                — await the child under the execution
 *                                     timeout and output caps, tear down
 *                                     scratch, flush audits, release the
 *                                     ticket.
 *
 * A request naming an unknown, expired, or revoked grant fails closed with
 * no fallback and no prompt (ADR-0129: dispatch spam must never become
 * approval fatigue). Nothing the child emits is an authorization or
 * attestation input.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  QUALIFIED_ID_RE,
  type AuditEvent,
} from "../../shared/package-agent-review-contract.ts";
import type { ActiveGrant, EffectiveDefinition } from "../../shared/package-agent-grant-contract.ts";
import { makeAuditEvent } from "./audit.ts";
import type { SandboxSpec } from "./child-sandbox.ts";
import type { DispatchAdmission } from "./dispatch-admission.ts";
import type { CanaryResult, ChildCompletion, SpawnedChild, SpawnLimits } from "./dispatch-runner.ts";
import type { DiscoveryResult } from "./discovery.ts";
import type { GrantRegistry } from "./grant-registry.ts";
import {
  ARGV_PLACEHOLDER_MODEL,
  ARGV_PLACEHOLDER_PROMPT,
  ARGV_PLACEHOLDER_TOOLS,
  computeGrantDigest,
  reconstructEffectiveDefinition,
} from "./reconstruct.ts";

/** Operator/implementation parameters (ADR-0131 Decision 7). */
export const DISPATCH_LIMITS = {
  /** Max task bytes accepted from either ingress. */
  maxTaskBytes: 64 * 1024,
  /** ADR-0129 rule 2: bounded authority-lock hold, revalidation included. */
  authorityHoldBudgetMs: 5_000,
  /** Wall-clock bound on the running child after spawn. */
  executionTimeoutMs: 10 * 60 * 1000,
  /** Child stdout caps — exceeding either terminates the child. */
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStdoutLineBytes: 1024 * 1024,
} as const;

export type DispatchRefusalReason =
  | "malformed-input"
  | "queue-full"
  | "identity-queue-full"
  | "queue-expired"
  | "revoked"
  | "runtime-shutdown"
  | "grant-missing"
  | "grant-expired"
  | "clock-unverified"
  | "credential-unavailable"
  | "digest-mismatch"
  | "canary-anomaly"
  | "attestation-mismatch"
  | "spawn-timeout"
  | "spawn-failed"
  | "state-integrity-refused";

export interface DispatchRefused {
  dispatched: false;
  reason: DispatchRefusalReason;
  /** Bounded, operator-safe message (no package bytes, no secrets). */
  message: string;
}

export interface DispatchCompleted {
  dispatched: true;
  pid: number;
  completion: ChildCompletion;
  grantDigest: string;
}

export type DispatchOutcome = DispatchRefused | DispatchCompleted;

/**
 * Everything the transaction needs, injected. `runner` is the spawn boundary;
 * tests drive the transaction with a fake. `monotonicNowMs` feeds the bounded
 * lock hold.
 */
export interface DispatchDeps {
  registry: GrantRegistry;
  admission: DispatchAdmission;
  runDiscovery: () => DiscoveryResult;
  agentDir: string;
  runner: {
    createScratch(): string;
    removeScratch(scratchDir: string): boolean;
    runCanaryAsync(
      spec: SandboxSpec,
      probes: { inScopeFile: string; outOfScopeFile: string; providerHostPort?: string | null },
    ): Promise<CanaryResult>;
    spawnConfined(
      spec: SandboxSpec,
      credential: { envVar: string; value: string } | null,
      childArgv: readonly string[],
      task: string,
      limits: SpawnLimits,
    ): SpawnedChild;
  };
  /** Mint the child credential (short-lived bearer). Null = dispatch without one. */
  mintCredential: () => { envVar: string; value: string } | null;
  /** Provider host:port for the TLS canary leg, or null to skip it. */
  providerHostPort: string | null;
  monotonicNowMs: () => number;
  platform: "linux" | "darwin";
  /** Pre-provisioned rg/fd dir, or null. */
  toolBinDir: string | null;
  caBundlePath?: string;
}

/**
 * Resolve the grant's argv template. Placeholders resolve ONLY from the
 * revalidated definition — no caller-supplied material reaches the argv
 * (ADR-0131 Decision 7; the task rides stdin).
 */
export function resolveArgv(definition: EffectiveDefinition): string[] {
  const argv: string[] = [];
  for (const entry of definition.argvPolicy.template) {
    if (entry === ARGV_PLACEHOLDER_TOOLS) {
      argv.push(definition.effectiveTools.map((t) => t.name).join(","));
    } else if (entry === ARGV_PLACEHOLDER_PROMPT) {
      argv.push(definition.promptText);
    } else if (entry === ARGV_PLACEHOLDER_MODEL) {
      if (definition.modelPolicy === null) {
        throw new Error("argv template names a model placeholder but the grant has no model policy");
      }
      argv.push(definition.modelPolicy);
    } else {
      argv.push(entry);
    }
  }
  return argv;
}

/**
 * Broker-side attestation (ADR-0131 Decision 3): assert, fail-closed, that
 * the argv about to be spawned carries every declared isolation flag, the
 * exact granted tool list, and no unresolved placeholder. This is the
 * verifiable half of "startup attestation"; the OS sandbox is the
 * compensating control for what pi cannot yet report (#944).
 */
export function attestArgv(definition: EffectiveDefinition, argv: readonly string[]): string | null {
  // STRUCTURAL attestation: the argv must be byte-identical to a fresh
  // resolution of the grant's own template — stronger than any substring
  // heuristic, and immune to a legitimate prompt containing literal "{{"
  // (2026-07-31 security review). The named checks below are belt on top,
  // so a future resolveArgv edit cannot silently weaken what this proves.
  const expectedArgv = resolveArgv(definition);
  if (argv.length !== expectedArgv.length || argv.some((entry, i) => entry !== expectedArgv[i])) {
    return "argv is not byte-identical to the grant's resolved template";
  }
  for (const flag of definition.argvPolicy.isolation) {
    if (!argv.includes(flag)) return `isolation flag missing from argv: ${flag}`;
  }
  const toolsIdx = argv.indexOf("--tools");
  if (toolsIdx === -1 || toolsIdx + 1 >= argv.length) return "argv carries no --tools allowlist";
  const expected = definition.effectiveTools.map((t) => t.name).join(",");
  if (argv[toolsIdx + 1] !== expected) return "argv tool list does not match the grant";
  return null;
}

function buildSpec(
  deps: DispatchDeps,
  definition: EffectiveDefinition,
  scratchDir: string,
  installRoot: string,
): SandboxSpec {
  // Canonicalize through realpath: Seatbelt matches canonical vnode paths
  // (child-sandbox.ts), and validation must run on the same form the kernel
  // enforces. Single canonicalization point for every spawn artifact.
  return {
    platform: deps.platform,
    agentDir: fs.realpathSync(deps.agentDir),
    packageRoot: fs.realpathSync(installRoot),
    scratchDir: fs.realpathSync(scratchDir),
    childBinary: definition.runner.path,
    toolBinDir: deps.toolBinDir === null ? null : fs.realpathSync(deps.toolBinDir),
    ...(deps.caBundlePath !== undefined ? { caBundlePath: deps.caBundlePath } : {}),
  };
}

export interface DispatchResult {
  outcome: DispatchOutcome;
  /** Closed-schema audit events, in order. Flushed by the caller OUTSIDE any lock. */
  audits: AuditEvent[];
}

/** Map an admission refusal to its audit kind + reason. */
function admissionAudit(qualifiedId: string, reason: string, atMs: number): AuditEvent {
  const cancelled = reason === "revoked" || reason === "closed";
  return makeAuditEvent(cancelled ? "dispatch-request-cancelled" : "dispatch-admission-refused", atMs, {
    qualifiedId,
    outcome: "refused",
    reason:
      reason === "queue-full"
        ? "queue-full"
        : reason === "identity-queue-full"
          ? "identity-queue-full"
          : reason === "queue-expired"
            ? "queue-expired"
            : reason === "revoked"
              ? "operator-declined"
              : "runtime-shutdown",
  });
}

/**
 * Execute one dispatch attempt. See the module header for the transaction
 * shape. The returned audits MUST be flushed by the caller after this
 * function returns — by then every authority lock has been released.
 */
export async function dispatchPackageAgent(
  request: { qualifiedId: string; task: string },
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const audits: AuditEvent[] = [];
  const refuse = (
    reason: DispatchRefusalReason,
    message: string,
    opts: { audit?: boolean; qualifiedId?: string | null; grantDigest?: string | null } = {},
  ): DispatchResult => {
    if (opts.audit !== false) {
      audits.push(
        makeAuditEvent("dispatch-refused", Date.now(), {
          qualifiedId: opts.qualifiedId === undefined ? request.qualifiedId : opts.qualifiedId,
          grantDigest: opts.grantDigest ?? null,
          outcome: "refused",
          reason:
            reason === "revoked"
              ? "operator-declined"
              : reason === "spawn-timeout"
                ? "spawn-timeout"
                : reason,
        }),
      );
    }
    return { outcome: { dispatched: false, reason, message }, audits };
  };

  // ---- 1. Request validation (nothing authoritative may arrive here). ----
  if (!QUALIFIED_ID_RE.test(request.qualifiedId)) {
    return refuse("malformed-input", "invalid qualified id.", { qualifiedId: null });
  }
  if (typeof request.task !== "string" || request.task.length === 0) {
    return refuse("malformed-input", "a non-empty task is required.");
  }
  if (Buffer.byteLength(request.task, "utf8") > DISPATCH_LIMITS.maxTaskBytes) {
    return refuse("malformed-input", "task exceeds the size bound.");
  }
  const qualifiedId = request.qualifiedId;

  // ---- 2. Admission (resource containment; never authorization). ----
  const decision = await deps.admission.admit(qualifiedId);
  if (!decision.admitted) {
    audits.push(admissionAudit(qualifiedId, decision.reason, Date.now()));
    const reason: DispatchRefusalReason =
      decision.reason === "closed" ? "runtime-shutdown" : decision.reason;
    return {
      outcome: { dispatched: false, reason, message: `admission refused (${decision.reason}).` },
      audits,
    };
  }

  const scratches: string[] = [];
  try {
    // ---- Cheap existence probe before canary work. The authoritative read
    // happens under the lock below; this only avoids burning a canary run on
    // an identity that plainly has no grant. ----
    const peek = await deps.registry.get(qualifiedId);
    if (peek === null) {
      return refuse("grant-missing", "no active grant for that identity in this runtime.");
    }

    // ---- 3. Canary through the identical wrapper, OUTSIDE the lock. ----
    const discovery = deps.runDiscovery();
    const proposal = discovery.proposals.find((p) => p.qualifiedId === qualifiedId);
    if (!proposal) {
      return refuse("digest-mismatch", "the package is no longer discoverable.");
    }
    const canaryScratch = deps.runner.createScratch();
    scratches.push(canaryScratch);
    // The out-of-scope canary file is broker-created OUTSIDE every bound
    // tree (a sibling of the scratch parent), so an unconfined control run
    // could read it and only the sandbox explains a failure.
    const outOfScopeFile = path.join(path.dirname(canaryScratch), `.canary-${path.basename(canaryScratch)}`);
    fs.writeFileSync(outOfScopeFile, "canary", { mode: 0o600 });
    let canary: CanaryResult;
    try {
      const canarySpec = buildSpec(deps, peek.definition, canaryScratch, proposal.installRoot);
      canary = await deps.runner.runCanaryAsync(canarySpec, {
        inScopeFile: fs.realpathSync(path.join(proposal.installRoot, proposal.descriptorEvidence.relPath)),
        outOfScopeFile,
        providerHostPort: deps.providerHostPort,
      });
    } finally {
      try {
        fs.rmSync(outOfScopeFile, { force: true });
      } catch {
        // Best effort; the file carries no secret.
      }
    }
    if (!canary.ok) {
      return refuse(
        "canary-anomaly",
        `confinement could not be verified (${canary.anomalies.join(", ")}); dispatch of file-tool grants is refused with no unconfined fallback.`,
      );
    }

    // ---- 4. The bounded, in-lock revalidate-and-spawn transaction. ----
    const realScratch = deps.runner.createScratch();
    scratches.push(realScratch);
    // ADR-0131 Decision 5: bearer-only, no API-key fallback branch. A child
    // without a credential cannot reach its provider — refuse rather than
    // spawn something broken.
    const credential = deps.mintCredential();
    if (credential === null) {
      return refuse("credential-unavailable", "the short-lived bearer token could not be minted.");
    }

    interface LockOutcome {
      refusal: { reason: DispatchRefusalReason; message: string } | null;
      child: SpawnedChild | null;
      digest: string | null;
    }
    const lockOutcome: LockOutcome = { refusal: null, child: null, digest: null };

    await deps.registry.withAuthorityLock(qualifiedId, () => {
      const started = deps.monotonicNowMs();
      const overBudget = (): boolean =>
        deps.monotonicNowMs() - started > DISPATCH_LIMITS.authorityHoldBudgetMs;

      // Authoritative grant read. snapshotUnlocked is safe here (we hold the
      // lock); registry.get would deadlock.
      const grant: ActiveGrant | undefined = deps.registry
        .snapshotUnlocked()
        .find((g) => g.qualifiedId === qualifiedId);
      if (grant === undefined) {
        lockOutcome.refusal = { reason: "grant-missing", message: "no active grant for that identity in this runtime." };
        return;
      }
      if (deps.monotonicNowMs() >= grant.expiresAtMonotonicMs) {
        lockOutcome.refusal = { reason: "grant-expired", message: "the grant's absolute lifetime has elapsed; re-approve to dispatch." };
        return;
      }
      // #929 hand-off: an unverified suspend-inclusive clock cannot enforce
      // the lifetime bound. Fail closed on the flag.
      if (grant.definition.clockSuspendInclusive !== true) {
        lockOutcome.refusal = {
          reason: "clock-unverified",
          message: "the grant's expiry clock was never verified suspend-inclusive; dispatch refuses it.",
        };
        return;
      }

      // Full-payload reconstruction from CURRENT state, binding from the
      // in-memory grant (ADR-0129: the dispatch trust set). The hold budget
      // is re-checked around each synchronous stage below: the checks are
      // cooperative (a revocation still waits out the current stage — the
      // walk itself is bounded by maxAssetFiles/maxAssetTreeBytes), but a
      // slow stage must not let the NEXT stage start past the bound
      // (2026-07-31 security review).
      const recheck = deps.runDiscovery();
      if (overBudget()) {
        lockOutcome.refusal = { reason: "spawn-timeout", message: "the bounded authority-lock hold elapsed during revalidation." };
        return;
      }
      const fresh = recheck.proposals.find((p) => p.qualifiedId === qualifiedId);
      if (!fresh) {
        lockOutcome.refusal = { reason: "digest-mismatch", message: "the package is no longer discoverable." };
        return;
      }
      let freshDefinition: EffectiveDefinition;
      try {
        freshDefinition = reconstructEffectiveDefinition(
          fresh,
          grant.definition.alias,
          {
            approval: { ...grant.definition.approval },
            nonce: grant.definition.nonce,
            expiresAtMs: grant.definition.expiresAtMs,
            expiresAtMonotonicMs: grant.definition.expiresAtMonotonicMs,
            clockSuspendInclusive: grant.definition.clockSuspendInclusive,
          },
          // The runner is re-resolved and re-digested at the APPROVED path —
          // path identity is grant content; byte identity is re-verified here
          // (a swapped binary fails the digest match). The spawn then uses
          // exactly the re-verified path (buildSpec reads it from the fresh
          // definition), so what is digested is what executes.
          { runnerPath: grant.definition.runner.path },
        );
      } catch (err) {
        lockOutcome.refusal = {
          reason: "state-integrity-refused",
          message: err instanceof Error ? "reconstruction refused at dispatch time." : "reconstruction refused.",
        };
        return;
      }
      if (overBudget()) {
        lockOutcome.refusal = { reason: "spawn-timeout", message: "the bounded authority-lock hold elapsed during revalidation." };
        return;
      }
      if (computeGrantDigest(freshDefinition) !== grant.digest) {
        lockOutcome.refusal = {
          reason: "digest-mismatch",
          message: "the package's current bytes do not match the approved grant digest.",
        };
        return;
      }
      lockOutcome.digest = grant.digest;

      // Every spawn artifact is rebuilt from the REVALIDATED definition —
      // reusing any pre-lock object would smuggle stale state past the match.
      let spec: SandboxSpec;
      let argv: string[];
      try {
        spec = buildSpec(deps, freshDefinition, realScratch, fresh.installRoot);
        argv = resolveArgv(freshDefinition);
      } catch {
        lockOutcome.refusal = { reason: "state-integrity-refused", message: "spawn artifacts could not be built." };
        return;
      }
      const attestation = attestArgv(freshDefinition, argv);
      if (attestation !== null) {
        lockOutcome.refusal = { reason: "attestation-mismatch", message: `argv attestation failed: ${attestation}.` };
        return;
      }
      if (overBudget()) {
        // Budget exhausted BEFORE process creation: refuse with no spawn
        // attempted. With a synchronous spawn there is no ambiguous
        // "may already have succeeded" state (ADR-0131 Decision 9).
        lockOutcome.refusal = { reason: "spawn-timeout", message: "the bounded authority-lock hold elapsed before spawn." };
        return;
      }
      try {
        lockOutcome.child = deps.runner.spawnConfined(spec, credential, argv, request.task, {
          executionTimeoutMs: DISPATCH_LIMITS.executionTimeoutMs,
          maxStdoutBytes: DISPATCH_LIMITS.maxStdoutBytes,
          maxStdoutLineBytes: DISPATCH_LIMITS.maxStdoutLineBytes,
        });
      } catch {
        lockOutcome.refusal = { reason: "spawn-failed", message: "process creation failed." };
      }
    });

    if (lockOutcome.refusal !== null) {
      return refuse(lockOutcome.refusal.reason, lockOutcome.refusal.message, {
        grantDigest: lockOutcome.digest,
      });
    }
    const child = lockOutcome.child;
    const digest = lockOutcome.digest;
    if (child === null || digest === null) {
      return refuse("state-integrity-refused", "dispatch produced no child.");
    }

    // ---- 5. Post-lock: audit the spawn, await the child. ----
    audits.push(
      makeAuditEvent("dispatch-spawned", Date.now(), {
        qualifiedId,
        grantDigest: digest,
        outcome: "committed",
        reason: "ok",
      }),
    );
    const completion = await child.completion;
    audits.push(
      makeAuditEvent("dispatch-completed", Date.now(), {
        qualifiedId,
        grantDigest: digest,
        outcome: "committed",
        reason:
          completion.outcome === "exit"
            ? "child-exit"
            : completion.outcome === "execution-timeout"
              ? "execution-timeout"
              : completion.outcome === "output-cap-exceeded"
                ? "output-cap-exceeded"
                : "spawn-failed",
      }),
    );
    return {
      outcome: { dispatched: true, pid: child.pid, completion, grantDigest: digest },
      audits,
    };
  } finally {
    for (const scratch of scratches) {
      deps.runner.removeScratch(scratch);
    }
    // However the attempt ended, the concurrency slot is freed and the
    // rate-window start is NOT refunded (#929 seam contract).
    decision.ticket.release();
  }
}
