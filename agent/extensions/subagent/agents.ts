/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/**
	 * LOCAL PATCH #7 (pi_config #551, ADR-0091): optional `guard-profile`
	 * frontmatter. The only recognized value is "report-only"; the spawn path
	 * exports it to the child as PI_GUARD_PROFILE so bash-destructive-guard
	 * enforces the wrapper's report-only contract mechanically.
	 */
	guardProfile?: string;
	/**
	 * LOCAL PATCH #11 (pi_config #606): opt-in strict env sanitization.
	 * `env-strict: true` frontmatter spawns the child with the allowlist-only
	 * mode of buildSanitizedEnv; `env-allow` (comma-separated exact keys) and
	 * `env-allow-prefix` (comma-separated prefixes) extend the base allowlist
	 * per wrapper. Absent keys keep the default passthrough-with-denies mode,
	 * so third-party drop-in wrappers are unaffected.
	 */
	envStrict?: boolean;
	envAllow?: string[];
	envAllowPrefixes?: string[];
	/**
	 * LOCAL PATCH #12 (pi_config #685, ADR-0094): per-agent local-LLM
	 * permission. `local-llm: true` frontmatter declares the wrapper MAY run
	 * on a local model when the global localLlm.role lever is "full" and the
	 * wrapper is not structurally local-forbidden (bash-capable/unrestricted
	 * tools). Default false — untagged (incl. third-party) wrappers never
	 * ride local. The concrete model is always the provider matrix's pick,
	 * never a hardcoded default.
	 */
	localLlm?: boolean;
	/**
	 * LOCAL PATCH #13 (pi_config #656): quality floor for model selection.
	 * `capability-tier: frontier|capable|fast` frontmatter asks the provider
	 * matrix for the highest-quality credentialed model at or above the tier
	 * (quality-first — cost drops out). Replaces exact cloud `model:` pins in
	 * first-party wrappers; the pin remains only as a documented escape hatch.
	 */
	capabilityTier?: "frontier" | "capable" | "fast";
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/**
	 * LOCAL PATCH #10 (pi_config #671, ADR-0093): name collisions where a
	 * project-scoped wrapper would weaken a guard-profiled user wrapper —
	 * by omitting/changing the profile or by widening its tools set. The
	 * spawn gate in index.ts fails closed on these (evaluateShadowGate).
	 */
	shadowedProfiledAgents: ProfiledShadow[];
}

/**
 * LOCAL PATCH #10 (pi_config #671, ADR-0093): a project wrapper shadowing a
 * guard-profiled user wrapper in a way that would weaken enforcement.
 */
export interface ProfiledShadow {
	name: string;
	/** The user wrapper's declared guard-profile (inherited on an approved shadow). */
	userProfile: string;
	/** True when the project wrapper omits or changes the user wrapper's guard-profile. */
	weakensProfile: boolean;
	/** True when the project wrapper's tools are not a subset of the user wrapper's. */
	widensTools: boolean;
	userTools?: string[];
	projectTools?: string[];
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		// LOCAL PATCH #11 (pi_config #606): comma-list frontmatter helper for
		// the env-allow keys, mirroring the tools parsing above. The parser
		// YAML-types scalar values (booleans arrive as booleans, not strings),
		// so both helpers must be type-tolerant rather than assume string.
		const parseList = (value: unknown): string[] | undefined => {
			if (typeof value !== "string") return undefined;
			const items = value
				.split(",")
				.map((v: string) => v.trim())
				.filter(Boolean);
			return items.length > 0 ? items : undefined;
		};
		const envStrictRaw: unknown = frontmatter["env-strict"];
		const envStrict =
			envStrictRaw === true || (typeof envStrictRaw === "string" && envStrictRaw.trim() === "true");
		// LOCAL PATCH #12 (pi_config #685): same literal-true-only posture.
		const localLlmRaw: unknown = frontmatter["local-llm"];
		const localLlm =
			localLlmRaw === true || (typeof localLlmRaw === "string" && localLlmRaw.trim() === "true");
		// LOCAL PATCH #13 (pi_config #656): exact-value-only tier; typos yield
		// no tier (untiered cheapest-capable selection) rather than a guess.
		const tierRaw: unknown = frontmatter["capability-tier"];
		const tierTrimmed = typeof tierRaw === "string" ? tierRaw.trim() : undefined;
		const capabilityTier =
			tierTrimmed === "frontier" || tierTrimmed === "capable" || tierTrimmed === "fast"
				? tierTrimmed
				: undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			// LOCAL PATCH #7 (pi_config #551): guard-profile passthrough.
			guardProfile: frontmatter["guard-profile"]?.trim() || undefined,
			// LOCAL PATCH #11 (pi_config #606): strict-env opt-in. Only a
			// literal `true` (YAML boolean or the string "true") enables strict
			// mode — any other value keeps the safe default, same fail-safe
			// posture as the guard-profile typo handling (an unrecognized value
			// must not half-arm anything).
			envStrict: envStrict || undefined,
			envAllow: parseList(frontmatter["env-allow"]),
			envAllowPrefixes: parseList(frontmatter["env-allow-prefix"]),
			// LOCAL PATCH #12 (pi_config #685, ADR-0094): local-LLM permission tag.
			localLlm: localLlm || undefined,
			// LOCAL PATCH #13 (pi_config #656): capability-tier quality floor.
			capabilityTier,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// LOCAL PATCH #10 (pi_config #671, ADR-0093): true when the project wrapper
// grants any tool the user wrapper does not. `undefined` tools means the
// wrapper is unrestricted (no --tools flag on the child), so an unrestricted
// project wrapper always widens a restricted user wrapper.
function widensToolSurface(userTools: string[] | undefined, projectTools: string[] | undefined): boolean {
	if (!userTools) return false;
	if (!projectTools) return true;
	const allowed = new Set(userTools);
	return projectTools.some((t) => !allowed.has(t));
}

// LOCAL PATCH #10 (pi_config #671, ADR-0093): collision scan. Only wrappers
// whose user-level counterpart declares a guard-profile are considered —
// ordinary project-agent overrides of unprofiled names are untouched.
function detectProfiledShadows(userAgents: AgentConfig[], projectAgents: AgentConfig[]): ProfiledShadow[] {
	const shadows: ProfiledShadow[] = [];
	const userByName = new Map(userAgents.map((a) => [a.name, a]));
	for (const project of projectAgents) {
		const user = userByName.get(project.name);
		if (!user?.guardProfile) continue;
		const weakensProfile = project.guardProfile !== user.guardProfile;
		const widensTools = widensToolSurface(user.tools, project.tools);
		if (!weakensProfile && !widensTools) continue;
		shadows.push({
			name: project.name,
			userProfile: user.guardProfile,
			weakensProfile,
			widensTools,
			userTools: user.tools,
			projectTools: project.tools,
		});
	}
	return shadows;
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// LOCAL PATCH #10 (pi_config #671, ADR-0093): under scope "project" the
	// user catalog is not part of the result, but it is still probed here
	// (detection-only) — otherwise a project-only invocation of a profiled
	// name (e.g. "linter") never collides with anything and escapes the gate.
	const detectionUserAgents =
		scope === "project" && projectAgents.length > 0 ? loadAgentsFromDir(userDir, "user") : userAgents;
	const shadowedProfiledAgents = detectProfiledShadows(detectionUserAgents, projectAgents);

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir, shadowedProfiledAgents };
}

