/**
 * payload-tuner settings — USER-layer only (ADR-0106).
 *
 * `extensionSettings.payloadTuner` is read exclusively from
 * ~/.pi/agent/settings.json. The project layer is ignored entirely: a
 * hostile repo's .pi/settings.json must not be able to steer sampling or
 * strip thinking on local models (same posture as ADR-0094's role lever
 * and token-meter's enabled toggle).
 *
 * Parsing is fail-closed to the inert default: any malformed block, rule,
 * matcher, or tweak disables the extension rather than half-applying it.
 */

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Model-matching predicate: every present field must match (glob `*`). */
export interface RuleMatch {
  provider?: string;
  baseUrl?: string;
  modelId?: string;
}

/** Request-option tweaks a rule may apply. All optional; all non-prefix. */
export interface RuleApply {
  chatTemplateKwargs?: Record<string, unknown>;
  temperature?: number;
  topP?: number;
  maxTokensCap?: number;
}

export interface TunerRule {
  match: RuleMatch;
  apply: RuleApply;
}

export interface PayloadTunerSettings {
  enabled: boolean;
  rules: TunerRule[];
}

export const DISABLED: PayloadTunerSettings = { enabled: false, rules: [] };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Fail-closed mirror of settings.schema.json's `additionalProperties: false`:
 *  a typo'd key must reject the block, never silently half-apply it. */
function hasUnknownKeys(v: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(v).some((k) => !allowed.includes(k));
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseMatch(v: unknown): RuleMatch | null {
  if (!isPlainObject(v)) return null;
  if (hasUnknownKeys(v, ["provider", "baseUrl", "modelId"])) return null;
  const match: RuleMatch = {};
  const provider = optString(v.provider);
  const baseUrl = optString(v.baseUrl);
  const modelId = optString(v.modelId);
  if (provider !== undefined) match.provider = provider;
  if (baseUrl !== undefined) match.baseUrl = baseUrl;
  if (modelId !== undefined) match.modelId = modelId;
  // An empty matcher would match every request — require at least one field.
  if (Object.keys(match).length === 0) return null;
  return match;
}

function parseApply(v: unknown): RuleApply | null {
  if (!isPlainObject(v)) return null;
  if (hasUnknownKeys(v, ["chatTemplateKwargs", "temperature", "topP", "maxTokensCap"])) return null;
  const apply: RuleApply = {};
  if (v.chatTemplateKwargs !== undefined) {
    if (!isPlainObject(v.chatTemplateKwargs)) return null;
    // Empty kwargs is a no-op tweak — same config-mistake class as an
    // empty apply block below.
    if (Object.keys(v.chatTemplateKwargs).length === 0) return null;
    apply.chatTemplateKwargs = v.chatTemplateKwargs;
  }
  const temperature = finiteNumber(v.temperature);
  const topP = finiteNumber(v.topP);
  const maxTokensCap = finiteNumber(v.maxTokensCap);
  if (temperature !== undefined) apply.temperature = temperature;
  if (topP !== undefined) apply.topP = topP;
  if (maxTokensCap !== undefined) {
    if (maxTokensCap <= 0 || !Number.isInteger(maxTokensCap)) return null;
    apply.maxTokensCap = maxTokensCap;
  }
  // A rule that applies nothing is a config mistake — reject it.
  if (Object.keys(apply).length === 0) return null;
  return apply;
}

/**
 * Parse the raw `extensionSettings.payloadTuner` block. Pure — unit-tested
 * without a filesystem. Returns DISABLED on any malformed input.
 */
export function parseSettings(raw: unknown): PayloadTunerSettings {
  if (!isPlainObject(raw)) return DISABLED;
  if (hasUnknownKeys(raw, ["enabled", "rules"])) return DISABLED;
  if (raw.enabled !== true) return DISABLED;
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) return DISABLED;
  const rules: TunerRule[] = [];
  for (const r of raw.rules) {
    if (!isPlainObject(r)) return DISABLED;
    if (hasUnknownKeys(r, ["match", "apply"])) return DISABLED;
    const match = parseMatch(r.match);
    const apply = parseApply(r.apply);
    if (!match || !apply) return DISABLED;
    rules.push({ match, apply });
  }
  return { enabled: true, rules };
}

/** Load from the user layer only; fail-open to DISABLED on any error. */
export async function loadSettings(): Promise<PayloadTunerSettings> {
  try {
    const p = join(homedir(), ".pi", "agent", "settings.json");
    const j = JSON.parse(await fs.readFile(p, "utf8")) as {
      extensionSettings?: { payloadTuner?: unknown };
    };
    return parseSettings(j?.extensionSettings?.payloadTuner);
  } catch {
    return DISABLED;
  }
}
