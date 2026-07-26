/**
 * subagent/policy-model.ts — spawn-time model policy for unpinned wrappers.
 *
 * Extracted from the patch-tracked index.ts (same first-party-sibling pattern
 * as model-pin.ts) so the policy seam is unit-testable and the vendored diff
 * stays small. Combines two decision layers:
 *
 *   - ADR-0090: per-agent local eligibility has a structural floor — a
 *     bash-capable or tools-unrestricted wrapper is local-forbidden
 *     regardless of anything else (the #535/ADR-0082 discipline finding).
 *   - ADR-0094 (#685): the capability-driven composition on top —
 *       lever (global localLlm.role, shared/local-role.ts)
 *       → `local-llm: true` wrapper tag (per-agent permission, default false)
 *       → provider matrix (concrete provider/id via resolveCapabilityPick).
 *     There is no hardcoded local default model anymore: a local-eligible
 *     agent gets local only because the matrix lists a capable local row,
 *     which wins its capable set on cost-rank (local is zero-cost).
 *
 * Explicit wrapper `model:` pins bypass this seam entirely (the documented
 * escape hatch); a LOCAL pin is still subject to the lever via the
 * model-pin.ts applyLocalRole backstop, not here.
 */

import type { Candidate } from "../shared/candidates.ts";
import { isLocalProvider, type LocalRole } from "../shared/local-role.ts";
import { resolveCapabilityPick, resolveTierPick } from "../shared/model-ranking.ts";
import type { RoutingMatrix } from "../shared/routing-matrix.ts";
import type { ModelDenyView } from "../shared/session-unavailable.ts";
import type { AgentConfig } from "./agents.ts";

/** Matrix task-type label subagent child processes are ranked under. */
export const SUBAGENT_PROVIDER_TASK_TYPE = "agentic-loop";

function candidateKey(c: Candidate): string {
	return `${c.provider}/${c.id}`;
}

/**
 * Structural local-eligibility floor (ADR-0090/ADR-0082): omitted tools means
 * pi's default tool set applies — treat as local-forbidden because defaults
 * can include mutation-capable tools. The `local-llm` tag can never override
 * this (ADR-0094 pushback #1).
 */
export function isLocalForbiddenAgent(agent: AgentConfig): boolean {
	return agent.tools === undefined || agent.tools.includes("bash");
}

export type SubagentPolicySelection =
	| { model: string; note: string }
	| { blockedReason: string };

export function selectSubagentPolicyModel(
	agent: AgentConfig,
	candidates: readonly Candidate[],
	matrix: RoutingMatrix | null,
	localRole: LocalRole,
	unavailable: ModelDenyView = new Set<string>(),
): SubagentPolicySelection | null {
	// Explicit wrapper pins remain authoritative; this seam covers unpinned
	// wrappers and project-local agents so the parent chooses a concrete child
	// model before spawn and keeps child auto-router processes inert.
	if (agent.model) return null;

	// ADR-0094: eligibility = global lever full ∧ wrapper opted in ∧ not
	// structurally forbidden. Children never run the classifier side-call, so
	// "classifier-only" and "off" are equivalent here.
	const localEligible = localRole === "full" && agent.localLlm === true && !isLocalForbiddenAgent(agent);
	const pool = localEligible ? candidates : candidates.filter((c) => !isLocalProvider(c.provider));

	// #656: a declared capability tier is a quality floor — the matrix's
	// highest-tier credentialed pick wins, cost dropping out. Falls through
	// to the untiered cheapest-capable path when no tiered row qualifies.
	if (agent.capabilityTier) {
		const tierPick = resolveTierPick(pool, agent.capabilityTier, SUBAGENT_PROVIDER_TASK_TYPE, matrix, unavailable);
		if (tierPick) {
			return {
				model: candidateKey(tierPick),
				note: `subagent policy selected ${candidateKey(tierPick)} from the provider matrix (tier ${agent.capabilityTier})`,
			};
		}
	}

	const pick = resolveCapabilityPick(pool, SUBAGENT_PROVIDER_TASK_TYPE, matrix, unavailable, null, {
		preferLocal: localEligible,
	});
	if (pick) {
		return {
			model: candidateKey(pick),
			note: `subagent policy selected ${candidateKey(pick)} from the provider matrix`,
		};
	}

	if (isLocalForbiddenAgent(agent)) {
		return {
			blockedReason:
				"local-forbidden subagent has no non-local provider matrix pick; refusing to inherit a possibly-local session model",
		};
	}
	// No matrix pick for a non-forbidden agent: fall through to the session
	// default (the child's own settings), never to a hardcoded local model.
	return null;
}
