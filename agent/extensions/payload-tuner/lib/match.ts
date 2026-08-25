/**
 * payload-tuner rule matching (ADR-0106).
 *
 * A rule matches when EVERY field present in its `match` block matches the
 * resolved model (AND semantics). Fields support `*` as a multi-character
 * wildcard; matching is case-sensitive and anchored (the pattern must cover
 * the whole value). First matching rule wins.
 */

import type { RuleMatch, TunerRule } from "./settings.ts";

/** The subset of pi's Model object the matcher/guards read (from ctx.model). */
export interface ModelLike {
  id?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  /** Adapter-family discriminator (e.g. "openai-completions") — read by the
   *  ADR-0147 guards, not by rule matching. */
  api?: unknown;
}

/** Anchored glob match: `*` matches any run of characters, nothing else is special. */
export function globMatch(pattern: string, value: string): boolean {
  const parts = pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`^${parts.join(".*")}$`);
  return re.test(value);
}

function fieldMatches(pattern: string | undefined, value: unknown): boolean {
  if (pattern === undefined) return true;
  return typeof value === "string" && globMatch(pattern, value);
}

function ruleMatches(match: RuleMatch, model: ModelLike): boolean {
  return (
    fieldMatches(match.provider, model.provider) &&
    fieldMatches(match.baseUrl, model.baseUrl) &&
    fieldMatches(match.modelId, model.id)
  );
}

/** Return the first rule matching the model, or null. */
export function matchRule(rules: TunerRule[], model: ModelLike): TunerRule | null {
  for (const rule of rules) {
    if (ruleMatches(rule.match, model)) return rule;
  }
  return null;
}
