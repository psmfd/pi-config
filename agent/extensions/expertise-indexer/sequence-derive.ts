/**
 * expertise-indexer — deterministic serial-sequence derivation (#1055).
 *
 * Pure functions shared by the runtime trigger (`expertise-fanout-gate`) and
 * the CI audit (#601): given the exact `subagent` sequence, derive whether it
 * is research-shaped, the canonical query inputs, and the canonical-blob
 * inputs that anchor the injection.
 *
 * DETERMINISM CONTRACT: every function here is a pure function of its
 * arguments — no clock, no I/O, no environment reads, no randomness. The CI
 * audit recomputes the expected `canonical_blob_sha` from the same ordered
 * sequence and repository state.
 *
 * Trigger definition (ADR-0148 — mechanical, no LLM judgment):
 *   - sequence mode only (`params.sequence`), length >= RESEARCH_SEQUENCE_MIN;
 *   - NOT review-only: at least one requested agent falls outside the static
 *     review-agent set below;
 *   - single-agent and chain-mode calls never trigger.
 */

import type { CanonicalInputs } from "./canonicalize.ts";
import type { CanonicalQueryInputs, CanonicalResultEntry } from "./collector.ts";

/** Minimum item count for a research-shaped serial sequence. */
export const RESEARCH_SEQUENCE_MIN = 3;

/** Review-only sequences are multi-reviewer workflows, not research. */
export const REVIEW_ONLY_AGENTS: ReadonlySet<string> = new Set([
	"checkmarx-expert",
	"code-review-expert",
	"linter",
	"security-review-expert",
]);

/** The two sequence-item fields used by deterministic derivation. */
export interface SequenceTask {
	readonly agent: string;
	readonly task: string;
}

/** Mechanical research-shape test over the ordered sequence. */
export function isResearchShapedSequence(sequence: readonly SequenceTask[]): boolean {
	if (sequence.length < RESEARCH_SEQUENCE_MIN) return false;
	return !sequence.every((item) => REVIEW_ONLY_AGENTS.has(item.agent));
}

/** Canonical query inputs derived from the ordered sequence. */
export function deriveQueryInputs(sequence: readonly SequenceTask[]): CanonicalQueryInputs {
	const agents = [...new Set(sequence.map((item) => item.agent))].sort();
	return {
		domain: agents.join(" "),
		taskType: "research",
		goalOrSymptom: sequence[0]?.task ?? "",
	};
}

/** Preserve caller order in the canonical task string. */
export function deriveSequenceTaskString(sequence: readonly SequenceTask[]): string {
	return sequence.map((item) => `${item.agent}: ${item.task}`).join("\n");
}

/** Canonical-blob inputs for one live serial sequence. */
export function deriveSequenceCanonicalInputs(args: {
	readonly repoOrigin: string;
	readonly headSha: string;
	readonly sequence: readonly SequenceTask[];
}): CanonicalInputs {
	return {
		repoOrigin: args.repoOrigin,
		headSha: args.headSha,
		files: [],
		taskString: deriveSequenceTaskString(args.sequence),
		agentFrontmatter: {},
	};
}

/**
 * Project a raw `expertise_search` response body into the injection entry
 * shape. Tolerant by design — the response is untrusted API output, and a
 * schema drift must degrade to "fewer results", never throw
 * into the tool_call hook (whose exceptions the pi runtime does NOT catch).
 *
 * Accepts `{"results": [...]}` (the semantic endpoint's envelope) or a bare
 * array. Required free-text fields accept either legacy primitives or the
 * upstream response-hygiene `{ value: string, ... }` wrapper. Other objects
 * and arrays drop the entry.
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
	const freeText = (v: unknown): string | null => {
		const primitive = str(v);
		if (primitive !== null) return primitive;
		if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
		return typeof (v as Record<string, unknown>).value === "string"
			? ((v as Record<string, unknown>).value as string)
			: null;
	};

	const out: CanonicalResultEntry[] = [];
	for (const row of rows) {
		if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
		const r = row as Record<string, unknown>;
		const id = str(r.id);
		// domain/source/sourceVersion/tags became response-hygiene wrappers in
		// agent-expertise-api v2.0 ({contentClass,value,...}), joining title/body.
		// freeText() unwraps the wrapper AND falls through to str() for the old
		// primitive shape, so this is version-agnostic (works pre- and post-v2.0).
		// Using str() here would return null for domain — a required field — and
		// silently drop EVERY result row under v2.0.
		const domain = freeText(r.domain);
		const title = freeText(r.title);
		const body = freeText(r.body);
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
		const source = freeText(r.source);
		if (source !== null) entry.source = source;
		const sourceVersion = freeText(r.sourceVersion);
		if (sourceVersion !== null) entry.sourceVersion = sourceVersion;
		if (Array.isArray(r.tags)) {
			const tags = r.tags.map(freeText).filter((t): t is string => t !== null);
			if (tags.length > 0) entry.tags = tags;
		}
		out.push(entry);
	}
	return out;
}
