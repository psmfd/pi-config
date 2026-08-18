// PI-EXTENSION-CAPABILITY: no-registerTool
/**
 * plain-english — enforce the Claudish→plain-English pass on markdown writes
 * (ADR-0142; #1022; behavioral counterpart: docs-expert SKILL.md
 * §Plain-English Pass, #1009).
 *
 * A `tool_call` handler on the core `write` tool mutates `event.input.content`
 * in place BEFORE the write executes (the worktree extension's in-flight
 * mutation pattern), so disk only ever holds the enforced version — no
 * post-hoc file churn, no agent-view/disk divergence, no rewrite loop.
 * `edit` calls pass through untouched: fragment rewrites cannot see document
 * context and would break edit anchoring.
 *
 * Fail-open contract: any failure — disabled, ineligible path, undersized or
 * oversized prose, missing credential, provider error, timeout, truncated
 * completion, placeholder mismatch — leaves the original content byte-for-byte
 * and never blocks the turn. Fixable causes surface once per session via
 * ctx.ui.notify.
 *
 * Settings: extensionSettings.plainEnglish (USER layer only — see config.ts),
 * plus a session-scoped `/plain-english on|off|status` command.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULTS, isEligiblePath, loadConfig, type PlainEnglishConfig } from "./config.ts";
import {
  rewriteWithFallback,
  type CompleteFn,
  type ModelCandidate,
  type RewriteFailure,
} from "./rewrite.ts";

interface WriteInput {
  path?: unknown;
  content?: unknown;
}

/** The registry/model surface this extension touches (duck-typed like token-meter's ModelContext). */
interface RegistryContext {
  model?: unknown;
  modelRegistry?: {
    find?: (provider: string, id: string) => unknown;
    getApiKeyAndHeaders?: (model: unknown) => {
      ok?: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
    };
  };
}

/** Failure causes worth telling the operator about (fixable setup problems). */
const NOTIFIABLE: ReadonlySet<RewriteFailure> = new Set<RewriteFailure>([
  "no-credential",
  "provider-error",
  "truncated",
]);

export default function plainEnglish(pi: ExtensionAPI): void {
  let cfg: PlainEnglishConfig = DEFAULTS;
  /** Session override: null = follow settings; true/false = /plain-english on|off. */
  let sessionOverride: boolean | null = null;
  const notified = new Set<RewriteFailure>();

  const enabled = (): boolean => sessionOverride ?? cfg.enabled;

  const notifyOnce = (ctx: ExtensionContext, reason: RewriteFailure): void => {
    if (!NOTIFIABLE.has(reason) || notified.has(reason)) return;
    notified.add(reason);
    if (ctx.hasUI) {
      ctx.ui.notify(
        `plain-english: rewrite skipped (${reason}) — original content written unchanged. ` +
          `Check extensionSettings.plainEnglish (model/credentials/timeout).`,
        "warning",
      );
    }
  };

  /**
   * Resolve the configured fallback chain into credentialed candidates, in
   * order. Unknown or credential-less entries are dropped here (the chain is
   * explicit operator config; a missing entry is a skip, never a silent
   * substitution). An empty configured chain falls back to the session's
   * active model.
   */
  const resolveCandidates = (ctx: ExtensionContext): ModelCandidate[] => {
    const rc = ctx as unknown as RegistryContext;
    const wanted: Array<{ model: unknown; label: string }> = [];
    for (const id of cfg.models) {
      const slash = id.indexOf("/");
      const found = rc.modelRegistry?.find?.(id.slice(0, slash), id.slice(slash + 1));
      if (found) wanted.push({ model: found, label: id });
    }
    if (wanted.length === 0 && cfg.models.length === 0 && rc.model) {
      wanted.push({ model: rc.model, label: "session model" });
    }
    const out: ModelCandidate[] = [];
    for (const w of wanted) {
      const auth = rc.modelRegistry?.getApiKeyAndHeaders?.(w.model);
      if (!auth || auth.ok === false || !auth.apiKey) continue;
      out.push({ model: w.model, apiKey: auth.apiKey, headers: auth.headers, label: w.label });
    }
    return out;
  };

  pi.on("session_start", async () => {
    cfg = await loadConfig();
    notified.clear();
  });

  pi.registerCommand("plain-english", {
    description: "Claudish→plain-English write rewriting: /plain-english [on|off|status]",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "on") sessionOverride = true;
      else if (sub === "off") sessionOverride = false;
      if (ctx.hasUI) {
        const src = sessionOverride === null ? "settings" : "session";
        ctx.ui.notify(
          `plain-english: ${enabled() ? "ON" : "OFF"} (${src}) — models: ${
            cfg.models.length > 0 ? cfg.models.join(" → ") : "session model"
          }`,
          "info",
        );
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (event.toolName !== "write" || !enabled()) return undefined;
      const input = event.input as WriteInput;
      if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
      if (!isEligiblePath(input.path, ctx.cwd, cfg)) return undefined;

      const candidates = resolveCandidates(ctx);
      if (candidates.length === 0) {
        notifyOnce(ctx, "no-credential");
        return undefined;
      }

      const result = await rewriteWithFallback(input.content, candidates, {
        completeFn: complete as unknown as CompleteFn,
        timeoutMs: cfg.timeoutMs,
        minChars: cfg.minChars,
        maxChars: cfg.maxChars,
        signal: ctx.signal,
      });
      if (!result.ok) {
        notifyOnce(ctx, result.reason);
        return undefined;
      }
      // In-flight input mutation: the actual write executes with this content.
      (event.input as Record<string, unknown>).content = result.content;
      return undefined;
    } catch {
      // Enforcement must never disturb a turn — fail open on anything unexpected.
      return undefined;
    }
  });
}
