/**
 * package-agent-broker — pi extension (#916/ADR-0128, extended by
 * #928/ADR-0129).
 *
 * Two flows, deliberately separate:
 *
 *   REVIEW (#916) — discovers installed pinned-Git packages' inert agent
 *   descriptors and persists permanently inert review drafts
 *   (`activatable: false`, `authorizationDigest: null`). A draft is evidence
 *   that an operator looked at something. It authorizes nothing, ever.
 *
 *   APPROVE (#928) — reconstructs the COMPLETE effective definition from
 *   current state (resolving all six provenance fields a draft cannot),
 *   takes a fresh direct-TUI approval over it, and installs a RUNTIME-SCOPED
 *   ACTIVE GRANT: an in-memory object that dies with this process. Nothing
 *   on disk grants authority, so there is no persisted artifact to forge,
 *   replay, or roll back. The approve flow reads no draft as evidence — a
 *   draft's only effect is one display line saying a review happened.
 *
 * What this extension can NEVER do (adversarially tested):
 *   - register an agent, prompt, skill, theme, or command, or any tool other
 *     than the single static `package_agent_dispatch` ingress (#930,
 *     ADR-0131 D7) — no package agent ever enters pi's catalogs, and
 *     `discoverAgents()` cannot see one, so the `task` tool cannot reach it;
 *   - dispatch from the approval flow, or arm/schedule/pre-authorize one;
 *   - treat a review draft, a receipt, or any other file as authorization;
 *   - import package modules or touch the network; process creation exists
 *     ONLY behind `lib/dispatch-runner.ts` on the grant-revalidated dispatch
 *     path (the static scan pins exactly that boundary);
 *   - record affirmative review or approval from RPC, extension-injected,
 *     steer, or follow-up input, or outside TUI mode.
 *
 * Review/approve operator ingress is exact raw input via `pi.on("input")` —
 * deliberately NOT `registerCommand` (registered commands can be invoked
 * with untrusted provenance) and NOT a model-callable tool. Matched input
 * always returns `action: "handled"` so it never reaches the model, skill
 * expansion, prompt-template expansion, or another extension. DISPATCH is
 * additionally reachable through the static `package_agent_dispatch` tool:
 * per ADR-0129 dispatch is provenance-unrestricted BY CONSTRUCTION — the
 * request carries {qualifiedId, task} and nothing authoritative, cannot
 * create/widen/revive a grant, and an unknown identity fails closed with no
 * prompt.
 *
 * Every string that originated on disk or in a package (file names, source
 * strings, identities) passes through `visibleEncode` before reaching the
 * terminal — including the `list`/`status` notification paths, not only the
 * snapshot viewer.
 *
 * See README.md for command syntax and the refusal policy table.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  BOUNDS,
  DRAFT_EXPIRY_MS,
  REVIEW_DRAFT_KIND,
  REVIEW_DRAFT_SCHEMA_VERSION,
  type AuditReasonCode,
  type BrokerState,
  type ReviewDraft,
} from "../shared/package-agent-review-contract.ts";
import {
  GRANT_RECEIPT_KIND,
  GRANT_SCHEMA_VERSION,
  type ActiveGrant,
  type GrantReceipt,
} from "../shared/package-agent-grant-contract.ts";
import { makeAuditEvent } from "./lib/audit.ts";
import {
  checkCollisions,
  checkPackageIdentityCollision,
  CollisionError,
  type GrantIdentity,
} from "./lib/collisions.ts";
import { DispatchAdmission } from "./lib/dispatch-admission.ts";
import { dispatchPackageAgent, type DispatchDeps, type DispatchResult } from "./lib/dispatch.ts";
import {
  createScratch,
  mintBearerToken,
  removeScratch,
  runCanaryAsync,
  spawnConfined,
} from "./lib/dispatch-runner.ts";
import { DiscoveryError, discoverProposals, type DiscoveryResult } from "./lib/discovery.ts";
import { GrantError, GrantRegistry } from "./lib/grant-registry.ts";
import {
  recordLifecycleEvidence,
  recordShutdownEvidence,
  type LifecycleObservation,
} from "./lib/lifecycle-evidence.ts";
import { resolveSuspendInclusiveClock } from "./lib/suspend-inclusive-clock.ts";
import { routeInput, type RoutedCommand } from "./lib/input-router.ts";
import { computeGrantDigest, reconstructEffectiveDefinition, ReconstructionError, walkAssetTree } from "./lib/reconstruct.ts";
import {
  buildReviewSnapshot,
  computeProposalDigest,
  snapshotsEqual,
} from "./lib/review-snapshot.ts";
import { StateStore, StateError, pushAudit } from "./lib/state-store.ts";
import { exactMatch, renderGrantPages, renderSnapshotPages, visibleEncode } from "./lib/viewer.ts";

const SETTINGS_MAX_BYTES = 1024 * 1024;

function agentDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/** Read the operator settings `packages` array (bounded, fail-closed-empty). */
function readSettingsPackages(agentDir: string): unknown[] {
  try {
    const p = path.join(agentDir, "settings.json");
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > SETTINGS_MAX_BYTES) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed === null || typeof parsed !== "object") return [];
    const packages = (parsed as { packages?: unknown }).packages;
    return Array.isArray(packages) ? packages : [];
  } catch {
    return [];
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

/**
 * Persist an audit event, surfacing a visible notice when the audit itself
 * could not be written (e.g. the mutation lock was held). The operator-facing
 * refusal always stands regardless; the audit trail must never fail silently,
 * because it is the accountability record for this flow.
 */
async function auditOrWarn(
  ctx: ExtensionContext,
  store: StateStore,
  event: Parameters<StateStore["appendAudit"]>[0],
): Promise<void> {
  try {
    await store.appendAudit(event);
  } catch (err) {
    const why = err instanceof StateError ? err.reason : "unavailable";
    notify(
      ctx,
      `package-agent: WARNING — the action was refused, but the audit record could not be written (${why}). The audit trail is incomplete for this event.`,
      "warning",
    );
  }
}

function existingAliasMap(state: BrokerState): Map<string, string> {
  const map = new Map<string, string>();
  for (const [qid, draft] of Object.entries(state.drafts)) {
    if (draft.snapshot.proposedAlias !== null) map.set(qid, draft.snapshot.proposedAlias);
  }
  return map;
}

function grantStatusLine(grant: ActiveGrant): string {
  const clockNote = grant.definition.clockSuspendInclusive
    ? ""
    : " [expiry clock unverified — dispatch must refuse]";
  return `${visibleEncode(grant.qualifiedId)} — approval #${grant.approval.sequence}, digest ${grant.digest.slice(0, 16)}…, expires ${new Date(grant.expiresAtMs).toISOString()}${clockNote}`;
}

function activeGrantIdentities(grants: readonly ActiveGrant[]): GrantIdentity[] {
  return grants.map((g) => ({
    qualifiedId: g.qualifiedId,
    host: g.definition.packageIdentity.host,
    path: g.definition.packageIdentity.path,
    ref: g.definition.packageIdentity.ref,
    agentName: g.definition.agentName,
  }));
}

function draftStatusLine(draft: ReviewDraft, nowMs: number): string {
  const expired = nowMs >= draft.expiresAtMs ? " [EXPIRED]" : "";
  return `${visibleEncode(draft.qualifiedId)} — draft rev ${draft.draftRevision}, digest ${draft.proposalDigest.slice(0, 16)}…, expires ${new Date(draft.expiresAtMs).toISOString()}${expired} (non-authorizing)`;
}

/** Map a caught error to a safe reason code + audit event kind for the UI/audit. */
function classifyFailure(err: unknown): {
  reason: AuditReasonCode;
  kind: "discovery-refused" | "state-refused";
  label: string;
} {
  if (err instanceof StateError) {
    return { reason: err.reason, kind: "state-refused", label: err.reason };
  }
  if (err instanceof CollisionError) {
    return { reason: "collision-refused", kind: "state-refused", label: "collision-refused" };
  }
  if (err instanceof ReconstructionError) {
    return { reason: err.reason, kind: "state-refused", label: err.reason };
  }
  if (err instanceof GrantError) {
    let reason: AuditReasonCode = "state-integrity-refused";
    if (err.reason === "grant-cap-reached") reason = "grant-cap-reached";
    else if (err.reason === "package-identity-collision") reason = "collision-refused";
    return { reason, kind: "state-refused", label: err.reason };
  }
  if (err instanceof DiscoveryError) {
    // Per-file reasons never reach here (they are continue-eligible skips),
    // so only the two systemic reasons need mapping — and each keeps its own
    // audit code so the two refusals stay distinguishable in the trail.
    const reason: AuditReasonCode =
      err.reason === "total-budget-exceeded" ? "total-budget-exceeded" : "bounds-exceeded";
    return { reason, kind: "discovery-refused", label: err.reason };
  }
  return { reason: "state-integrity-refused", kind: "state-refused", label: "unexpected-error" };
}

/** Provider endpoint for the TLS canary leg (ADR-0130 probe item 4). */
const PROVIDER_HOST_PORT = "api.anthropic.com:443";

function buildDispatchDeps(registry: GrantRegistry, admission: DispatchAdmission): DispatchDeps {
  const agentDir = agentDirOf();
  const platform: "linux" | "darwin" = process.platform === "linux" ? "linux" : "darwin";
  return {
    registry,
    admission,
    runDiscovery: () => discoverProposals({ agentDir, settingsPackages: readSettingsPackages(agentDir) }),
    agentDir,
    // toolBinDir is DELIBERATELY null in this version: no rg/fd directory is
    // provisioned into the sandbox yet, so a grant using grep/find gets a
    // clean in-child tool error (PI_OFFLINE=1 forbids downloads; PATH names
    // nothing). Provisioning the pinned binaries is tracked follow-up work —
    // wiring a host path here without a review would widen the exec surface.
    runner: { createScratch, removeScratch, runCanaryAsync, spawnConfined },
    // Bearer-only (ADR-0131 D5): mints via the broker's own runner binary;
    // a minting failure refuses the dispatch — no API-key fallback branch.
    mintCredential: () => mintBearerToken(process.execPath),
    providerHostPort: PROVIDER_HOST_PORT,
    monotonicNowMs: () => Number(process.hrtime.bigint() / 1_000_000n),
    platform,
    toolBinDir: null,
  };
}

/**
 * One dispatch attempt from either ingress (TUI subcommand or the static
 * model-callable tool). Flushes the transaction's audit events strictly
 * after it returns — every authority lock has been released by then — and
 * returns a bounded, operator-safe summary line. Child stdout is UNTRUSTED
 * and is never returned raw to the TUI path (the tool path returns it to
 * the model as tool output, the normal untrusted channel).
 */
async function performDispatch(
  qualifiedId: string,
  task: string,
  ctx: ExtensionContext | null,
  store: StateStore,
  registry: GrantRegistry,
  admission: DispatchAdmission,
): Promise<{ summary: string; ok: boolean; childStdout: string | null }> {
  const deps = buildDispatchDeps(registry, admission);
  const result: DispatchResult = await dispatchPackageAgent({ qualifiedId, task }, deps);
  // The audit trail must never fail silently — on EITHER ingress. The TUI
  // path warns via notify; the tool path has no ctx, so the failure count is
  // folded into the summary the caller returns (2026-07-31 security review).
  let auditFailures = 0;
  for (const event of result.audits) {
    try {
      await store.appendAudit(event);
    } catch {
      auditFailures += 1;
      if (ctx !== null) {
        notify(ctx, "package-agent: WARNING — a dispatch audit record could not be written. The audit trail is incomplete for this event.", "warning");
      }
    }
  }
  const auditNote =
    auditFailures > 0
      ? ` WARNING: ${auditFailures} dispatch audit record(s) could not be written; the audit trail is incomplete.`
      : "";
  if (!result.outcome.dispatched) {
    return {
      summary: `dispatch refused (${result.outcome.reason}): ${result.outcome.message}${auditNote}`,
      ok: false,
      childStdout: null,
    };
  }
  const completion = result.outcome.completion;
  const summary = `dispatch completed (${completion.outcome}${completion.exitCode !== null ? `, exit ${completion.exitCode}` : ""}), pid ${result.outcome.pid}, grant ${result.outcome.grantDigest.slice(0, 16)}…${auditNote}`;
  return { summary, ok: completion.outcome === "exit" && completion.exitCode === 0, childStdout: completion.stdout };
}

export default function (pi: ExtensionAPI) {
  const store = new StateStore();
  // Authority lives here and dies with this runtime. `/reload` re-instantiates
  // the extension, which constructs a fresh registry — clearing every grant
  // and requiring re-approval, exactly as ADR-0129 requires.
  const registry = new GrantRegistry({ clock: resolveSuspendInclusiveClock() });
  // The dispatch-admission seam (#929). Resource containment only — nothing
  // can request admission until #930 lands the dispatch ingress. Revocation
  // and re-approval never touch it.
  const admission = new DispatchAdmission();

  // Invalidate synchronously before any shutdown bookkeeping can await. Pi
  // may continue an old handler after reload, so captured closures must fail.
  // The returned promise is the best-effort shutdown audit; pi ignores it,
  // and authority is already gone before it starts.
  // The single static model-callable ingress (#930, ADR-0131 D7). Registered
  // unconditionally at load — its existence never depends on approvals, it
  // never represents a package agent, and it can only ask to use a grant
  // that already exists in this runtime's memory (ADR-0129: fail closed, no
  // prompt, nothing authoritative in the schema).
  pi.registerTool({
    name: "package_agent_dispatch",
    label: "Package agent dispatch",
    description: [
      "Dispatch an operator-approved package agent by qualified identity.",
      "Requires an ACTIVE in-memory grant created by /package-agent approve in this pi runtime;",
      "unknown, expired, or revoked identities fail closed with no prompt.",
      "The child runs OS-sandboxed (package root read-only + scratch) with a finite tool allowlist.",
    ].join(" "),
    parameters: Type.Object(
      {
        qualifiedId: Type.String({
          description: "Qualified package-agent identity, e.g. git:github.com/org/repo@v1.0.0#agent-name",
        }),
        task: Type.String({ description: "Task text for the agent (delivered on stdin; bounded)" }),
      },
      // Closed schema: ADR-0129 forbids the dispatch request carrying ANY
      // other material; make that structural, not handler discipline.
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      const result = await performDispatch(
        String(params.qualifiedId ?? ""),
        String(params.task ?? ""),
        null,
        store,
        registry,
        admission,
      );
      // Child stdout is UNTRUSTED package-agent output; tool results are
      // rendered in the operator's terminal by the host, so it takes the
      // same visibleEncode + cap treatment as the TUI path (2026-07-31
      // security review — ADR-0131 D7's hostile-text rule has no
      // ingress exemption).
      let body = result.summary;
      if (result.childStdout !== null) {
        const capped = result.childStdout.slice(0, 64 * 1024);
        body += `\n\n${visibleEncode(capped)}`;
        if (capped.length < result.childStdout.length) body += "\n[output truncated]";
      }
      return {
        content: [{ type: "text" as const, text: body }],
        details: { ok: result.ok },
        isError: !result.ok,
      };
    },
  });

  pi.on("session_shutdown", () => {
    const cleared = registry.close();
    admission.close();
    return recordShutdownEvidence(store, cleared, Date.now());
  });

  pi.on("input", async (event, ctx) => {
    const routed = routeInput(event.text);
    if (!routed.ours) return { action: "continue" as const };

    // From here on, the input is ALWAYS handled: it must never reach the
    // model, skills, templates, or another extension.
    try {
      // Approval and review remain exact direct-TUI ingress. Revocation is
      // intentionally provenance-unrestricted because it can only narrow
      // authority and must never show an approval prompt.
      const provenanceFree =
        routed.ok && (routed.command.kind === "revoke" || routed.command.kind === "dispatch");
      if (!provenanceFree && (
        ctx.mode !== "tui" ||
        event.source !== "interactive" ||
        event.streamingBehavior !== undefined
      )) {
        notify(ctx, "package-agent: refused — commands require direct interactive TUI input (not RPC, extension, steer, or follow-up).", "error");
        await auditOrWarn(
          ctx,
          store,
          makeAuditEvent("review-aborted", Date.now(), {
            outcome: "refused",
            reason: "not-interactive-tui",
          }),
        );
        return { action: "handled" as const };
      }

      if (!routed.ok) {
        notify(ctx, `package-agent: rejected — ${routed.reason}. Commands: list | inspect <id> | status [id] | review <id> [--alias <alias>] | reject <id> | revoke-draft <id> | approve <id> [--alias <alias>] | grants | revoke <id> | dispatch <id> -- <task>`, "error");
        // Audit malformed review-shaped input (an affirmative-path anomaly);
        // read-only typos stay UI-only to keep audit spam-free.
        if (/^[ \t]*\/package-agent[ \t]+review\b/.test(event.text)) {
          await auditOrWarn(
            ctx,
            store,
            makeAuditEvent("review-aborted", Date.now(), {
              outcome: "refused",
              reason: "malformed-input",
            }),
          );
        }
        return { action: "handled" as const };
      }

      await handleCommand(routed.command, ctx, store, registry, admission);
      return { action: "handled" as const };
    } catch (err) {
      const failure = classifyFailure(err);
      notify(ctx, `package-agent: refused (${failure.label}).`, "error");
      await auditOrWarn(
        ctx,
        store,
        makeAuditEvent(failure.kind, Date.now(), {
          outcome: "refused",
          reason: failure.reason,
        }),
      );
      return { action: "handled" as const };
    } finally {
      // Expiry retirements observed by any registry call this command made
      // are audited here, outside every authority lock (#929).
      await flushLifecycleEvidence(ctx, store, registry);
    }
  });
}

/**
 * Persist lifecycle evidence for expiry retirements the registry observed
 * (plus any explicit observations, e.g. a just-committed revocation). Runs
 * OUTSIDE every authority lock per the ADR-0129 ordering rule. A store
 * failure warns loudly but never resurrects or destroys authority — the
 * in-memory transition already happened.
 */
async function flushLifecycleEvidence(
  ctx: ExtensionContext,
  store: StateStore,
  registry: GrantRegistry,
  extra: LifecycleObservation[] = [],
): Promise<void> {
  const atMs = Date.now();
  const observations: LifecycleObservation[] = [
    ...registry.drainExpired().map((grant) => ({ grant, state: "expired" as const, atMs })),
    ...extra,
  ];
  if (observations.length === 0) return;
  try {
    await recordLifecycleEvidence(store, observations);
  } catch (err) {
    const why = err instanceof StateError ? err.reason : "unavailable";
    notify(
      ctx,
      `package-agent: WARNING — a grant lifecycle transition took effect, but its audit record could not be written (${why}). The audit trail is incomplete for this event.`,
      "warning",
    );
  }
}

async function handleCommand(
  command: RoutedCommand,
  ctx: ExtensionContext,
  store: StateStore,
  registry: GrantRegistry,
  admission: DispatchAdmission,
): Promise<void> {
  const agentDir = agentDirOf();

  const runDiscovery = (): DiscoveryResult =>
    discoverProposals({ agentDir, settingsPackages: readSettingsPackages(agentDir) });

  switch (command.kind) {
    case "list": {
      const { proposals, skips } = runDiscovery();
      const state = store.load();
      if (proposals.length === 0 && skips.length === 0) {
        notify(ctx, "package-agent: no pinned-git packages expose agent descriptors.");
        return;
      }
      const lines: string[] = [];
      for (const p of proposals) {
        const draft = state.drafts[p.qualifiedId];
        lines.push(`${visibleEncode(p.qualifiedId)} — ${draft ? "reviewed (inert draft)" : "pending (unreviewed)"}`);
      }
      for (const s of skips) {
        // Skip fields may carry on-disk names; always visibly encode.
        const where = `${s.source === null ? "?" : visibleEncode(s.source)}${s.relPath ? ` ${visibleEncode(s.relPath)}` : ""}`;
        lines.push(`skipped: ${where} — ${visibleEncode(s.reason)}`);
      }
      notify(ctx, `package-agent proposals:\n${lines.join("\n")}`);
      return;
    }

    case "status": {
      const state = store.load();
      const now = Date.now();
      const drafts = Object.values(state.drafts).filter(
        (d) => command.qualifiedId === null || d.qualifiedId === command.qualifiedId,
      );
      if (drafts.length === 0) {
        notify(ctx, "package-agent: no matching review drafts. Drafts are inert evidence; #917 approval is always required.");
        return;
      }
      notify(
        ctx,
        `package-agent drafts (generation ${state.generation}):\n${drafts.map((d) => draftStatusLine(d, now)).join("\n")}`,
      );
      return;
    }

    case "inspect": {
      const { proposals } = runDiscovery();
      const proposal = proposals.find((p) => p.qualifiedId === command.qualifiedId);
      if (!proposal) {
        notify(ctx, "package-agent: no such proposal in the current discovery pass.", "error");
        return;
      }
      const snapshot = buildReviewSnapshot(proposal, null);
      const digest = computeProposalDigest(snapshot);
      await showPages(ctx, renderSnapshotPages(snapshot, digest), "inspect");
      return;
    }

    case "reject": {
      const { proposals } = runDiscovery();
      if (!proposals.some((p) => p.qualifiedId === command.qualifiedId)) {
        notify(ctx, "package-agent: no such proposal in the current discovery pass.", "error");
        return;
      }
      const state = store.load();
      await store.commit(state.generation, (current) => {
        pushAudit(
          current,
          makeAuditEvent("draft-rejected", Date.now(), {
            qualifiedId: command.qualifiedId,
            stateGeneration: current.generation + 1,
            outcome: "committed",
            reason: "operator-declined",
          }),
        );
        return current;
      });
      notify(ctx, `package-agent: rejection recorded for ${visibleEncode(command.qualifiedId)}. (No authority existed to remove.)`);
      return;
    }

    case "revoke-draft": {
      const state = store.load();
      const draft = state.drafts[command.qualifiedId];
      if (!draft) {
        notify(ctx, "package-agent: no draft exists for that id.", "error");
        return;
      }
      const wasExpired = Date.now() >= draft.expiresAtMs;
      await store.commit(state.generation, (current) => {
        delete current.drafts[command.qualifiedId];
        pushAudit(
          current,
          makeAuditEvent("draft-revoked", Date.now(), {
            qualifiedId: command.qualifiedId,
            stateGeneration: current.generation + 1,
            outcome: "committed",
            reason: wasExpired ? "draft-expired" : "operator-declined",
          }),
        );
        return current;
      });
      notify(ctx, `package-agent: draft revoked for ${visibleEncode(command.qualifiedId)}. Drafts carry no authority; revocation removes evidence only.`);
      return;
    }

    case "review": {
      await runReviewFlow(command.qualifiedId, command.alias, ctx, store, runDiscovery);
      return;
    }

    case "grants": {
      const grants = await registry.list();
      if (grants.length === 0) {
        notify(ctx, "package-agent: no active grants in this runtime. Authority is in-memory only and does not survive exit or /reload.");
        return;
      }
      notify(
        ctx,
        `package-agent active grants (runtime ${registry.runtimeInstanceId.slice(0, 16)}…):\n${grants
          .map((g) => grantStatusLine(g))
          .join("\n")}\ndispatch admission: ${admission.activeCount} active, ${admission.queueDepth} queued`,
      );
      return;
    }

    case "approve": {
      await runApprovalFlow(command.qualifiedId, command.alias, ctx, store, registry, runDiscovery);
      return;
    }

    case "revoke": {
      // Cancel queued admission BEFORE taking the preemptive authority lock:
      // nothing waiting in the admission queue for this identity may still be
      // promoted once the operator has asked for revocation. Requests already
      // promoted are the "child created before revocation" case ADR-0129
      // permits; #930's dispatch revalidation finds no grant for them.
      const cancelled = admission.cancelIdentity(command.qualifiedId);
      const removed = await registry.revoke(command.qualifiedId);
      if (removed === null) {
        notify(ctx, `package-agent: no active grant for ${visibleEncode(command.qualifiedId)} in this runtime.`);
        return;
      }
      // Audit + receipt terminal stamp, after the authority lock released.
      await flushLifecycleEvidence(ctx, store, registry, [
        { grant: removed, state: "revoked", atMs: Date.now() },
      ]);
      notify(
        ctx,
        `package-agent: active grant revoked for ${visibleEncode(command.qualifiedId)} in the current runtime only.${cancelled > 0 ? ` ${cancelled} queued dispatch request(s) cancelled.` : ""} Already-running children, if any, are not authority-revoked.`,
      );
      return;
    }

    case "dispatch": {
      const result = await performDispatch(
        command.qualifiedId,
        command.task,
        ctx,
        store,
        registry,
        admission,
      );
      // TUI path: the summary is broker-authored; child stdout is untrusted
      // package-agent output and is surfaced ONLY through visibleEncode with
      // a hard display cap.
      const lines = [`package-agent: ${result.summary}`];
      if (result.childStdout !== null) {
        const capped = result.childStdout.slice(0, 16 * 1024);
        lines.push(visibleEncode(capped));
        if (capped.length < result.childStdout.length) lines.push("[output truncated for display]");
      }
      notify(ctx, lines.join("\n"), result.ok ? "info" : "error");
      return;
    }
  }
}

/**
 * Page through rendered snapshot pages. Declining ANY page — the last one
 * included — stops the flow and returns false; only affirmative
 * acknowledgment of every page returns true.
 */
async function showPages(ctx: ExtensionContext, pages: string[], verb: string): Promise<boolean> {
  for (let i = 0; i < pages.length; i++) {
    const last = i === pages.length - 1;
    const ok = await ctx.ui.confirm(
      `package-agent ${verb} (${i + 1}/${pages.length})`,
      pages[i] + (last ? "\n\n[End of snapshot — continue?]" : "\n\n[Continue to next page?]"),
    );
    if (!ok) return false;
  }
  return true;
}

async function runReviewFlow(
  qualifiedId: string,
  alias: string | null,
  ctx: ExtensionContext,
  store: StateStore,
  runDiscovery: () => DiscoveryResult,
): Promise<void> {
  const refuse = async (reason: AuditReasonCode, message: string): Promise<void> => {
    notify(ctx, `package-agent: review aborted — ${message}`, "error");
    await auditOrWarn(
      ctx,
      store,
      makeAuditEvent("review-aborted", Date.now(), {
        qualifiedId,
        outcome: "refused",
        reason,
      }),
    );
  };

  // Discovery pass 1: find and validate the proposal.
  const discovery = runDiscovery();
  const proposal = discovery.proposals.find((p) => p.qualifiedId === qualifiedId);
  if (!proposal) {
    await refuse("draft-missing", "no such proposal in the current discovery pass.");
    return;
  }

  const startState = store.load();
  const startGeneration = startState.generation;

  try {
    checkCollisions(proposal, discovery.proposals, existingAliasMap(startState), alias);
  } catch (err) {
    await refuse("collision-refused", err instanceof CollisionError ? err.message : "collision check failed.");
    return;
  }

  // Immutable snapshot + digest, displayed in full.
  const snapshot = buildReviewSnapshot(proposal, alias);
  const digest = computeProposalDigest(snapshot);

  const viewed = await showPages(ctx, renderSnapshotPages(snapshot, digest), "review");
  if (!viewed) {
    await refuse("operator-declined", "review stopped before the full snapshot was acknowledged.");
    return;
  }

  // Untimed confirmation: retype the exact qualified identity and digest.
  const typedId = await ctx.ui.input("Retype the EXACT qualified id to confirm the review");
  if (!exactMatch(qualifiedId, typedId)) {
    await refuse("identity-retype-mismatch", "qualified id retype did not match exactly.");
    return;
  }
  const typedDigest = await ctx.ui.input("Retype the EXACT sha256 proposal digest to confirm");
  if (!exactMatch(digest, typedDigest)) {
    await refuse("digest-retype-mismatch", "digest retype did not match exactly.");
    return;
  }

  // Display-to-commit transaction: under the cross-process lock, reload the
  // state generation, re-read every source object, and compare against the
  // displayed snapshot. Any changed byte aborts.
  let committed: ReviewDraft | null = null;
  try {
    await store.commit(startGeneration, (current) => {
      const recheck = runDiscovery();
      const fresh = recheck.proposals.find((p) => p.qualifiedId === qualifiedId);
      if (!fresh) {
        throw new StateError("proposal vanished before commit", "state-integrity-refused");
      }
      const freshSnapshot = buildReviewSnapshot(fresh, alias);
      if (!snapshotsEqual(snapshot, freshSnapshot)) {
        throw new StateError("source changed during review", "state-integrity-refused");
      }
      try {
        checkCollisions(fresh, recheck.proposals, existingAliasMap(current), alias);
      } catch (err) {
        throw new StateError(
          err instanceof CollisionError ? err.message : "collision check failed",
          "state-integrity-refused",
        );
      }

      const revision = (current.draftRevisions[qualifiedId] ?? 0) + 1;
      const issuedAtMs = Date.now();
      const draft: ReviewDraft = {
        kind: REVIEW_DRAFT_KIND,
        schemaVersion: REVIEW_DRAFT_SCHEMA_VERSION,
        activatable: false,
        requiresFreshApproval: true,
        authorizationDigest: null,
        qualifiedId,
        draftRevision: revision,
        proposalDigest: digest,
        snapshot,
        nonce: randomBytes(32).toString("hex"),
        issuedAtMs,
        expiresAtMs: issuedAtMs + DRAFT_EXPIRY_MS,
      };
      if (Object.keys(current.drafts).length >= BOUNDS.maxDrafts && !current.drafts[qualifiedId]) {
        throw new StateError("draft count bound reached", "bounds-exceeded");
      }
      current.draftRevisions[qualifiedId] = revision;
      current.drafts[qualifiedId] = draft;
      pushAudit(
        current,
        makeAuditEvent("draft-recorded", issuedAtMs, {
          qualifiedId,
          source: snapshot.packageIdentity.source,
          observedCommit: snapshot.packageIdentity.observedCommit,
          proposalDigest: digest,
          draftRevision: revision,
          stateGeneration: current.generation + 1,
          expiresAtMs: draft.expiresAtMs,
          outcome: "committed",
          reason: "ok",
        }),
      );
      committed = draft;
      return current;
    });
  } catch (err) {
    if (err instanceof StateError && err.reason === "generation-conflict") {
      await refuse("generation-conflict", "broker state changed during review; re-run the review.");
      return;
    }
    if (err instanceof StateError && err.message.includes("source changed")) {
      await refuse("source-changed-during-review", "package bytes changed between display and commit.");
      return;
    }
    throw err;
  }

  if (committed !== null) {
    const draft: ReviewDraft = committed;
    notify(
      ctx,
      [
        `package-agent: review draft recorded for ${visibleEncode(qualifiedId)} (rev ${draft.draftRevision}).`,
        `THIS DRAFT AUTHORIZES NOTHING: it is inert evidence (activatable: false).`,
        `Activation requires #917's fresh direct-TUI approval with complete provenance.`,
      ].join("\n"),
    );
  }
}

/**
 * The #928 approval flow: reconstruct complete provenance, display it, take a
 * fresh direct-TUI approval, and install a runtime-scoped active grant.
 *
 * Three properties are load-bearing and must survive any edit to this
 * function:
 *
 *   1. NO DRAFT IS EVIDENCE. `startState.drafts[...]` is read for one purpose
 *      — a display line saying the operator reviewed this identity before.
 *      No branch is skipped, no field is pre-filled, and no confirmation is
 *      shortened by its presence. Delete the draft and the flow is identical.
 *   2. DISPLAY-TO-COMMIT. The definition is reconstructed a second time under
 *      the authority lock and its digest compared to the displayed one. The
 *      operator approves the digest that becomes authoritative, or nothing
 *      is installed.
 *   3. APPROVAL DOES NOT DISPATCH. This function creates the authority object
 *      and returns. It never offers, arms, schedules, registers, enables, or
 *      pre-authorizes a dispatch — synchronously or through any deferred
 *      mechanism. No state it writes can cause a dispatch to occur.
 */
async function runApprovalFlow(
  qualifiedId: string,
  alias: string | null,
  ctx: ExtensionContext,
  store: StateStore,
  registry: GrantRegistry,
  runDiscovery: () => DiscoveryResult,
): Promise<void> {
  const refuse = async (reason: AuditReasonCode, message: string): Promise<void> => {
    notify(ctx, `package-agent: approval aborted — ${message}`, "error");
    await auditOrWarn(
      ctx,
      store,
      makeAuditEvent("grant-approval-aborted", Date.now(), {
        qualifiedId,
        outcome: "refused",
        reason,
      }),
    );
  };

  const discovery = runDiscovery();
  const proposal = discovery.proposals.find((p) => p.qualifiedId === qualifiedId);
  if (!proposal) {
    await refuse("proposal-missing", "no such proposal in the current discovery pass.");
    return;
  }

  const startState = store.load();

  try {
    checkCollisions(proposal, discovery.proposals, existingAliasMap(startState), alias);
    checkPackageIdentityCollision(proposal, activeGrantIdentities(await registry.list()));
  } catch (err) {
    await refuse("collision-refused", err instanceof CollisionError ? err.message : "collision check failed.");
    return;
  }

  // Minted before display so the operator retypes the digest of the exact
  // grant that will be installed. The sequence is consumed whether or not
  // this approval commits — an aborted attempt must remain distinguishable
  // in the audit trail.
  const binding = registry.mintApprovalBinding(qualifiedId);

  let definition;
  try {
    definition = reconstructEffectiveDefinition(proposal, alias, binding);
  } catch (err) {
    if (err instanceof ReconstructionError) {
      await refuse(err.reason, err.message);
      return;
    }
    throw err;
  }
  const digest = computeGrantDigest(definition);

  // Display context only — see property 1 above.
  const priorDraft = startState.drafts[qualifiedId];
  const priorNote = priorDraft
    ? `A review draft for this identity was recorded on ${new Date(priorDraft.issuedAtMs).toISOString()} (rev ${priorDraft.draftRevision}).`
    : null;

  // Enumerate the digest's bound scope for the operator: every entry the
  // sandboxed child will be able to read (2026-07-31 security review).
  let assetEntries;
  try {
    assetEntries = walkAssetTree(proposal.installRoot).map((e) => ({
      relPath: e.relPath,
      kind: e.kind,
      detail: e.kind === "file" ? `${e.byteLength} B sha256:${e.sha256.slice(0, 12)}` : `-> ${e.target}`,
    }));
  } catch (err) {
    if (err instanceof ReconstructionError) {
      await refuse(err.reason, err.message);
      return;
    }
    throw err;
  }
  const viewed = await showPages(ctx, renderGrantPages(definition, digest, priorNote, assetEntries), "approve");
  if (!viewed) {
    await refuse("operator-declined", "approval stopped before the full definition was acknowledged.");
    return;
  }

  const typedId = await ctx.ui.input("Retype the EXACT qualified id to APPROVE (this creates authority)");
  if (!exactMatch(qualifiedId, typedId)) {
    await refuse("identity-retype-mismatch", "qualified id retype did not match exactly.");
    return;
  }
  const typedDigest = await ctx.ui.input("Retype the EXACT sha256 grant digest to APPROVE");
  if (!exactMatch(digest, typedDigest)) {
    await refuse("digest-retype-mismatch", "digest retype did not match exactly.");
    return;
  }

  // Reload state for the commit-time collision recheck BEFORE taking the
  // authority lock. `runReviewFlow` gets this freshness from running its
  // recheck inside `store.commit`; the approval flow deliberately performs no
  // store I/O under the authority lock (ADR-0129 lock ordering), so it
  // refreshes here instead. That leaves only a microsecond-scale window rather
  // than the whole untimed operator-read-and-retype window.
  const commitState = store.load();

  // Display-to-commit transaction under the AUTHORITY lock. No store I/O runs
  // inside this callback: ADR-0129's ordering rule forbids holding the
  // authority lock while acquiring the cross-process store lock, so that a
  // revocation can never wait behind the store lock's retry-with-backoff.
  const outcome: { grant: ActiveGrant | null; failure: { reason: AuditReasonCode; message: string } | null } = {
    grant: null,
    failure: null,
  };
  await registry.withApprovalLock(qualifiedId, () => {
    const recheck = runDiscovery();
    const fresh = recheck.proposals.find((p) => p.qualifiedId === qualifiedId);
    if (!fresh) {
      outcome.failure = { reason: "proposal-missing", message: "proposal vanished before approval." };
      return;
    }
    let freshDefinition;
    try {
      freshDefinition = reconstructEffectiveDefinition(fresh, alias, binding);
    } catch (err) {
      outcome.failure = {
        reason: err instanceof ReconstructionError ? err.reason : "state-integrity-refused",
        message: err instanceof Error ? err.message : "reconstruction refused.",
      };
      return;
    }
    if (computeGrantDigest(freshDefinition) !== digest) {
      outcome.failure = {
        reason: "source-changed-during-review",
        message: "the effective definition changed between display and approval.",
      };
      return;
    }
    try {
      checkCollisions(fresh, recheck.proposals, existingAliasMap(commitState), alias);
      // Re-run the package-identity check here too, not only before display:
      // a grant for another ref of this package agent may have been installed
      // while the operator was reading. `registry.install` enforces the same
      // condition as the final choke point — this recheck exists so the
      // operator gets the specific refusal rather than a generic one.
      checkPackageIdentityCollision(fresh, activeGrantIdentities(registry.snapshotUnlocked()));
    } catch (err) {
      outcome.failure = {
        reason: "collision-refused",
        message: err instanceof CollisionError ? err.message : "collision check failed.",
      };
      return;
    }
    try {
      outcome.grant = registry.install(freshDefinition, digest);
    } catch (err) {
      let reason: AuditReasonCode = "state-integrity-refused";
      if (err instanceof GrantError) {
        if (err.reason === "grant-cap-reached") reason = "grant-cap-reached";
        else if (err.reason === "package-identity-collision") reason = "collision-refused";
      }
      outcome.failure = {
        reason,
        message: err instanceof Error ? err.message : "grant installation refused.",
      };
    }
  });

  if (outcome.failure !== null) {
    await refuse(outcome.failure.reason, outcome.failure.message);
    return;
  }
  const grant = outcome.grant;
  if (grant === null) {
    await refuse("state-integrity-refused", "approval produced no grant.");
    return;
  }

  // Receipt and audit, AFTER the authority lock is released. Both are
  // non-authorizing: the dispatch path reads no file. A failure here
  // therefore must not destroy authority the operator just granted in
  // person — it warns loudly and leaves the grant standing.
  const receipt: GrantReceipt = {
    kind: GRANT_RECEIPT_KIND,
    schemaVersion: GRANT_SCHEMA_VERSION,
    authorizing: false,
    qualifiedId,
    runtimeInstanceId: grant.approval.runtimeInstanceId,
    approvalSequence: grant.approval.sequence,
    observedGrantDigest: grant.digest,
    approvedAtMs: grant.approvedAtMs,
    expiresAtMs: grant.expiresAtMs,
  };
  try {
    const current = store.load();
    await store.commit(current.generation, (state) => {
      state.grantReceipts[qualifiedId] = receipt;
      pushAudit(
        state,
        makeAuditEvent("grant-approved", grant.approvedAtMs, {
          qualifiedId,
          source: grant.definition.packageIdentity.source,
          observedCommit: grant.definition.resolvedCommit,
          grantDigest: grant.digest,
          approvalSequence: grant.approval.sequence,
          stateGeneration: state.generation + 1,
          expiresAtMs: grant.expiresAtMs,
          outcome: "committed",
          reason: "ok",
        }),
      );
      return state;
    });
  } catch (err) {
    const why = err instanceof StateError ? err.reason : "unavailable";
    notify(
      ctx,
      `package-agent: WARNING — the grant is ACTIVE, but its non-authorizing receipt could not be written (${why}). The audit trail is incomplete for this approval.`,
      "warning",
    );
  }

  notify(
    ctx,
    [
      `package-agent: ACTIVE GRANT created for ${visibleEncode(qualifiedId)} (approval #${grant.approval.sequence}).`,
      `Digest ${grant.digest}`,
      `Expires ${new Date(grant.expiresAtMs).toISOString()} — or when this pi process exits or reloads.`,
      `Authority is in memory only; nothing on disk grants it.`,
      `Nothing has been dispatched. Dispatch is a separate, explicitly invoked operation.`,
    ].join("\n"),
  );
}
