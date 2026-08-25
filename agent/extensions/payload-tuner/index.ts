// PI-EXTENSION-CAPABILITY: no-registerTool
// Gated by validate.sh 6b-quinquies (ADR-0139): the declaration and the code must agree.

/**
 * payload-tuner — per-request wire-payload tuning for local models (ADR-0106).
 *
 * On `before_provider_request` (the extension-facing payload hook: a
 * non-`undefined` return replaces the outgoing wire payload), the resolved
 * model (`ctx.model`) is matched against user-configured rules and the first
 * match's tweaks are applied: `chat_template_kwargs` injection (e.g.
 * `reasoning_effort: "medium"` for the oMLX gpt-oss workhorse — #1052,
 * psmfd/local-llm#73/ADR-013; or `enable_thinking: false` for the GLM
 * fallback — psmfd/local-llm#44), sampling normalization
 * (`temperature`/`top_p`), and a `max_tokens` clamp.
 *
 * Never touches messages/system/tools content — prefix-cache-safe by
 * construction (the ADR-0032 invariant is reconciled in ADR-0106). Fails
 * open: any error leaves the payload unchanged; tuning never blocks a turn.
 * Settings are USER-layer only (`extensionSettings.payloadTuner` in
 * ~/.pi/agent/settings.json); inert by default.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { applyRule } from "./lib/apply.ts";
import { filterApplyForContext } from "./lib/guards.ts";
import { matchRule, type ModelLike } from "./lib/match.ts";
import { DISABLED, loadSettings, type PayloadTunerSettings } from "./lib/settings.ts";

/** Status-bar segment reflecting whether tuning is active. */
function showStatus(ctx: ExtensionContext, settings: PayloadTunerSettings): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(
    "payload-tuner",
    settings.enabled ? `🎛 tuner on (${settings.rules.length})` : "🎛 tuner off",
  );
}

export default function payloadTuner(pi: ExtensionAPI): void {
  let settings: PayloadTunerSettings = DISABLED;
  // Session-lifetime counters surfaced by /payload-tuner (observability only).
  let tunedCount = 0;
  let lastMatch: string | null = null;
  // ADR-0147 guard-veto counters: a matched rule whose apply block was
  // partially withheld must be visible to the operator, or a "tuned" status
  // line silently hides that the rule is doing less than configured.
  const suppressedCounts = new Map<string, number>();

  pi.on("session_start", async (_event, ctx) => {
    settings = await loadSettings();
    tunedCount = 0;
    lastMatch = null;
    suppressedCounts.clear();
    showStatus(ctx, settings);
  });

  pi.registerCommand("payload-tuner", {
    description: "Show payload-tuner status (rules are user-layer settings.json config)",
    handler: async (_args, ctx) => {
      const suppressed =
        suppressedCounts.size > 0
          ? `; suppressed: ${[...suppressedCounts.entries()]
              .map(([k, n]) => `${k}=${n}`)
              .join(" ")}`
          : "";
      ctx.ui.notify(
        `payload-tuner: ${settings.enabled ? "ON" : "OFF"}; ` +
          `rules=${settings.rules.length}; tuned=${tunedCount} request(s)` +
          (lastMatch ? `; last=${lastMatch}` : "") +
          suppressed,
        "info",
      );
    },
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!settings.enabled) return undefined;
    try {
      // The extension-level event carries no model object; the resolved
      // model comes from the context (same pattern as auto-router).
      const model = (ctx as { model?: ModelLike }).model;
      if (!model) return undefined;
      const rule = matchRule(settings.rules, model);
      if (!rule) return undefined;
      // Defensive vetoes (ADR-0147): reduce the rule's apply block to
      // the fields safe for this model's API family and the payload's
      // thinking state, BEFORE the pure applyRule runs.
      const { filtered, suppressed } = filterApplyForContext(rule.apply, {
        api: model.api,
        baseUrl: model.baseUrl,
        payload: event.payload,
      });
      for (const field of suppressed) {
        suppressedCounts.set(field, (suppressedCounts.get(field) ?? 0) + 1);
      }
      const result = applyRule(event.payload, filtered);
      if (!result.changed) return undefined;
      tunedCount += 1;
      const asStr = (v: unknown): string => (typeof v === "string" ? v : "?");
      lastMatch = `${asStr(model.provider)}/${asStr(model.id)}`;
      return result.payload;
    } catch {
      // Tuning must never break a turn — send the payload unchanged. The
      // extension runner also catches handler errors; this is belt-and-braces.
      return undefined;
    }
  });
}
