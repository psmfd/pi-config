/**
 * expertise-fanout-gate — pi extension (ADR-0095, #613, epic #595).
 *
 * Makes the canonical-expertise pre-fetch DETERMINISTIC: "research starts →
 * expertise is searched" becomes a runtime property instead of orchestrator
 * prompt discipline. A `tool_call` hook on the `subagent` tool detects a
 * research-shaped parallel fanout (mechanical trigger — see
 * `expertise-indexer/fanout-derive.ts`), runs ONE canonical
 * `expertise_search` against the loopback agent-expertise-api, and injects
 * the rendered `CANONICAL_EXPERTISE_RESULTS` block into every task by
 * mutating the tool input in place. The vendored subagent extension then
 * prepends it to each child's user-role `Task:` framing (LOCAL PATCH #6) —
 * never `--append-system-prompt`, per `agent/rules/no-mcp-servers.md`.
 *
 * Fail-open, self-caught: the pi runtime does NOT wrap `tool_call` handlers
 * in try/catch, so every failure path here is caught internally — a missing
 * API key, an unreachable endpoint, a 429, a git probe failure, or a bug in
 * this extension must degrade to "fanout proceeds without canonical
 * context", never to a broken turn.
 *
 * Activity-stream visibility (security fan-out, ADR-0095): each automatic
 * search — precisely because it is NOT a model-visible tool call — emits a
 * single audit line (stderr always; `ctx.ui.notify` when interactive) and a
 * JSONL telemetry record naming the query, result count, and anchor sha.
 *
 * Rate-limit posture: the semantic endpoint allows 10 req/min. The gate
 * spends at most ONE search per fanout, backs off session-wide on a 429
 * (Retry-After when sent, else 60s), and never retries in-handler.
 *
 * Trust boundary: config comes from `process.env` + the expertise-client
 * extension's own `.env.local` (sibling path — extensions co-live under
 * `~/.pi/agent/extensions/`), resolved through the SHARED parser
 * (`shared/expertise-api-config.ts`) with the same loopback-only +
 * key-required invariants. Project/repo content can never steer the
 * endpoint. Read-only: this extension imports no create-capable module.
 *
 * Approval loop + create gate (#605, ADR-0095 § Approval design): a
 * `tool_result` hook surfaces coalesced EXPERTISE_CANDIDATES groups via
 * `ctx.ui.confirm` (one at a time, no timeout); a real confirm(true) is
 * the ONLY act that records the full-field approval hash in the
 * in-session single-use ledger; a `tool_call` gate on `expertise_create`
 * allows exactly a recorded field set and otherwise blocks FAIL-CLOSED
 * (deliberate contrast with the fail-open pre-fetch above). Headless
 * sessions queue candidates to a pending JSONL and never approve.
 */

import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import {
	approvalFieldsFromCandidate,
	approvalFieldsFromCreateInput,
	computeApprovalHash,
} from "../expertise-indexer/approval.ts";
import { computeCanonicalBlob } from "../expertise-indexer/canonicalize.ts";
import {
	buildCanonicalQuery,
	renderCanonicalResultsBlock,
	type CoalescedGroup,
	type CoalesceResult,
} from "../expertise-indexer/collector.ts";
import {
	deriveFanoutCanonicalInputs,
	deriveQueryInputs,
	isResearchShapedFanout,
	projectSearchResults,
	type FanoutTask,
} from "../expertise-indexer/fanout-derive.ts";
import { buildClientConfig, loadEnvLocal } from "../shared/expertise-api-config.ts";
import { searchExpertise } from "../shared/expertise-api-search.ts";
import { notify } from "../shared/notify.ts";
import { scanRawString } from "../shared/secret-scan.ts";
import { makeLedger, queuePending } from "./lib/approval-ledger.ts";
import { defaultGitExecutor, probeGitInfo, type GitExecutor } from "./lib/git-info.ts";
import { appendTelemetry, sanitizeField, type TelemetryRecord } from "./lib/telemetry.ts";

/** Injected-block result cap: mirrors the rule doc's ≤5-results sizing. */
export const CANONICAL_SEARCH_LIMIT = 5;

