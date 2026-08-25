/**
 * payload-tuner rule application (ADR-0106).
 *
 * Pure function from (payload, tweaks) to a possibly-updated payload. The
 * three invariants that make this cache-safe and predictable:
 *
 *   1. NEVER touches `messages`, `system`/instructions, or tools content —
 *      only non-prefix request options are written.
 *   2. Set-based and idempotent: applying the same tweaks twice yields a
 *      byte-identical payload (regression-tested).
 *   3. The max-tokens clamp only lowers whichever of `max_tokens` /
 *      `max_completion_tokens` / `max_output_tokens` the adapter emitted;
 *      it never raises a value and never adds a field the adapter omitted.
 *      `max_output_tokens` (plain/Azure OpenAI Responses) is floored at 16
 *      — the Responses API rejects lower values (#778, ADR-0147). The
 *      default openai-codex provider emits no token-limit field at all, so
 *      the clamp is a no-op there by design.
 *
 * Unrecognized payload shapes (non-object) are left untouched.
 */

import { isPlainObject, type RuleApply } from "./settings.ts";

export interface ApplyResult {
  payload: unknown;
  changed: boolean;
}

/** Apply tweaks to a wire payload. Returns the original object when nothing changes. */
export function applyRule(payload: unknown, apply: RuleApply): ApplyResult {
  if (!isPlainObject(payload)) return { payload, changed: false };

  const next: Record<string, unknown> = { ...payload };
  let changed = false;

  if (apply.chatTemplateKwargs !== undefined) {
    const existing = isPlainObject(next.chat_template_kwargs) ? next.chat_template_kwargs : {};
    const merged = { ...existing, ...apply.chatTemplateKwargs };
    if (JSON.stringify(next.chat_template_kwargs) !== JSON.stringify(merged)) {
      next.chat_template_kwargs = merged;
      changed = true;
    }
  }

  if (apply.temperature !== undefined && next.temperature !== apply.temperature) {
    next.temperature = apply.temperature;
    changed = true;
  }

  if (apply.topP !== undefined && next.top_p !== apply.topP) {
    next.top_p = apply.topP;
    changed = true;
  }

  if (apply.maxTokensCap !== undefined) {
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
      const current = next[field];
      if (typeof current === "number" && current > apply.maxTokensCap) {
        // Responses API rejects max_output_tokens < 16 (adapter-verified
        // constant); clamping below that would trade a silent no-op for a
        // provider 400. The other fields have no documented floor.
        const capped =
          field === "max_output_tokens" ? Math.max(apply.maxTokensCap, 16) : apply.maxTokensCap;
        if (current > capped) {
          next[field] = capped;
          changed = true;
        }
      }
    }
  }

  return changed ? { payload: next, changed } : { payload, changed: false };
}