/**
 * LOCAL PATCH #10 (pi_config #671, ADR-0093): fail-closed gate decision for
 * guard-profile shadowing. Pure so the policy is unit-testable without a
 * spawn harness. Deliberately independent of the caller-controlled
 * `confirmProjectAgents` parameter — the invoking model can set that flag,
 * so it cannot be part of this trust boundary.
 *
 *  - Tool-surface widening of a profiled wrapper is refused outright (the
 *    report-only guard only gates bash argv; added structured tools like
 *    write/edit would bypass it entirely, so no confirmation can make the
 *    shadow safe).
 *  - A profile-weakening (but non-widening) shadow requires an interactive
 *    confirmation; headless sessions refuse. On approval the caller must
 *    inherit `userProfile` onto the project agent (strongest-wins).
 */
export type ShadowGateDecision =
	| { action: "allow" }
	| { action: "refuse"; reason: string }
	| { action: "confirm"; shadows: ProfiledShadow[]; message: string };

export function evaluateShadowGate(
	shadows: ProfiledShadow[],
	requestedAgentNames: ReadonlySet<string>,
	hasUI: boolean,
): ShadowGateDecision {
	const requested = shadows.filter((s) => requestedAgentNames.has(s.name));
	if (requested.length === 0) return { action: "allow" };

	const widening = requested.filter((s) => s.widensTools);
	if (widening.length > 0) {
		const detail = widening
			.map(
				(s) =>
					`"${s.name}" (user tools: ${s.userTools?.join(", ") ?? "unrestricted"}; project tools: ${s.projectTools?.join(", ") ?? "unrestricted"})`,
			)
			.join("; ");
		return {
			action: "refuse",
			reason: `Refused: project-local agent(s) would widen the tool surface of a guard-profiled user wrapper: ${detail}. Narrow the project wrapper's tools to a subset of the user wrapper's, or rename it.`,
		};
	}

	if (!hasUI) {
		const names = requested.map((s) => `"${s.name}"`).join(", ");
		return {
			action: "refuse",
			reason: `Refused: project-local agent(s) ${names} shadow a guard-profiled user wrapper and would disable its guard profile. This session cannot confirm interactively; run with a UI to approve, or remove/rename the project wrapper.`,
		};
	}

	const lines = requested.map(
		(s) => `- "${s.name}": user wrapper declares guard-profile: ${s.userProfile}; the project wrapper does not`,
	);
	return {
		action: "confirm",
		shadows: requested,
		message: `The following project-local agent(s) shadow guard-profiled user wrappers and would DISABLE mechanical guard enforcement:\n${lines.join("\n")}\n\nIf you continue, the user wrapper's guard profile will be enforced on the project agent anyway. Only continue for trusted repositories.`,
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