/** Session backoff after a 429 with no usable Retry-After (token bucket is
 * 10/min, so one bucket window). */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

/** Per-session budget for the create gate's inline interactive fallback —
 * the approval-fatigue guard (post-arc security review, ADR-0095). Fanout
 * approvals are unaffected; this caps only ledger-miss direct creates. */
export const MAX_INLINE_CONFIRMS_PER_SESSION = 3;

export interface GateDeps {
	readonly fetchImpl?: typeof fetch;
	readonly gitExec?: GitExecutor;
	/** Override the `.env.local` path (tests). */
	readonly envPath?: string;
	/** Override the telemetry base dir (tests). */
	readonly agentDir?: string;
	/** Injectable clock (tests). */
	readonly now?: () => number;
}

/** Sibling-path anchor for the one env file the client owns (see header). */
export function resolveClientEnvPath(): string {
	return fileURLToPath(new URL("../expertise-client/.env.local", import.meta.url));
}

/** Narrow the raw tool input's `tasks` to the derivation shape, or null when
 * the call is not a well-formed parallel fanout (let the tool validate). */
export function narrowTasks(input: Record<string, unknown>): FanoutTask[] | null {
	const raw = input.tasks;
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const tasks: FanoutTask[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
		const rec = item as Record<string, unknown>;
		if (typeof rec.agent !== "string" || typeof rec.task !== "string") return null;
		tasks.push({ agent: rec.agent, task: rec.task });
	}
	return tasks;
}

/** True when any task already carries a non-empty caller-supplied injection —
 * the orchestrator took manual control of this fanout; the gate stands down
 * rather than mixing two differently-anchored blocks in one fanout. */
export function hasCallerInjection(input: Record<string, unknown>): boolean {
	const raw = input.tasks;
	if (!Array.isArray(raw)) return false;
	return raw.some(
		(item) =>
			item !== null &&
			typeof item === "object" &&
			typeof (item as Record<string, unknown>).expertiseInjection === "string" &&
			((item as Record<string, unknown>).expertiseInjection as string).length > 0,
	);
}

