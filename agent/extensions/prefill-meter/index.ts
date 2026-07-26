/**
 * prefill-meter — spawn-time prompt-segment measurement (ADR-0125, #891, #889).
 *
 * On each process's FIRST `before_agent_start` it appends one `spawn` JSONL
 * record with per-segment byte counts of the composed system prompt (base
 * template / appended wrapper body / `<project_context>` context files /
 * `<available_skills>` block) plus the user-role task prompt — the structured
 * `event.systemPromptOptions` payload makes every segment sizable without
 * string re-parsing, so the measurement is deterministic by construction. On
 * the first assistant `message_end` carrying usage it appends one
 * `first_usage` record: the provider-tokenizer ground truth for the byte sum.
 *
 * Toggle: inert unless PREFILL_METER_CONFIG is set to a non-empty string; the
 * value is recorded verbatim as the run label (tag before/after probe runs).
 * Children inherit the var (subagent's strict-env base allowlist carries it,
 * ADR-0125), so arming the orchestrator arms the whole spawn tree.
 *
 * Coexistence: auto-router also consumes `before_agent_start` (ADR-0031).
 * This handler is OBSERVATIONAL — it never returns a `systemPrompt` override
 * or a `message` (the ADR-0034 invariant: measurement must not perturb what
 * it measures). The recorded systemPromptBytes reflects the prompt as
 * delivered at this extension's position in the handler chain.
 *
 * Sensitivity: only byte counts, paths, counts, and a wrapper-body SHA-256
 * are logged — never prompt or context-file content (docs/extensions.md
 * flags `systemPromptOptions` content as sensitive extension-local data).
 */

import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	type AssistantMessageLike,
	buildSpawnRecord,
	buildUsageRecord,
	type RecordContext,
} from "./record.ts";
import { appendRecord } from "./state.ts";

const ENV_CONFIG = "PREFILL_METER_CONFIG";
/** Stamped by the subagent extension's buildChildEnv (set-or-increment). */
const ENV_DEPTH = "PI_SUBAGENT_DEPTH";

interface MessageEndEventLike {
	message?: AssistantMessageLike;
}
interface ModelContextLike {
	model?: { provider?: string };
}

/** Parse PI_SUBAGENT_DEPTH defensively: absent/mangled ⇒ 0 (orchestrator). */
export function readDepth(raw: string | undefined): number {
	const n = Number.parseInt((raw ?? "").trim(), 10);
	return Number.isInteger(n) && n > 0 ? n : 0;
}

export default function prefillMeter(pi: ExtensionAPI): void {
	// Env is snapshotted at load: children read the value their parent spawned
	// them with (same env-snapshot semantics as token-meter, ADR-0073).
	const label = (process.env[ENV_CONFIG] ?? "").trim();
	const enabled = label !== "";
	const depth = readDepth(process.env[ENV_DEPTH]);
	let spawnRecorded = false;
	let usageRecorded = false;

	const recordCtx = (): RecordContext => ({
		ts: new Date().toISOString(),
		label,
		pid: process.pid,
		depth,
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
		// First firing only: the cold prefill is the measurement target; later
		// turns reuse the same cached base prompt.
		if (!enabled || spawnRecorded) return;
		spawnRecorded = true;
		try {
			await appendRecord(buildSpawnRecord(event, recordCtx()));
		} catch {
			// Measurement must never disturb a turn.
		}
		// Inert by construction: no `systemPrompt`, no `message` — nothing returned.
	});

	pi.on("message_end", async (event, ctx) => {
		// Observational only — never return a replacement message.
		if (!enabled || usageRecorded) return undefined;
		try {
			const message = (event as unknown as MessageEndEventLike).message;
			const record = buildUsageRecord(
				message,
				recordCtx(),
				(ctx as unknown as ModelContextLike).model?.provider ?? "unknown",
			);
			if (record) {
				usageRecorded = true;
				await appendRecord(record);
			}
		} catch {
			// Measurement must never disturb a turn.
		}
		return undefined;
	});
}
