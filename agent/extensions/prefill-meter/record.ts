/**
 * prefill-meter/record.ts — pure spawn/usage record builders (ADR-0125).
 *
 * Side-effect-free so everything unit-tests without a live pi runtime: the
 * timestamp, run label, pid, and depth are injected by the caller. Only byte
 * counts, file paths, counts, and a wrapper-body SHA-256 ever land in a record —
 * NEVER prompt or context-file content (`event.systemPromptOptions` "may
 * include full context file contents, so treat it as sensitive" —
 * docs/extensions.md).
 *
 * Segment math: `before_agent_start` delivers the fully composed system prompt
 * AND the structured `BuildSystemPromptOptions` it was built from, so the
 * appended-wrapper, context-files, and skills segments are sized from structured
 * data (no string re-parsing — deterministic by construction). The base segment
 * (pi's built-in template + tool snippets + guidelines + cwd line) is derived by
 * subtraction.
 */

import { createHash } from "node:crypto";

import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

export interface ContextFileSize {
	path: string;
	bytes: number;
}

export interface SpawnRecord {
	ts: string;
	kind: "spawn";
	/** Operator run label — the verbatim PREFILL_METER_CONFIG value. */
	label: string;
	pid: number;
	/** PI_SUBAGENT_DEPTH: 0 = orchestrator process, 1 = subagent child, … */
	depth: number;
	/** Byte size of the user-role prompt (the parent-wrapped `Task: …` string). */
	promptBytes: number;
	/** Byte size of the fully composed system prompt as delivered to the hook. */
	systemPromptBytes: number;
	/**
	 * Derived: systemPromptBytes minus the append/context/skills sections.
	 * Covers pi's built-in template, tool snippets, prompt guidelines, and the
	 * trailing cwd line. Negative ⇒ upstream template drift (see driftSuspect).
	 */
	baseBytes: number;
	/** Raw `appendSystemPrompt` bytes (the wrapper body; 0 when absent). */
	appendBytes: number;
	/** Rendered append section incl. the "\n\n" join pi adds (0 when absent). */
	appendSectionBytes: number;
	/** Rendered `<project_context>` block bytes (0 when no context files). */
	contextSectionBytes: number;
	/** Per-file path + content bytes for each injected context file. */
	contextFiles: ContextFileSize[];
	/** Rendered `<available_skills>` block bytes via pi's own formatter. */
	skillsSectionBytes: number;
	/** All discovered skills, including disable-model-invocation ones. */
	skillsTotal: number;
	/** Skills actually rendered into the prompt block. */
	skillsVisible: number;
	/** SHA-256 (hex) of the raw wrapper body, for offline join against agent/agents/*.md. */
	appendSha256: string | null;
	/** Present iff the derived baseBytes went negative — segment templates drifted. */
	driftSuspect?: true;
}

export interface UsageRecord {
	ts: string;
	kind: "first_usage";
	label: string;
	pid: number;
	depth: number;
	model: string;
	provider: string;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

export type PrefillRecord = SpawnRecord | UsageRecord;

/** Injected per-process context shared by both record kinds. */
export interface RecordContext {
	ts: string;
	label: string;
	pid: number;
	depth: number;
}

/** Minimal shape of the `before_agent_start` payload the builder consumes. */
export interface SpawnInput {
	prompt: string;
	systemPrompt: string;
	systemPromptOptions: BuildSystemPromptOptions;
}

/** Minimal assistant-message shape read from `message_end` (usage only). */
export interface AssistantMessageLike {
	role?: string;
	model?: string;
	provider?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * LOCKSTEP reproduction of pi's `<project_context>` template
 * (dist/core/system-prompt.js:96-101 in the pinned v0.81.1 dep; both the
 * default and custom-prompt branches emit the identical literals). If upstream
 * changes the template, the derived baseBytes goes wrong and — when the drift
 * shrinks the real block — negative, which sets `driftSuspect` on the record
 * rather than silently mis-attributing bytes.
 */
export function renderContextSection(
	contextFiles: ReadonlyArray<{ path: string; content: string }>,
): string {
	if (contextFiles.length === 0) return "";
	let s = "\n\n<project_context>\n\n";
	s += "Project-specific instructions and guidelines:\n\n";
	for (const { path: filePath, content } of contextFiles) {
		s += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
	}
	s += "</project_context>\n";
	return s;
}

/** Rendered append section exactly as pi joins it (system-prompt.js:10). */
export function renderAppendSection(appendSystemPrompt: string | undefined): string {
	return appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
}

/** Build the one-per-process spawn record from a `before_agent_start` payload. */
export function buildSpawnRecord(input: SpawnInput, ctx: RecordContext): SpawnRecord {
	const opts = input.systemPromptOptions;
	const append = opts.appendSystemPrompt ?? "";
	const contextFiles = opts.contextFiles ?? [];
	const skills: Skill[] = opts.skills ?? [];

	const appendSection = renderAppendSection(append || undefined);
	const contextSection = renderContextSection(contextFiles);
	// pi's own exported formatter — exact bytes, no lockstep copy for skills.
	const skillsSection = formatSkillsForPrompt(skills);

	const systemPromptBytes = utf8Bytes(input.systemPrompt);
	const appendSectionBytes = utf8Bytes(appendSection);
	const contextSectionBytes = utf8Bytes(contextSection);
	const skillsSectionBytes = utf8Bytes(skillsSection);
	const baseBytes =
		systemPromptBytes - appendSectionBytes - contextSectionBytes - skillsSectionBytes;

	const record: SpawnRecord = {
		ts: ctx.ts,
		kind: "spawn",
		label: ctx.label,
		pid: ctx.pid,
		depth: ctx.depth,
		promptBytes: utf8Bytes(input.prompt),
		systemPromptBytes,
		baseBytes,
		appendBytes: utf8Bytes(append),
		appendSectionBytes,
		contextSectionBytes,
		contextFiles: contextFiles.map((f) => ({ path: f.path, bytes: utf8Bytes(f.content) })),
		skillsSectionBytes,
		skillsTotal: skills.length,
		skillsVisible: skills.filter((s) => !s.disableModelInvocation).length,
		appendSha256: append === "" ? null : createHash("sha256").update(append, "utf8").digest("hex"),
	};
	if (baseBytes < 0) record.driftSuspect = true;
	return record;
}

/**
 * Build the once-per-process usage record from the first assistant
 * `message_end` carrying usage — the provider-tokenizer ground truth for the
 * spawn record's byte sum. Returns null for non-assistant/usage-less messages.
 */
export function buildUsageRecord(
	message: AssistantMessageLike | undefined,
	ctx: RecordContext,
	providerFallback = "unknown",
): UsageRecord | null {
	if (message?.role !== "assistant" || !message.usage) return null;
	const u = message.usage;
	return {
		ts: ctx.ts,
		kind: "first_usage",
		label: ctx.label,
		pid: ctx.pid,
		depth: ctx.depth,
		model: message.model ?? "unknown",
		provider: message.provider ?? providerFallback,
		input: u.input ?? 0,
		cacheRead: u.cacheRead ?? 0,
		cacheWrite: u.cacheWrite ?? 0,
		output: u.output ?? 0,
	};
}

/** One JSONL line. */
export function toJsonl(record: PrefillRecord): string {
	return `${JSON.stringify(record)}\n`;
}
