/**
 * expertise-indexer — deterministic fanout derivation (#613, ADR-0095).
 *
 * Pure functions shared by the runtime trigger (`expertise-fanout-gate`) and
 * the CI audit (#601): given the exact `subagent` tool-call params, derive
 * (a) whether the fanout is "research-shaped", (b) the canonical query
 * inputs, and (c) the canonical-blob inputs that anchor the injection.
 *
 * DETERMINISM CONTRACT: every function here is a pure function of its
 * arguments — no clock, no I/O, no environment reads, no randomness. The CI
 * audit recomputes the expected `canonical_blob_sha` by feeding the SAME
 * derivation the telemetry-recorded task list plus its own git state; any
 * hidden input here would silently break that recomputation.
 *
 * Trigger definition (ADR-0095 — mechanical, no LLM judgment):
 *   - parallel mode only (`params.tasks`), length >= RESEARCH_FANOUT_MIN;
 *   - NOT review-only: at least one requested agent falls outside the static
 *     review-agent set below. A three-way `/review`-style fanout (the repo's
 *     multi-reviewer command shape) is a review, not research — injecting
 *     canonical expertise there would burn rate-limit budget on the wrong
 *     shape.
 *   - Single-agent and chain-mode calls never trigger (accepted gap,
 *     ADR-0095): the rule's own scope is research-classified *fanouts*.
 */

import type { CanonicalInputs } from "./canonicalize.ts";
import type { CanonicalQueryInputs, CanonicalResultEntry } from "./collector.ts";

/** Minimum parallel-task count for a research-shaped fanout (mirrors the
 * divergence minimum in `agent/rules/research-parallelism.md`). */
export const RESEARCH_FANOUT_MIN = 3;

/**
 * Review agents: a fanout composed ENTIRELY of these is a multi-reviewer
 * command (e.g. the three-way `/review` shape), not research. Closed set,
 * maintained by hand — additions are a deliberate policy edit, not inference.
 */
export const REVIEW_ONLY_AGENTS: ReadonlySet<string> = new Set([
	"checkmarx-expert",
	"code-review-expert",
	"linter",
	"security-review-expert",
]);

/** The two fields of a `subagent` parallel-task item the derivation reads. */
export interface FanoutTask {
	readonly agent: string;
	readonly task: string;
}

/**
 * Mechanical research-shape test over the parallel-task list. Pure; the
 * caller (gate hook / audit) extracts the list from the tool-call params.
 */
export function isResearchShapedFanout(tasks: readonly FanoutTask[]): boolean {
	if (tasks.length < RESEARCH_FANOUT_MIN) return false;
	return !tasks.every((t) => REVIEW_ONLY_AGENTS.has(t.agent));
}

/**
 * Canonical query inputs from the fanout, per the fixed template
 * `<domain> <technology> <task-type> <goal/symptom>`:
 *   - domain      — requested agent names, de-duplicated + sorted (each name
 *                   survives `buildCanonicalQuery` normalization as a single
 *                   token, so 3–6 agents cost 3–6 of the 12-token budget);
 *   - taskType    — the literal `research` (the trigger definition IS the
 *                   research classification);
 *   - goalOrSymptom — the FIRST task string as supplied. First-position is
 *                   part of the deterministic contract: re-deriving from the
 *                   same tool call always reads the same task.
 * `technology` is deliberately unset — nothing in the tool call names a
 * technology more reliably than the agent names already do.
 */
export function deriveQueryInputs(tasks: readonly FanoutTask[]): CanonicalQueryInputs {
	const agents = [...new Set(tasks.map((t) => t.agent))].sort();
	return {
		domain: agents.join(" "),
		taskType: "research",
		goalOrSymptom: tasks[0]?.task ?? "",
	};
}

/**
 * The canonical task string for the fanout blob: one line per task in the
 * caller-supplied order, `<agent>: <task>`. Order preservation is deliberate —
 * the blob anchors the exact call, not a normalized bag of tasks.
 */
export function deriveFanoutTaskString(tasks: readonly FanoutTask[]): string {
	return tasks.map((t) => `${t.agent}: ${t.task}`).join("\n");
}

/**
 * Canonical-blob inputs for a runtime fanout. `files` is EMPTY by contract:
 * a live fanout has no changed-set — the anchor is repo@HEAD plus the exact
 * task list. (The #601 CI audit's separate PR-changed-set blob is a different
 * blob for a different purpose; this one is what the injected block and every
 * returned candidate must carry.)
 */
export function deriveFanoutCanonicalInputs(args: {
	readonly repoOrigin: string;
	readonly headSha: string;
	readonly tasks: readonly FanoutTask[];
}): CanonicalInputs {
	return {
		repoOrigin: args.repoOrigin,
		headSha: args.headSha,
		files: [],
		taskString: deriveFanoutTaskString(args.tasks),
		agentFrontmatter: {},
	};
}

/**
 * Project a raw `expertise_search` response body into the injection entry
 * shape. Tolerant by design — the response is loopback-API output, not
 * hostile, but a schema drift must degrade to "fewer results", never throw
 * into the tool_call hook (whose exceptions the pi runtime does NOT catch).
 *
 * Accepts `{"results": [...]}` (the semantic endpoint's envelope) or a bare
 * array. An entry is kept iff every required field is a non-empty string
 * after `String()` coercion of primitives; objects/arrays in a required
 * field drop the entry.
 */
export function projectSearchResults(text: string): CanonicalResultEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const rows: unknown[] = Array.isArray(parsed)
		? parsed
		: parsed !== null &&
			  typeof parsed === "object" &&
			  Array.isArray((parsed as Record<string, unknown>).results)
			? ((parsed as Record<string, unknown>).results as unknown[])
			: [];

	const str = (v: unknown): string | null =>
		typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : null;

	const out: CanonicalResultEntry[] = [];
	for (const row of rows) {
		if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
		const r = row as Record<string, unknown>;
		const id = str(r.id);
		const domain = str(r.domain);
		const title = str(r.title);
		const body = str(r.body);
		const entryType = str(r.entryType);
		const severity = str(r.severity);
		if (!id || !domain || !title || !body || !entryType || !severity) continue;
		const entry: {
			id: string;
			domain: string;
			title: string;
			body: string;
			entryType: string;
			severity: string;
			source?: string;
			sourceVersion?: string;
			tags?: string[];
		} = { id, domain, title, body, entryType, severity };
		const source = str(r.source);
		if (source !== null) entry.source = source;
		const sourceVersion = str(r.sourceVersion);
		if (sourceVersion !== null) entry.sourceVersion = sourceVersion;
		if (Array.isArray(r.tags)) {
			const tags = r.tags.map(str).filter((t): t is string => t !== null);
			if (tags.length > 0) entry.tags = tags;
		}
		out.push(entry);
	}
	return out;
}
