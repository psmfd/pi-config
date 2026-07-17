/**
 * subagent/model-pin.ts — spawn-time gate for frontmatter `model:` pins (#519)
 * plus the Copilot fallback rung (#536).
 *
 * A slash-qualified pin (`provider/id`, e.g. `omlx/coding-workhorse`) names an
 * exact registry entry, but the entry may not exist on this host: the omlx
 * provider is operator-local `models.json` config (ADR-0076/#518), and a
 * Copilot pin needs a live Copilot login. pi hard-exits a child whose --model
 * names a provider with no registered models, so passing an unresolvable pin
 * would break every fan-out subagent on hosts without that provider. The gate
 * passes a slash-qualified pin only when its exact provider/id is credentialed
 * in the registry; when it is not, the ADR-0076 tier ladder is consulted
 * before conceding to the session default: a Copilot fallback model (the
 * subscription rung) is substituted when it is registry-present AND not
 * excluded by the live tier filter (ADR-0035). Every non-pinned outcome
 * carries a visible note naming the rung the child actually ran on.
 *
 * Slash-less pins (e.g. the review trio's historical `claude-opus-4.7`) pass
 * through ungated — pi resolves them with its own pattern matching, and
 * replicating that here would risk stripping pins that would have resolved.
 */

import { isLocalModelKey, type LocalRole } from "../shared/local-role.ts";

/** Which rung the child actually runs on (#536). */
export type PinKind = "pinned" | "fallback" | "default";

export interface PinResolution {
  /** Value to pass as `--model`, or null to omit the flag entirely. */
  readonly modelArg: string | null;
  /** Human-readable note when the pin was not honored verbatim; null otherwise. */
  readonly note: string | null;
  /** Outcome: the pin itself, the Copilot fallback, or the session default. */
  readonly kind: PinKind;
}

/**
 * The Copilot fallback rung's inputs (#536). `liveEnabledIds` carries the
 * BARE model ids from the live tier filter (`resolveCopilotFilter`, ADR-0035);
 * `null` means discovery failed or was unavailable — fail open, the registry
 * check alone decides. Absence of a live check means "not disqualified",
 * never "verified".
 */
export interface CopilotFallback {
  /** Qualified `github-copilot/<id>` to substitute for a dropped pin. */
  readonly modelId: string;
  readonly liveEnabledIds?: ReadonlySet<string> | null;
  /** Static registry presence before live filtering (ADR-0104 diagnostics). */
  readonly registryAvailable?: boolean;
}

/** The slice of `ExtensionContext.modelRegistry` the gate reads. */
export interface PinRegistry {
  getAvailable(): Promise<readonly { provider: string; id: string }[]> | readonly { provider: string; id: string }[];
}

/** True when the pin is `provider/id`-qualified (a non-edge slash exists). */
export function isQualifiedPin(pin: string): boolean {
  const slash = pin.indexOf("/");
  return slash > 0 && slash < pin.length - 1;
}

/**
 * Build the `provider/id` set of credentialed models, or null when the
 * registry cannot be read (the gate then fails open — pi's own resolution
 * decides, preserving pre-gate behavior).
 */
export async function getAvailableModelIds(registry: PinRegistry): Promise<ReadonlySet<string> | null> {
  try {
    const models = await registry.getAvailable();
    return new Set(models.map((m) => `${m.provider}/${m.id}`));
  } catch {
    return null;
  }
}

/**
 * Sanitize a settings-supplied fallback model id (#536): only a qualified
 * `github-copilot/<id>` string is accepted — anything else (wrong provider,
 * slash-less, non-string) yields null and the built-in default applies.
 */
export function sanitizeFallbackModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!isQualifiedPin(trimmed) || !trimmed.startsWith("github-copilot/")) return null;
  return trimmed;
}

/**
 * Remove `omlx/<id>` entries whose bare id the live probe reports as NOT served
 * (#534, ADR-0081), so a registered-but-down oMLX server's pin is treated as
 * absent by {@link resolveModelPin} and the existing drop→fallback→default
 * ladder engages — the Copilot rung then catches it.
 *
 * Preserves the #364 dual semantics EXACTLY: `servedOmlxIds === null` means the
 * probe was inconclusive OR no omlx model is registered — FAIL OPEN, return the
 * set unchanged (a saturated-but-alive server mid-prefill is never dropped).
 * A non-null Set is authoritative even when EMPTY (server confirmed down →
 * every omlx id dropped). The `=== null` test is load-bearing: an empty Set is
 * truthy, so a `.size` guard would silently defeat the confirmed-down case.
 * Non-omlx ids are never touched. `availableIds === null` (registry unreadable)
 * passes through untouched — liveness never converts fail-open to fail-closed.
 */
export function filterDownOmlxIds(
  availableIds: ReadonlySet<string> | null,
  servedOmlxIds: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  if (availableIds === null || servedOmlxIds === null) return availableIds;
  const filtered = new Set<string>();
  for (const id of availableIds) {
    if (!id.startsWith("omlx/") || servedOmlxIds.has(id.slice("omlx/".length))) {
      filtered.add(id);
    }
  }
  return filtered;
}

/** Result of {@link applyLocalRole}: possibly-cleared pin + filtered menu. */
export interface LocalRoleGate {
  readonly requestedModel: string | undefined;
  readonly availableIds: ReadonlySet<string> | null;
  /** Human-readable note when the lever dropped a local pin; absent otherwise. */
  readonly note?: string;
}

