/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, CONFIG_DIR_NAME, getAgentDir, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	availabilityEvidenceSet,
	clearAvailabilitySnapshot,
	getAvailabilitySnapshot,
	type AvailabilitySnapshotContext,
} from "../shared/availability-snapshot.ts";
import { clearAnthropicCache } from "../shared/anthropic-discovery.ts";
import type { Candidate } from "../shared/candidates.ts";
import { clearCopilotCache } from "../shared/copilot-discovery.ts";
import { readLocalRole, type LocalRole } from "../shared/local-role.ts";
import { clearOmlxCache } from "../shared/omlx-discovery.ts";
import { loadRoutingMatrix, type RoutingMatrix } from "../shared/routing-matrix.ts";
import {
	clearSessionUnavailable,
	isProviderRateLimited,
	markSessionUnavailable,
	providerOf,
	sessionDeny,
} from "../shared/session-unavailable.ts";
import { type AgentConfig, type AgentScope, discoverAgents, evaluateShadowGate } from "./agents.ts";
import { selectSubagentPolicyModel } from "./policy-model.ts";
import {
	collectCoalescedExpertise,
	buildInjectedTaskArg,
	extractExpertiseFromChildOutput,
	type ExtractedExpertise,
} from "./expertise-wiring.ts";
import {
	applyLocalRole,
	resolveModelPin,
	sanitizeFallbackModelId,
	type CopilotFallback,
} from "./model-pin.ts";
import { buildChildEnv, readSpawnDepth } from "./sanitize-env.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatAgentModelLabel(result: { agent: string; model?: string; exitCode?: number }): string {
	if (result.model) return `${result.agent} · ${result.model}`;
	return result.exitCode === -1 ? `${result.agent} · model pending` : result.agent;
}

