/**
 * payload-tuner defensive vetoes (#778, ADR-0110).
 *
 * Pure filters applied by the dispatcher BEFORE `applyRule`: a matched
 * rule's `apply` block is reduced to the fields that are safe for the
 * resolved model's API family and the outgoing payload's state. This keeps
 * `applyRule` a pure `(payload, tweaks)` function (its ADR-0106 contract)
 * while closing the class of bug the extension's fail-open posture cannot
 * catch — a successfully-applied but semantically invalid mutation that
 * 400s at the provider.
 *
 * Vetoes (each recorded in the returned `suppressed` list):
 *   - `chatTemplateKwargs` unless the model is `api: "openai-completions"`
 *     AND its baseUrl host is loopback/private. API family alone is not
 *     sufficient: GitHub Copilot routes several cloud models through
 *     `openai-completions` on a public baseUrl, and cloud endpoints may
 *     reject unknown wire fields with a 400.
 *   - `temperature`, `topP`, and `maxTokensCap` when the payload carries an
 *     active extended-thinking config (`payload.thinking` object with
 *     `type !== "disabled"`). The Anthropic adapter deliberately omits
 *     `temperature` under thinking (its guard runs before this hook, so a
 *     rule would silently undo it), derives the thinking budget from
 *     `max_tokens` before the hook (a later downward clamp can push
 *     `max_tokens` below `budget_tokens`), and never wires `top_p` (which
 *     Anthropic's API documentation forbids alongside thinking — the
 *     adapter has no guard to rely on for it).
 */

import { isPlainObject, type RuleApply } from "./settings.ts";

/**
 * True when the URL's host is loopback or in an RFC 1918 private range —
 * the structural "local serving stack" signal (deliberately not a hostname
 * allowlist). Unparseable URLs classify as NOT private (fail toward
 * suppressing, which leaves the payload untouched — the safe direction).
 */
export function isPrivateOrLoopbackHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  // WHATWG URL keeps brackets on IPv6 literals — hostname is "[::1]",
  // never bare "::1", so only the bracketed form is checked.
  if (host === "localhost" || host === "[::1]") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/** True when the outgoing payload carries an active extended-thinking config. */
export function hasActiveThinking(payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  const t = payload.thinking;
  // Anthropic-shaped: `thinking: { type: "adaptive" | "enabled" | ... }`.
  // Completions-style thinking formats use different shapes (string
  // `thinking`, `chat_template_kwargs`, `reasoning_effort`) and do not
  // false-positive here.
  return isPlainObject(t) && t.type !== "disabled";
}

export interface GuardContext {
  api: unknown;
  baseUrl: unknown;
  payload: unknown;
}

export interface FilteredApply {
  filtered: RuleApply;
  /** RuleApply field names that were vetoed, for the status counters. */
  suppressed: string[];
}

/** Reduce a matched rule's `apply` block to the context-safe subset. */
export function filterApplyForContext(apply: RuleApply, ctx: GuardContext): FilteredApply {
  const filtered: RuleApply = { ...apply };
  const suppressed: string[] = [];

  if (filtered.chatTemplateKwargs !== undefined) {
    const localCompletions =
      ctx.api === "openai-completions" &&
      typeof ctx.baseUrl === "string" &&
      isPrivateOrLoopbackHost(ctx.baseUrl);
    if (!localCompletions) {
      delete filtered.chatTemplateKwargs;
      suppressed.push("chatTemplateKwargs");
    }
  }

  if (hasActiveThinking(ctx.payload)) {
    for (const field of ["temperature", "topP", "maxTokensCap"] as const) {
      if (filtered[field] !== undefined) {
        delete filtered[field];
        suppressed.push(field);
      }
    }
  }

  return { filtered, suppressed };
}