/**
 * ADR-0094 (#685) backstop for the pin path: when the global localLlm.role
 * lever restricts local models, a LOCAL requested model (a wrapper
 * `model: omlx/…` pin) is cleared outright — deliberately fail-closed even
 * when the registry is unreadable (`availableIds === null`), unlike the
 * liveness filter's fail-open posture: liveness answers "is it up?", the
 * lever answers "is it allowed?", and an operator restriction must hold in
 * indeterminate states. Local ids are also stripped from the available menu
 * so nothing downstream re-admits one. Children never run the classifier
 * side-call, so "classifier-only" and "off" behave identically here.
 */
export function applyLocalRole(
  requestedModel: string | undefined,
  availableIds: ReadonlySet<string> | null,
  localRole: LocalRole,
): LocalRoleGate {
  if (localRole === "full") return { requestedModel, availableIds };
  const filteredIds =
    availableIds === null
      ? null
      : new Set([...availableIds].filter((id) => !isLocalModelKey(id)));
  if (requestedModel !== undefined && isLocalModelKey(requestedModel)) {
    return {
      requestedModel: undefined,
      availableIds: filteredIds,
      note: `local pin ${requestedModel} dropped: extensionSettings.localLlm.role=${localRole}`,
    };
  }
  return { requestedModel, availableIds: filteredIds };
}

/**
 * The leading clause of a dropped-pin note. For an `omlx/<id>` pin dropped when
 * the live probe returned an authoritative served set that excludes it (#534),
 * the wording distinguishes "server down" (empty set) and "up but not serving
 * this model" from the generic registry-absence phrasing — a down server is
 * fixed by restarting the process, not by editing models.json. `servedOmlxIds`
 * is consulted for WORDING ONLY; the drop decision already happened upstream in
 * {@link filterDownOmlxIds}. When omitted (every non-omlx pin, and every caller
 * that passes no probe result), the byte-identical original phrase is returned.
 */
function pinAbsenceReason(pin: string, servedOmlxIds?: ReadonlySet<string> | null): string {
  const slash = pin.indexOf("/");
  if (servedOmlxIds != null && pin.slice(0, slash) === "omlx") {
    const bareId = pin.slice(slash + 1);
    if (!servedOmlxIds.has(bareId)) {
      return servedOmlxIds.size === 0
        ? `model pin "${pin}" is unavailable — the oMLX server appears to be down`
        : `model pin "${pin}" is unavailable — the oMLX server is up but is not currently serving this model`;
    }
  }
  return `model pin "${pin}" is not available on this host`;
}

/**
 * Decide whether a frontmatter pin reaches the child's argv.
 *
 * - No pin → no flag, no note (`kind: "default"` — the session default is the
 *   agent's deliberate configuration, not a fallback).
 * - Slash-less pin → passed through verbatim (ungated).
 * - Qualified pin, registry unreadable (null) → passed through (fail open —
 *   the fallback rung is never consulted without registry data).
 * - Qualified pin present in the available set → passed through.
 * - Qualified pin absent → the Copilot rung (#536): substitute
 *   `fallback.modelId` when the dropped pin is not itself a github-copilot
 *   model (a dropped Copilot pin means the whole rung is dead or the id is
 *   stale — substituting a sibling would mislead) AND the fallback is
 *   registry-present AND the live tier filter does not exclude it. Otherwise
 *   the session default, with a note naming why each rung was skipped.
 *
 * `availableIds` is the caller's EFFECTIVE live-filtered set (ADR-0104), so a
 * down oMLX, tier-gated Copilot, or retired Anthropic pin arrives as absent and
 * takes the drop path. `fallback.registryAvailable` preserves the distinction
 * between a registry-absent and live-tier-gated Copilot fallback.
 * `servedOmlxIds` affects note wording only.
 */
export function resolveModelPin(
  pin: string | undefined,
  availableIds: ReadonlySet<string> | null,
  fallback?: CopilotFallback,
  servedOmlxIds?: ReadonlySet<string> | null,
): PinResolution {
  if (!pin) return { modelArg: null, note: null, kind: "default" };
  if (!isQualifiedPin(pin) || availableIds === null || availableIds.has(pin)) {
    return { modelArg: pin, note: null, kind: "pinned" };
  }
  const reason = pinAbsenceReason(pin, servedOmlxIds);
  const pinProvider = pin.slice(0, pin.indexOf("/"));
  const fb = fallback && isQualifiedPin(fallback.modelId) ? fallback : undefined;
  if (fb && pinProvider !== "github-copilot") {
    const bareId = fb.modelId.slice(fb.modelId.indexOf("/") + 1);
    const live = fb.liveEnabledIds;
    const registryAvailable = fb.registryAvailable ?? availableIds.has(fb.modelId);
    if (registryAvailable && live != null && !live.has(bareId)) {
      return {
        modelArg: null,
        note: `${reason}, and the Copilot fallback "${fb.modelId}" is tier-gated on this subscription; the subagent ran on the session default model`,
        kind: "default",
      };
    }
    if (registryAvailable && availableIds.has(fb.modelId)) {
      return {
        modelArg: fb.modelId,
        note: `${reason}; the subagent ran on the Copilot fallback "${fb.modelId}" instead of the session default`,
        kind: "fallback",
      };
    }
    return {
      modelArg: null,
      note: `${reason}, and the Copilot fallback "${fb.modelId}" is not available either; the subagent ran on the session default model`,
      kind: "default",
    };
  }
  return {
    modelArg: null,
    note: `${reason}; the subagent ran on the session default model`,
    kind: "default",
  };
}