function formatRuntimeFailover(details: RuntimeFailoverDetails | undefined): string | undefined {
	if (!details) return undefined;
	const path = details.attemptedModels.join(" → ");
	switch (details.outcome) {
		case "succeeded":
			return `runtime failover succeeded: ${path}`;
		case "fallback-failed":
			return `runtime failover failed: ${path}`;
		case "no-alternate":
			return `runtime failover unavailable: ${path} → no eligible alternate`;
		case "provider-breaker":
			return `runtime failover unavailable: ${path} → provider disabled for this session`;
		case "not-retried-after-tool":
			return `runtime failover refused after tool execution: ${path}`;
	}
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type RuntimeFailoverOutcome =
	| "succeeded"
	| "fallback-failed"
	| "no-alternate"
	// ADR-0126 (#903): reselection found no alternate specifically because the
	// failed model's provider breaker tripped — distinct from a plain
	// no-alternate (matrix coverage gap), and actionable via /auto providers.
	| "provider-breaker"
	| "not-retried-after-tool";

interface RuntimeFailoverDetails {
	attemptedModels: string[];
	failedModel: string;
	fallbackModel?: string;
	outcome: RuntimeFailoverOutcome;
	snapshotGeneration?: number;
	snapshotHash?: string;
}

/** Provider id of the ADR-0080 Copilot fallback rung (#903). */
const COPILOT_PROVIDER = "github-copilot";

/**
 * LOCAL PATCH #19 (pi_config #903, ADR-0126): classify why ADR-0122 reselection
 * came back empty. "The matrix has no other capable row" and "the failed
 * model's provider is disabled for this session" are the same terminal state
 * but call for completely different operator action, so the telemetry names
 * which one happened rather than reporting a bare no-alternate.
 */
function failoverExhausted(failedModel: string | undefined): {
	outcome: "no-alternate" | "provider-breaker";
	detail: string;
} {
	const provider = failedModel ? providerOf(failedModel) : "";
	const record = provider ? sessionDeny.providerRecord(provider) : null;
	if (!record) return { outcome: "no-alternate", detail: "no eligible alternate model" };
	return {
		outcome: "provider-breaker",
		detail: `no eligible alternate model — provider "${provider}" is disabled for this session (${record.source}: ${record.reason}); re-enable it with \`/auto providers enable ${provider}\``,
	};
}

interface RuntimeFailoverState {
	attemptedModels: string[];
	priorUsage: UsageStats;
}

interface SnapshotIdentity {
	generation: number;
	hash: string;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Set when a frontmatter model pin was omitted by the spawn-time gate (#519). */
	pinNote?: string;
	/** Bounded runtime provider failover telemetry (#868). */
	failover?: RuntimeFailoverDetails;
	/**
	 * LOCAL PATCH #6 (pi_config #611, epic #595): Form B expertise
	 * candidates extracted from this child's assistant output. Absent
	 * when the child produced no `EXPERTISE_CANDIDATES` blocks (the
	 * common case). Coalesced across children in the mode finalizer.
	 */
	extractedExpertisePayloads?: ExtractedExpertise;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	/**
	 * LOCAL PATCH #6 (pi_config #611): coalesced expertise candidates
	 * across all children in this fanout. Absent when no child
	 * produced any candidates. Downstream approval (#605) reads this
	 * envelope to drive the human-in-the-loop `expertise_create` flow;
	 * per the SECURITY invariant on `CoalescedGroup.candidate`, the
	 * approval UI MUST enforce per-proposer body inspection when a
	 * group carries `bodyHashesByProposer` (variantCount > 1).
	 */
	expertiseCandidates?: ReturnType<typeof collectCoalescedExpertise>;
}

function addUsage(target: UsageStats, prior: UsageStats): void {
	target.input += prior.input;
	target.output += prior.output;
	target.cacheRead += prior.cacheRead;
	target.cacheWrite += prior.cacheWrite;
	target.cost += prior.cost;
	target.contextTokens = Math.max(target.contextTokens, prior.contextTokens);
	target.turns += prior.turns;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	// Truncate on the UTF-8 byte buffer directly (#793): the previous
	// one-code-unit-at-a-time shrink loop recomputed byteLength over the
	// whole string per iteration — quadratic on multi-byte-heavy output.
	// toString() replaces a split trailing multi-byte character with U+FFFD;
	// strip it so the marker text follows a clean boundary.
	const truncated = Buffer.from(output, "utf8")
		.subarray(0, PER_TASK_OUTPUT_CAP)
		.toString("utf8")
		.replace(/\uFFFD+$/u, "");
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Built-in Copilot fallback rung target (#536, ADR-0080): the cheapest
 * generally-available Copilot chat model under the June-2026 AI-Credits
 * billing (~an order of magnitude fewer credits per child than the
 * Sonnet/Opus tiers). Overridable per operator — see readFallbackModelSetting.
 */
const DEFAULT_COPILOT_FALLBACK = "github-copilot/gpt-5-mini";

/**
 * Read the USER-layer `extensionSettings.subagent.copilotFallbackModel`
 * override (#536). Project-layer settings are deliberately not consulted —
 * same trust boundary as token-meter (ADR-0073): a hostile repo must not be
 * able to redirect fan-out spend. Any read/parse error or a value that is not
 * a qualified `github-copilot/<id>` string falls back to the built-in default.
 */
async function readFallbackModelSetting(): Promise<string> {
	try {
		// getAgentDir() honors PI_CODING_AGENT_DIR (#793) — the hand-rolled
		// homedir join here previously ignored the override for this one read.
		const p = path.join(getAgentDir(), "settings.json");
		const j = JSON.parse(await fs.promises.readFile(p, "utf8")) as {
			extensionSettings?: { subagent?: { copilotFallbackModel?: unknown } };
		};
		return (
			sanitizeFallbackModelId(j?.extensionSettings?.subagent?.copilotFallbackModel) ??
			DEFAULT_COPILOT_FALLBACK
		);
	} catch {
		return DEFAULT_COPILOT_FALLBACK;
	}
}

/**
 * Spawn-depth ceiling (pi_config #841, ADR-0118): how deep the subagent
 * tree may grow. Depth 0 is the orchestrator; the default of 1 means
 * children exist but cannot fan out grandchildren — the mechanical twin of
 * the orchestrator-protocol "do not spawn additional agents on your own
 * initiative" obligation.
 */
const DEFAULT_MAX_SPAWN_DEPTH = 1;
const MAX_SPAWN_DEPTH_CEILING = 5;

/**
 * Read the USER-layer `extensionSettings.subagent.maxSpawnDepth` override
 * (#841). Project-layer settings are deliberately not consulted — same
 * trust boundary as readFallbackModelSetting (ADR-0073): a hostile repo
 * must not be able to deepen the fan-out tree. Only integers in
 * [1, MAX_SPAWN_DEPTH_CEILING] are honored; anything else falls back to
 * the built-in default.
 */
async function readMaxDepthSetting(): Promise<number> {
	try {
		const p = path.join(getAgentDir(), "settings.json");
		const j = JSON.parse(await fs.promises.readFile(p, "utf8")) as {
			extensionSettings?: { subagent?: { maxSpawnDepth?: unknown } };
		};
		const v = j?.extensionSettings?.subagent?.maxSpawnDepth;
		if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_SPAWN_DEPTH_CEILING) {
			return v;
		}
		return DEFAULT_MAX_SPAWN_DEPTH;
	} catch {
		return DEFAULT_MAX_SPAWN_DEPTH;
	}
}

/**
 * Build the Copilot fallback rung from the same frozen availability generation
 * used for provider-matrix selection. A registry/snapshot failure (`null`)
 * keeps the historical fail-open pin behavior.
 *
 * Deliberately breaker-FREE: this runs once per tool call, before any child
 * spawns, so a breaker state captured here would go stale the moment a child
 * tripped one mid-fan-out. {@link liveCopilotRung} re-derives that at the point
 * of use instead.
 */
async function buildCopilotFallback(
	availableModelIds: ReadonlySet<string> | null,
	registryModelIds: ReadonlySet<string> | null,
	liveEnabledIds: ReadonlySet<string> | null,
): Promise<CopilotFallback | undefined> {
	if (availableModelIds === null || registryModelIds === null) return undefined;
	const modelId = await readFallbackModelSetting();
	return { modelId, liveEnabledIds, registryAvailable: registryModelIds.has(modelId) };
}

/**
 * LOCAL PATCH #19 (pi_config #903, ADR-0126): stamp the rung with the CURRENT
 * breaker state, read at spawn time rather than at fan-out setup.
 *
 * The staleness this closes is not hypothetical: `buildCopilotFallback` is
 * called once per tool call (before the parallel wave starts), so a breaker
 * that trips partway through a fan-out — say child 1 auto-escalating on its
 * second rate-limited model — would leave children 2..N consulting a rung the
 * breaker had already excluded, substituting a dead Copilot model and burning
 * exactly the quota this arc exists to protect.
 *
 * Carried through as DISABLED rather than dropped: returning `undefined` would
 * be indistinguishable from "no registry data" and would silently degrade a
 * dropped pin to the session default with no explanation.
 */
function liveCopilotRung(fallback: CopilotFallback | undefined): CopilotFallback | undefined {
	if (!fallback) return undefined;
	const breaker = sessionDeny.providerRecord(COPILOT_PROVIDER);
	if (!breaker) return fallback;
	return { ...fallback, disabledReason: `provider breaker: ${breaker.source}, ${breaker.reason}` };
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	availableModelIds: ReadonlySet<string> | null,
	copilotFallback: CopilotFallback | undefined,
	servedOmlxIds: ReadonlySet<string> | null,
	policyCandidates: readonly Candidate[],
	policyMatrix: RoutingMatrix | null,
	localRole: LocalRole,
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	expertiseInjection?: string,
	snapshotIdentity?: SnapshotIdentity,
	failoverState?: RuntimeFailoverState,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const policyModel = selectSubagentPolicyModel(
		agent,
		policyCandidates,
		policyMatrix,
		localRole,
		sessionDeny,
	);
	if (policyModel && "blockedReason" in policyModel) {
		const exhausted = failoverExhausted(failoverState?.attemptedModels[0]);
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: failoverState
				? `runtime failover stopped after ${failoverState.attemptedModels[0]}: ${policyModel.blockedReason}`
				: policyModel.blockedReason,
			usage: failoverState
				? { ...failoverState.priorUsage }
				: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			stopReason: "policy-blocked",
			step,
			...(failoverState
				? {
						pinNote: `runtime failover stopped after ${failoverState.attemptedModels[0]}: ${exhausted.detail}`,
						failover: {
							attemptedModels: failoverState.attemptedModels,
							failedModel: failoverState.attemptedModels[0],
							outcome: exhausted.outcome,
							...(snapshotIdentity ? { snapshotGeneration: snapshotIdentity.generation } : {}),
							...(snapshotIdentity ? { snapshotHash: snapshotIdentity.hash } : {}),
						},
					}
				: {}),
		};
	}
	if (failoverState && !policyModel) {
		const exhausted = failoverExhausted(failoverState.attemptedModels[0]);
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: `runtime failover stopped after ${failoverState.attemptedModels[0]}: ${exhausted.detail}`,
			usage: { ...failoverState.priorUsage },
			stopReason: "policy-blocked",
			pinNote: `runtime failover stopped after ${failoverState.attemptedModels[0]}: ${exhausted.detail}`,
			failover: {
				attemptedModels: failoverState.attemptedModels,
				failedModel: failoverState.attemptedModels[0],
				outcome: exhausted.outcome,
				...(snapshotIdentity ? { snapshotGeneration: snapshotIdentity.generation } : {}),
				...(snapshotIdentity ? { snapshotHash: snapshotIdentity.hash } : {}),
			},
			step,
		};
	}
	const policySelectedModel = policyModel?.model;
	const requestedModel = policySelectedModel ?? agent.model;

	// ADR-0094 backstop: the lever drops a LOCAL requested model (a wrapper
	// `model: omlx/…` pin — the policy seam already respects the lever) before
	// the pin gate, regardless of registry/liveness state. Visible via a note.
	const roleGate = applyLocalRole(requestedModel, availableModelIds, localRole);

	// LOCAL PATCH #19 (pi_config #903, ADR-0126): an explicit wrapper `model:`
	// pin naming a provider whose session breaker is tripped fails CLOSED —
	// spawning it would burn a child on a provider the operator (or accumulated
	// quota evidence) already took out of service, and silently substituting a
	// different model would violate the pin.
	//
	// Deliberately PROVIDER scope only. ADR-0122 decided explicit pins remain
	// authoritative and return their own failure; that stands for model-scope
	// denies. A provider breaker is a different claim — "nothing from here works
	// this session" — and is operator-reversible via /auto providers enable.
	//
	// Evaluated AFTER applyLocalRole so a pin the lever already neutralized is
	// not reported as breaker-refused; and only for `agent.model`, since a
	// policy-selected model can never come from a denied provider (the policy
	// seam filters on the same state). The two are mutually exclusive:
	// selectSubagentPolicyModel returns null whenever `agent.model` is set.
	const explicitPin = agent.model !== undefined ? roleGate.requestedModel : undefined;
	const pinnedProvider = explicitPin ? providerOf(explicitPin) : "";
	const pinBreaker = pinnedProvider ? sessionDeny.providerRecord(pinnedProvider) : null;
	if (explicitPin && pinBreaker) {
		const detail = `model pin "${explicitPin}" refused: provider "${pinnedProvider}" is disabled for this session (${pinBreaker.source}: ${pinBreaker.reason}, ${pinBreaker.at})`;
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: `${detail}. Re-enable it with \`/auto providers enable ${pinnedProvider}\`, or change the wrapper pin.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			stopReason: "policy-blocked",
			pinNote: detail,
			step,
		};
	}

	// Spawn-time pin gate (#519): a slash-qualified pin only reaches argv when
	// its exact provider/id is credentialed here — pi hard-exits a child whose
	// --model names an unregistered provider (e.g. omlx on a host without the
	// operator-local models.json block). `availableModelIds` is already narrowed
	// by the oMLX liveness probe (#534): a registered-but-down workhorse pin is
	// absent here and takes the drop path. A dropped non-Copilot pin tries the
	// Copilot fallback rung (#536, ADR-0080) before the session default;
	// `servedOmlxIds` only shapes the note wording (server-down vs not-installed).
	// LOCAL PATCH #19: `liveCopilotRung` re-reads the breaker HERE, per spawn —
	// see its doc comment for the mid-fan-out staleness that closes.
	const pin = resolveModelPin(
		roleGate.requestedModel,
		roleGate.availableIds,
		liveCopilotRung(copilotFallback),
		servedOmlxIds,
	);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (pin.modelArg) args.push("--model", pin.modelArg);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	// LOCAL PATCH #18 (pi_config #889, ADR-0124): default-suppress context-file
	// injection in children. Without this flag every spawn cold-prefills the
	// global AGENTS.md orchestration playbook + project CLAUDE.md (~9K tokens)
	// that leaf subagents are forbidden to act on anyway — the dominant driver
	// of the oMLX Memory Guard fan-out collapse (local-llm ADR-010). Only an
	// explicit `context-files: inherit` wrapper opts back in. Deliberately NOT
	// conditioned on the resolved model: per-wrapper-static argv keeps a
	// wrapper's prefill byte-identical across routing/failover outcomes.
	if (agent.contextFiles !== "inherit") args.push("--no-context-files");

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		// -1 = still running, same sentinel parallel mode uses (#793): 0 was
		// indistinguishable from "exited successfully" while streaming.
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		// When the pin was omitted, leave model unset so the child's actual
		// model (from its message events) fills it in — honest reporting.
		...(pin.modelArg ? { model: pin.modelArg } : {}),
		...(pin.note || policyModel?.note || roleGate.note
			? {
					pinNote: [policyModel?.note, roleGate.note, pin.note]
						.filter((v): v is string => Boolean(v))
						.join("; "),
				}
			: {}),
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	// LOCAL PATCH #7b (pi_config #643): emit once at the moment of invocation so
	// the resolved child model is visible immediately, not only in the completion
	// footer. `currentResult.model` is already seeded from the spawn-time pin
	// (pin.modelArg) above, so a pinned / fallback-resolved child renders its
	// model in the streaming footer at spawn; an unpinned child (no --model,
	// inherits the session model) fills the field in from its first message_end
	// as before. This reads currentResult.messages only — it never mutates the
	// accumulation getFinalOutput consumes, so the final output is unaffected.
	emitUpdate();

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// LOCAL PATCH #6 (pi_config #611, epic #595): prepend the optional
		// canonical-expertise block to the user-role Task: framing. Kept
		// on the user-role side per no-mcp-servers.md; never injected via
		// --append-system-prompt.
		args.push(buildInjectedTaskArg(task, expertiseInjection));
		let wasAborted = false;
		let sawToolExecution = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			// LOCAL PATCH #5 (pi_config issue #596, epic #595): sanitize the child
			// env so `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE` never reaches a spawned
			// subagent — enforces the ADR-0028 "orchestrator-only
			// expertise_create" trust boundary structurally rather than by
			// convention. Default mode is passthrough-with-explicit-denies.
			// LOCAL PATCH #7a (pi_config #551, ADR-0091): guard-profile signal —
			// set-or-delete semantics live in applyGuardProfile (sanitize-env.ts).
			// LOCAL PATCH #11 (pi_config #606): per-wrapper strict allowlist mode
			// via `env-strict`/`env-allow`/`env-allow-prefix` frontmatter; the
			// translation is composed in buildChildEnv (sanitize-env.ts).
			const childEnv = buildChildEnv(process.env, agent);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				// LOCAL PATCH #3 (pi_config issue #46, expanded in #396): the upstream
				// 0.80.2 snapshot still listens for `tool_result_end` with
				// `event.message`, but pi 0.80.2 does NOT emit that event — confirmed
				// against `pi/docs/rpc.md` § 855–898 and `pi/docs/extensions.md` §
				// 596–615, which document `tool_execution_start` /
				// `tool_execution_update` / `tool_execution_end` (+ `tool_result` as a
				// separate middleware event, not consumed here). We trigger UI
				// refresh on all three tool-execution edges so the orchestrator sees
				// per-tool-call progress during long child runs, without injecting
				// synthetic messages into `currentResult.messages` (which would
				// corrupt `getFinalOutput`). Consuming `tool_execution_update`
				// closes pi_config #46 — the partialResult on those events is the
				// accumulated tool output; surfacing it in the details table is a
				// future concern tracked separately.
				if (
					event.type === "tool_execution_start" ||
					event.type === "tool_execution_update" ||
					event.type === "tool_execution_end"
				) {
					sawToolExecution = true;
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");

		// LOCAL PATCH #17 (#868): one bounded runtime failover for an unpinned,
		// policy-selected child that reports a structured provider-rate-limit
		// error before any tool edge. Never replay after tools, for explicit pins,
		// session-default children, stderr-only failures, or generic errors.
		const policyRateLimited =
			Boolean(policySelectedModel) &&
			currentResult.stopReason === "error" &&
			isProviderRateLimited(currentResult.errorMessage);
		if (policyRateLimited && policySelectedModel) {
			// A malformed registry key cannot be excluded deterministically; refuse
			// retry rather than risk selecting and misreporting the same model.
			if (!markSessionUnavailable(policySelectedModel)) return currentResult;
			const attemptedModels = [...(failoverState?.attemptedModels ?? []), policySelectedModel];

			if (failoverState) {
				addUsage(currentResult.usage, failoverState.priorUsage);
				currentResult.pinNote = [
					currentResult.pinNote,
					`runtime failover: ${failoverState.attemptedModels[0]} rate-limited before tools; fallback ${policySelectedModel} also failed`,
				]
					.filter((value): value is string => Boolean(value))
					.join("; ");
				currentResult.failover = {
					attemptedModels,
					failedModel: failoverState.attemptedModels[0],
					fallbackModel: policySelectedModel,
					outcome: "fallback-failed",
					...(snapshotIdentity ? { snapshotGeneration: snapshotIdentity.generation } : {}),
					...(snapshotIdentity ? { snapshotHash: snapshotIdentity.hash } : {}),
				};
				return currentResult;
			}

			if (sawToolExecution) {
				currentResult.pinNote = [
					currentResult.pinNote,
					`runtime failover refused for ${policySelectedModel}: child emitted a tool event before the rate-limit error`,
				]
					.filter((value): value is string => Boolean(value))
					.join("; ");
				currentResult.failover = {
					attemptedModels,
					failedModel: policySelectedModel,
					outcome: "not-retried-after-tool",
					...(snapshotIdentity ? { snapshotGeneration: snapshotIdentity.generation } : {}),
					...(snapshotIdentity ? { snapshotHash: snapshotIdentity.hash } : {}),
				};
				return currentResult;
			}

			return runSingleAgent(
				defaultCwd,
				agents,
				availableModelIds,
				copilotFallback,
				servedOmlxIds,
				policyCandidates,
				policyMatrix,
				localRole,
				agentName,
				task,
				cwd,
				step,
				signal,
				onUpdate,
				makeDetails,
				expertiseInjection,
				snapshotIdentity,
				{ attemptedModels, priorUsage: { ...currentResult.usage } },
			);
		}

		if (failoverState && policySelectedModel) {
			addUsage(currentResult.usage, failoverState.priorUsage);
			const attemptedModels = [...failoverState.attemptedModels, policySelectedModel];
			const outcome: RuntimeFailoverOutcome = isFailedResult(currentResult) ? "fallback-failed" : "succeeded";
			currentResult.pinNote = [
				currentResult.pinNote,
				`runtime failover: ${failoverState.attemptedModels[0]} rate-limited before tools; retried once on ${policySelectedModel}${outcome === "succeeded" ? "" : " (failed)"}`,
			]
				.filter((value): value is string => Boolean(value))
				.join("; ");
			currentResult.failover = {
				attemptedModels,
				failedModel: failoverState.attemptedModels[0],
				fallbackModel: policySelectedModel,
				outcome,
				...(snapshotIdentity ? { snapshotGeneration: snapshotIdentity.generation } : {}),
				...(snapshotIdentity ? { snapshotHash: snapshotIdentity.hash } : {}),
			};
		}

		// LOCAL PATCH #6 (pi_config #611): extract Form B EXPERTISE_CANDIDATES
		// payloads from the child's final assistant output. Absent field when
		// no blocks were emitted (the common case).
		const extracted = extractExpertiseFromChildOutput(getFinalOutput(currentResult.messages));
		if (extracted) currentResult.extractedExpertisePayloads = extracted;
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	// LOCAL PATCH #6 (pi_config #611, epic #595): optional canonical-fanout
	// expertise injection. Orchestrator builds the block via
	// `renderCanonicalResultsBlock` from the expertise-indexer collector
	// primitives (#599) and passes it here; the extension prepends it to
	// the child's `Task:` framing in user-role (never --append-system-prompt,
	// per no-mcp-servers.md). Missing/empty string = normal fanout.
	expertiseInjection: Type.Optional(
		Type.String({
			description:
				"Optional canonical-expertise block (pre-built via renderCanonicalResultsBlock) to prepend to the child's task. See ADR-0028 and agent/rules/expertise-canonical-fanout.md.",
		}),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	/** See TaskItem.expertiseInjection. */
	expertiseInjection: Type.Optional(
		Type.String({
			description:
				"Optional canonical-expertise block (pre-built via renderCanonicalResultsBlock) to prepend to the step's task.",
		}),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	/** See TaskItem.expertiseInjection. Applies to single-mode invocations. */
	expertiseInjection: Type.Optional(
		Type.String({
			description:
				"Optional canonical-expertise block (pre-built via renderCanonicalResultsBlock) to prepend to the task (single mode).",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// Keep the canonical snapshot and all provider discovery caches fresh per
	// session without relying on auto-router being installed.
	pi.on("session_start", () => {
		clearSessionUnavailable();
		clearAvailabilitySnapshot();
		clearCopilotCache();
		clearAnthropicCache();
		clearOmlxCache();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";

			// LOCAL PATCH #15 (pi_config #841, ADR-0118): spawn-depth guard.
			// Refuse before any discovery/spawn work when this process is already
			// at the configured depth — children return findings to their parent
			// instead of fanning out grandchildren (orchestrator-protocol
			// sub-agent obligations, enforced mechanically).
			const spawnDepth = readSpawnDepth(process.env);
			const maxSpawnDepth = await readMaxDepthSetting();
			if (spawnDepth >= maxSpawnDepth) {
				return {
					content: [
						{
							type: "text",
							text:
								`Refused: this process is already a depth-${spawnDepth} subagent and the spawn-depth limit is ${maxSpawnDepth}. ` +
								"Nested fan-out is blocked — return your findings (including any cross-domain concerns) to the parent orchestrator, " +
								"which owns all further delegation. Operators can raise the limit via user-layer " +
								"extensionSettings.subagent.maxSpawnDepth (1-5).",
						},
					],
					details: { mode: "single", agentScope, projectAgentsDir: null, results: [] } satisfies SubagentDetails,
					isError: true,
				};
			}

			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			// One shared, frozen registry + provider-discovery generation feeds the
			// pin gate, fallback rung, and provider-matrix policy. A registry failure
			// keeps qualified pins fail-open and leaves policy candidates empty.
			const snapshot = await getAvailabilitySnapshot(
				ctx as unknown as AvailabilitySnapshotContext,
				signal ? { signal } : {},
			).catch(() => null);
			const snapshotIdentity = snapshot
				? { generation: snapshot.generation, hash: snapshot.hash }
				: undefined;
			const effectiveAvailableIds = snapshot
				? new Set(snapshot.candidates.map((candidate) => `${candidate.provider}/${candidate.id}`))
				: null;
			const registryModelIds = snapshot
				? new Set(snapshot.registryCandidates.map((candidate) => `${candidate.provider}/${candidate.id}`))
				: null;
			const servedOmlxIds = snapshot ? availabilityEvidenceSet(snapshot.filters.omlx) : null;
			const liveCopilotIds = snapshot ? availabilityEvidenceSet(snapshot.filters.copilot) : null;
			const copilotFallback = await buildCopilotFallback(
				effectiveAvailableIds,
				registryModelIds,
				liveCopilotIds,
			);
			const policyCandidates = snapshot?.candidates ?? [];
			const policyMatrix = await loadRoutingMatrix();
			// ADR-0094 (#685): global local-LLM role lever, read per tool call
			// from user-layer settings (shared/local-role.ts). Children never run
			// the classifier, so any restricted value strips local from both the
			// policy pool and the pin path.
			const localRole = await readLocalRole();
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => {
					// LOCAL PATCH #6 (pi_config #611): coalesce Form B expertise
					// candidates across all children. Absent field when none were
					// extracted (the common case) so existing consumers/tests that
					// assert on the details shape are unaffected.
					const expertiseCandidates = collectCoalescedExpertise(results);
					return {
						mode,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results,
						...(expertiseCandidates ? { expertiseCandidates } : {}),
					};
				};

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const requestedAgentNames = new Set<string>();
			if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
			if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
			if (params.agent) requestedAgentNames.add(params.agent);

			// LOCAL PATCH #10 (pi_config #671, ADR-0093): fail-closed gate on
			// project wrappers that shadow a guard-profiled user wrapper.
			// Deliberately NOT gated on params.confirmProjectAgents — that flag
			// is caller-controlled (the invoking model sets it), so it cannot be
			// part of this trust boundary. Widening shadows are refused outright;
			// profile-weakening shadows need an interactive confirm, after which
			// the user wrapper's profile is inherited onto the project agent.
			const gateMode = hasChain ? ("chain" as const) : hasTasks ? ("parallel" as const) : ("single" as const);
			const shadowGate = evaluateShadowGate(
				discovery.shadowedProfiledAgents,
				requestedAgentNames,
				Boolean(ctx.hasUI),
			);
			if (shadowGate.action === "refuse") {
				return {
					content: [{ type: "text", text: shadowGate.reason }],
					details: makeDetails(gateMode)([]),
				};
			}
			if (shadowGate.action === "confirm") {
				const ok = await ctx.ui.confirm("Project agent would disable a guard profile", shadowGate.message);
				if (!ok)
					return {
						content: [{ type: "text", text: "Canceled: guard-profile-shadowing project agents not approved." }],
						details: makeDetails(gateMode)([]),
					};
				for (const shadow of shadowGate.shadows) {
					const target = agents.find((a) => a.name === shadow.name);
					if (target) target.guardProfile = shadow.userProfile;
				}
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						effectiveAvailableIds,
						copilotFallback,
						servedOmlxIds,
						policyCandidates,
						policyMatrix,
						localRole,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						step.expertiseInjection,
						snapshotIdentity,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						const failoverText = formatRuntimeFailover(result.failover);
						return {
							content: [
								{
									type: "text",
									text: `${failoverText ? `[note] ${failoverText}\n\n` : ""}Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				const chainNotes = results
					.filter((r) => r.pinNote)
					.map((r) => `[note] step ${r.step} (${r.agent}): ${r.pinNote}`)
					.join("\n");
				const chainText = getFinalOutput(results[results.length - 1].messages) || "(no output)";
				return {
					content: [{ type: "text", text: chainNotes ? `${chainNotes}\n\n${chainText}` : chainText }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						effectiveAvailableIds,
						copilotFallback,
						servedOmlxIds,
						policyCandidates,
						policyMatrix,
						localRole,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						t.expertiseInjection,
						snapshotIdentity,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					const note = r.pinNote ? `[note] ${r.pinNote}\n\n` : "";
					return `### [${formatAgentModelLabel(r)}] ${status}\n\n${note}${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					effectiveAvailableIds,
					copilotFallback,
					servedOmlxIds,
					policyCandidates,
					policyMatrix,
					localRole,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					params.expertiseInjection,
					snapshotIdentity,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					const failoverText = formatRuntimeFailover(result.failover);
					return {
						content: [
							{
								type: "text",
								text: `${failoverText ? `[note] ${failoverText}\n\n` : ""}Agent ${result.stopReason || "failed"}: ${errorMsg}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				const singleText = getFinalOutput(result.messages) || "(no output)";
				return {
					content: [
						{ type: "text", text: result.pinNote ? `[note] ${result.pinNote}\n\n${singleText}` : singleText },
					],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isRunning = r.exitCode === -1;
				const isError = !isRunning && isFailedResult(r);
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(formatAgentModelLabel(r)))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					const failoverText = formatRuntimeFailover(r.failover);
					if (failoverText) container.addChild(new Text(theme.fg("warning", failoverText), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(formatAgentModelLabel(r)))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const failoverText = formatRuntimeFailover(r.failover);
				if (failoverText) text += `\n${theme.fg("warning", failoverText)}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			// ---------------------------------------------------------------
			// LOCAL PATCH #16 (pi_config #794): shared chain/parallel row
			// rendering. The two multi-result branches previously duplicated
			// ~170 lines of per-row construction (header, Task line, tool-call
			// arrows, final-output markdown, usage footers, totals); the only
			// real differences — row icon, header prefix ("Step N: " vs none),
			// and the collapsed empty-row sentinel — are parameterized here.
			// test/render.test.ts pins the rendered output for both modes,
			// streaming and finished, expanded and collapsed.
			// ---------------------------------------------------------------
			type RowOpts = {
				rowIcon: (r: SingleResult) => string;
				rowPrefix: (r: SingleResult) => string;
				/** Collapsed rows with no display items render this sentinel. */
				emptyText: (r: SingleResult) => string;
			};

			const chainRowOpts: RowOpts = {
				rowIcon: (r) =>
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗"),
				rowPrefix: (r) => `─── Step ${r.step}: `,
				emptyText: () => "(no output)",
			};

			const parallelRowOpts: RowOpts = {
				rowIcon: (r) =>
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓"),
				rowPrefix: () => "─── ",
				emptyText: (r) => (r.exitCode === -1 ? "(running...)" : "(no output)"),
			};

			const appendExpandedRows = (container: Container, results: SingleResult[], opts: RowOpts): void => {
				for (const r of results) {
					const displayItems = getDisplayItems(r.messages);
					const finalOutput = getFinalOutput(r.messages);

					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							`${theme.fg("muted", opts.rowPrefix(r)) + theme.fg("accent", formatAgentModelLabel(r))} ${opts.rowIcon(r)}`,
							0,
							0,
						),
					);
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
					const failoverText = formatRuntimeFailover(r.failover);
					if (failoverText) container.addChild(new Text(theme.fg("warning", failoverText), 0, 0));

					// Show tool calls
					for (const item of displayItems) {
						if (item.type === "toolCall") {
							container.addChild(
								new Text(
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
									0,
									0,
								),
							);
						}
					}

					// Show final output as markdown
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}

					const rowUsage = formatUsageStats(r.usage, r.model);
					if (rowUsage) container.addChild(new Text(theme.fg("dim", rowUsage), 0, 0));
				}
			};

			const renderCollapsedRows = (results: SingleResult[], opts: RowOpts): string => {
				let text = "";
				for (const r of results) {
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", opts.rowPrefix(r))}${theme.fg("accent", formatAgentModelLabel(r))} ${opts.rowIcon(r)}`;
					const failoverText = formatRuntimeFailover(r.failover);
					if (failoverText) text += `\n${theme.fg("warning", failoverText)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", opts.emptyText(r))}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				return text;
			};

			const appendTotals = (container: Container, results: SingleResult[]): void => {
				const usageStr = formatUsageStats(aggregateUsage(results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
			};

			if (details.mode === "chain") {
				const chainRunning = details.results.some((r) => r.exitCode === -1);
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = chainRunning
					? theme.fg("warning", "⏳")
					: successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);
					appendExpandedRows(container, details.results, chainRowOpts);
					appendTotals(container, details.results);
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				text += renderCollapsedRows(details.results, chainRowOpts);
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);
					// A finished run has no exitCode:-1 rows, so the shared icon's
					// running arm is unreachable here — output is byte-identical to
					// the previous ✗/✓-only expanded logic.
					appendExpandedRows(container, details.results, parallelRowOpts);
					appendTotals(container, details.results);
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				text += renderCollapsedRows(details.results, parallelRowOpts);
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