export default function (pi: ExtensionAPI, deps: GateDeps = {}) {
	// Session-scoped 429 backoff: epoch ms before which no search is attempted.
	let rateLimitedUntil = 0;
	// One search in flight at a time: overlapping concurrent fanouts must not
	// double-spend the one-search budget (post-arc review finding).
	let searchInFlight = false;
	// Notify a missing/invalid config once per session, not once per fanout.
	let configNotified = false;
	// In-session approval ledger (#605): populated ONLY by real
	// ctx.ui.confirm resolutions; consumed single-use by the create gate.
	const ledger = makeLedger();
	// Approval-fatigue guard on the inline create confirm (post-arc security
	// review): a looping model must not be able to spam dialogs until the
	// operator reflexively approves one.
	let inlineConfirmsUsed = 0;

	const now = deps.now ?? Date.now;

	const record = (r: TelemetryRecord): void => {
		appendTelemetry(r, {
			...(deps.agentDir !== undefined ? { agentDir: deps.agentDir } : {}),
			now: new Date(now()),
		});
	};

	const auditLine = (ctx: ExtensionContext, message: string): void => {
		// stderr always (headless sessions included) — the ADR-0029 precedent
		// for extension acts with no tool-call frame; UI notify when present.
		try {
			process.stderr.write(`[expertise-fanout-gate] ${message}\n`);
		} catch {
			/* best-effort */
		}
		if (ctx.hasUI) notify(ctx, "expertise-fanout-gate", message, "info");
	};

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (event.toolName !== "subagent") return undefined;
			const input = event.input;

			const tasks = narrowTasks(input);
			if (tasks === null) return undefined;
			if (!isResearchShapedFanout(tasks)) return undefined;
			if (hasCallerInjection(input)) return undefined;

			const agents = [...new Set(tasks.map((t) => t.agent))].sort();
			const base: Pick<TelemetryRecord, "agents" | "taskCount"> = {
				agents,
				taskCount: tasks.length,
			};

			if (now() < rateLimitedUntil) {
				record({ event: "skip", reason: "rate-limited", ...base });
				return undefined;
			}
			if (searchInFlight) {
				// Overlapping fanout while another's search is mid-flight:
				// skip rather than double-spend the one-search budget.
				record({ event: "skip", reason: "concurrent-fanout", ...base });
				return undefined;
			}

			const cfg = buildClientConfig(
				process.env,
				loadEnvLocal(deps.envPath ?? resolveClientEnvPath()),
			);
			if (!cfg.ok) {
				record({ event: "skip", reason: "no-config", detail: cfg.reason, ...base });
				if (!configNotified && ctx.hasUI) {
					configNotified = true;
					notify(
						ctx,
						"expertise-fanout-gate",
						`canonical expertise pre-fetch disabled: ${sanitizeField(cfg.reason)}`,
						"warning",
					);
				}
				return undefined;
			}

			const git = await probeGitInfo(ctx.cwd, deps.gitExec ?? defaultGitExecutor);
			if (git === null) {
				record({ event: "skip", reason: "no-git", ...base });
				return undefined;
			}

			const query = buildCanonicalQuery(deriveQueryInputs(tasks));
			if (query === "") {
				// Rule-doc exemption: never send a garbage query.
				record({ event: "skip", reason: "empty-query", ...base });
				return undefined;
			}

			const blob = computeCanonicalBlob(
				deriveFanoutCanonicalInputs({ repoOrigin: git.origin, headSha: git.headSha, tasks }),
			);

			searchInFlight = true;
			let search: Awaited<ReturnType<typeof searchExpertise>>;
			try {
				search = await searchExpertise(
					cfg.config,
					{ query, limit: CANONICAL_SEARCH_LIMIT },
					deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
				);
			} finally {
				searchInFlight = false;
			}
			if (!search.ok) {
				if (search.rateLimited) {
					const backoffMs =
						search.retryAfterSeconds !== undefined
							? Math.min(search.retryAfterSeconds, 600) * 1000
							: DEFAULT_RATE_LIMIT_BACKOFF_MS;
					rateLimitedUntil = now() + backoffMs;
				}
				record({
					event: "skip",
					reason: search.rateLimited ? "rate-limited" : "search-failed",
					query,
					detail: search.reason,
					...base,
				});
				return undefined;
			}

			const results = projectSearchResults(search.text);
			const block = renderCanonicalResultsBlock(results, blob.sha);

			// Mutate in place — later handlers and the tool itself see the
			// injected tasks (SDK contract: input is mutable pre-execution).
			for (const item of input.tasks as unknown[]) {
				(item as Record<string, unknown>).expertiseInjection = block;
			}

			record({
				event: "inject",
				query,
				canonicalBlobSha: blob.sha,
				resultCount: results.length,
				...base,
			});
			auditLine(
				ctx,
				`canonical expertise injected: query="${sanitizeField(query)}" results=${results.length} sha=${blob.sha.slice(0, 12)}…`,
			);
			return undefined;
		} catch (err) {
			// tool_call handler exceptions are NOT caught by the runtime —
			// swallow everything; the fanout must proceed uninjected.
			try {
				appendTelemetry(
					{ event: "error", detail: err instanceof Error ? err.message : String(err) },
					{
						...(deps.agentDir !== undefined ? { agentDir: deps.agentDir } : {}),
						now: new Date(now()),
					},
				);
			} catch {
				/* best-effort */
			}
			return undefined;
		}
	});

	// ------------------------------------------------------------------
	// Approval loop (#605): surface coalesced candidate groups from a
	// subagent fanout to the operator, one at a time, via ctx.ui.confirm.
	// Runs on tool_result (runtime-caught — safer seam for UI dialogs).
	// A real confirm(true) is the ONLY act that populates the ledger the
	// expertise_create gate below trusts.
	// ------------------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "subagent") return undefined;
		const details = event.details as { expertiseCandidates?: CoalesceResult } | undefined;
		const groups = details?.expertiseCandidates?.groups;
		if (!groups || groups.length === 0) return undefined;

		const pendingOpts = {
			...(deps.agentDir !== undefined ? { agentDir: deps.agentDir } : {}),
			now: new Date(now()),
		};

		if (!ctx.hasUI) {
			// Fail-closed: no dialog channel → nothing is approved; queue for
			// a later interactive session.
			queuePending(groups, "headless", pendingOpts);
			for (const g of groups) {
				record({
				event: "queue",
				reason: "headless",
				fingerprint: g.fingerprint,
				candidateBlobSha: g.candidate.canonical_blob_sha,
			});
			}
			return appendResultNote(
				event.content,
				`${groups.length} expertise candidate group(s) queued for interactive approval ` +
					`(headless session — approvals require a real operator dialog; ADR-0095).`,
			);
		}

		const approvedNotes: string[] = [];
		let queued = 0;
		for (const [i, group] of groups.entries()) {
			// Divergent-variant groups cannot satisfy the per-proposer body
			// inspection invariant in a single dialog (the library retains
			// only the representative body) — queue, never approve blind.
			if (group.variantCount > 1) {
				queuePending([group], "divergent-variants", pendingOpts);
				record({
					event: "queue",
					reason: "divergent-variants",
					fingerprint: group.fingerprint,
					candidateBlobSha: group.candidate.canonical_blob_sha,
				});
				queued += 1;
				continue;
			}
			const display = formatGroupForDialog(group, i + 1, groups.length);
			// Defense-in-depth: acceptCandidates already secret-scanned the
			// candidate; re-scan the composed dialog text before it reaches
			// the operator's terminal scrollback.
			if (scanRawString(display.message).length > 0) {
				queuePending([group], "secret-detected", pendingOpts);
				record({
					event: "queue",
					reason: "secret-detected",
					fingerprint: group.fingerprint,
					candidateBlobSha: group.candidate.canonical_blob_sha,
				});
				queued += 1;
				continue;
			}
			// No dialog timeout — an RPC auto-resolve would be a silent
			// approve/decline (the gh-identity-guard invariant).
			const approved = await ctx.ui.confirm(display.title, display.message);
			if (!approved) {
				record({
					event: "reject",
					fingerprint: group.fingerprint,
					candidateBlobSha: group.candidate.canonical_blob_sha,
				});
				continue;
			}
			const fields = approvalFieldsFromCandidate(group.candidate);
			const hash = computeApprovalHash(fields);
			ledger.record(hash);
			record({
				event: "approve",
				fingerprint: group.fingerprint,
				approvalHash: hash,
				candidateBlobSha: group.candidate.canonical_blob_sha,
			});
			approvedNotes.push(
				`- fingerprint ${group.fingerprint.slice(0, 12)}…: call expertise_create with EXACTLY ` +
					`these params:\n${JSON.stringify(fields)}`,
			);
		}

		const noteParts: string[] = [];
		if (approvedNotes.length > 0) {
			noteParts.push(
				`Operator approved ${approvedNotes.length} expertise candidate(s) (ADR-0095). ` +
					`The create gate matches on the exact field set below — do not rephrase, ` +
					`reorder tags, or add fields:\n${approvedNotes.join("\n")}`,
			);
		}
		if (queued > 0) {
			noteParts.push(
				`${queued} candidate group(s) were queued (divergent variants or secret hit) — ` +
					`not approved; an operator can review the pending queue later.`,
			);
		}
		if (noteParts.length === 0) return undefined;
		return appendResultNote(event.content, noteParts.join("\n\n"));
	});

	// ------------------------------------------------------------------
	// expertise_create gate (#605): allow iff a recorded approval matches
	// the FULL create field set (single-use). Fail-CLOSED — internal
	// errors and unverifiable states block; contrast with the fail-open
	// pre-fetch above (ADR-0095 "failure postures are directional").
	// ------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "expertise_create") return undefined;
		try {
			const fields = approvalFieldsFromCreateInput(event.input);
			if (fields === null) {
				record({ event: "create-block", reason: "malformed-params" });
				return {
					block: true,
					reason:
						"expertise_create blocked: params do not match the approval field shape " +
						"(domain/title/body/entryType/severity strings; optional source/tags/sourceVersion).",
				};
			}
			const hash = computeApprovalHash(fields);
			if (ledger.consume(hash)) {
				record({ event: "create-allow", approvalHash: hash });
				return undefined;
			}
			// No ledger entry. Interactive fallback: a direct, operator-driven
			// create (outside the fanout flow) is still human-gated — the gate
			// ITSELF asks. Headless: hard block. Capped per session
			// (approval-fatigue guard, post-arc security review): a looping
			// model must not spam dialogs until one gets a reflexive yes.
			if (ctx.hasUI) {
				if (inlineConfirmsUsed >= MAX_INLINE_CONFIRMS_PER_SESSION) {
					record({ event: "create-block", reason: "inline-confirm-cap" });
					return {
						block: true,
						reason:
							`expertise_create blocked: the per-session inline-approval budget ` +
							`(${MAX_INLINE_CONFIRMS_PER_SESSION}) is exhausted (ADR-0095 approval-fatigue guard). ` +
							`Surface further candidates through a research fanout, or ask the operator ` +
							`to restart the session if more direct creates are genuinely intended.`,
					};
				}
				inlineConfirmsUsed += 1;
				const paramsJson = JSON.stringify(fields, null, 2);
				if (scanRawString(paramsJson).length > 0) {
					record({ event: "create-block", reason: "secret-detected" });
					return {
						block: true,
						reason:
							"expertise_create blocked: a credential pattern was detected in the " +
							"entry content. Remove the secret material and retry.",
					};
				}
				const approved = await ctx.ui.confirm(
					"Approve expertise_create?",
					`The model wants to create this expertise entry (no prior fanout approval on record):\n\n` +
						`${boundedForDialog(paramsJson)}\n\nApprove this exact entry?`,
				);
				if (approved) {
					record({ event: "create-allow", reason: "inline-confirm", approvalHash: hash });
					return undefined;
				}
				record({ event: "create-block", reason: "operator-declined" });
				return {
					block: true,
					reason:
						"expertise_create blocked: the operator declined this entry. Do not retry " +
						"or rephrase it; ask the operator how to proceed.",
				};
			}
			record({ event: "create-block", reason: "no-approval-headless" });
			return {
				block: true,
				reason:
					"expertise_create blocked: no recorded human approval matches these params and " +
					"this session has no dialog channel (ADR-0095 fail-closed). Candidates must be " +
					"approved in an interactive session.",
			};
		} catch (err) {
			// Fail-closed: an unverifiable approval never lets the write through.
			try {
				record({
					event: "create-block",
					reason: "gate-error",
					detail: err instanceof Error ? err.message : String(err),
				});
			} catch {
				/* best-effort */
			}
			return {
				block: true,
				reason: "expertise_create blocked: approval gate error (fail-closed; ADR-0095).",
			};
		}
	});
}

/** Bounded body slice for dialog display (never truncates mid-code-unit). */
function boundedForDialog(text: string, cap = 1500): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}\n…[${text.length - cap} more chars — full body in the pending/telemetry record]`;
}

function formatGroupForDialog(
	group: CoalescedGroup,
	index: number,
	total: number,
): { title: string; message: string } {
	const c = group.candidate;
	const lines = [
		`domain: ${c.domain}`,
		`title: ${c.title}`,
		`entryType: ${c.entryType}   severity: ${c.severity}`,
		...(c.justification ? [`justification: ${c.justification}`] : []),
		...(c.tags && c.tags.length > 0 ? [`tags: ${c.tags.join(", ")}`] : []),
		...(c.source ? [`source: ${c.source}`] : []),
		...(c.sourceVersion ? [`sourceVersion: ${c.sourceVersion}`] : []),
		`proposed by: ${group.proposedByList.join(", ")} (${group.proposalCount} proposal(s))`,
		"",
		boundedForDialog(c.body),
		"",
		"Approve creating this expertise entry? The model must then call " +
			"expertise_create with exactly the approved fields.",
	];
	return {
		title: `Expertise candidate ${index}/${total}: ${c.domain} / ${c.title}`,
		message: lines.join("\n"),
	};
}

/** Append a text note to a tool result's content (ToolResultEventResult). */
function appendResultNote(
	content: ToolResultEvent["content"],
	text: string,
): { content: ToolResultEvent["content"] } {
	return { content: [...content, { type: "text", text }] };
}
