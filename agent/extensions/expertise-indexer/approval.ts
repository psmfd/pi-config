/**
 * expertise-indexer — approval-hash binding (#605, ADR-0095).
 *
 * The lever that makes "the orchestrator writes it with approval" a code
 * invariant: a human approval records `computeApprovalHash(fields)` in the
 * gate's in-session ledger, and the `expertise_create` tool-call gate
 * recomputes the SAME hash over the model's actual call params — match →
 * allow, anything else → block. The hash covers the CREATE-relevant field
 * set (what the server receives), serialized with fixed key order.
 *
 * Deliberately NOT the coalesce `{domain, title}` fingerprint: binding to
 * that would let one approval authorize any of N divergent bodies — the
 * body-smuggling vector `bodyHashesByProposer` exists to prevent
 * (ADR-0095 § Approval design). `justification` (an EXPERTISE_CANDIDATES
 * review field, not a create param) is displayed at approval time but
 * excluded from the hash — it never reaches the server.
 *
 * Pure — no I/O, no clock.
 */

import { createHash } from "node:crypto";

import type { ProjectedCandidate } from "./candidate-gate.ts";

/**
 * The create-relevant field subset (matches `CreateParams` in
 * expertise-client). Optional fields participate in the hash only when
 * present — an approval over `{…, source: undefined}` matches a create
 * call that omits `source`, and does NOT match one that supplies it.
 */
export interface ApprovalFields {
	readonly domain: string;
	readonly title: string;
	readonly body: string;
	readonly entryType: string;
	readonly severity: string;
	readonly source?: string;
	readonly tags?: readonly string[];
	readonly sourceVersion?: string;
}

/**
 * Byte-locked serialization: fixed key order (alphabetical), optional keys
 * emitted only when defined, tags in caller order (order is part of the
 * approved content — a reordered tag list is a different approval).
 */
export function serializeApprovalFields(fields: ApprovalFields): string {
	const parts: string[] = [
		`"body":${JSON.stringify(fields.body)}`,
		`"domain":${JSON.stringify(fields.domain)}`,
		`"entryType":${JSON.stringify(fields.entryType)}`,
		`"severity":${JSON.stringify(fields.severity)}`,
	];
	if (fields.source !== undefined) parts.push(`"source":${JSON.stringify(fields.source)}`);
	if (fields.sourceVersion !== undefined)
		parts.push(`"sourceVersion":${JSON.stringify(fields.sourceVersion)}`);
	if (fields.tags !== undefined)
		parts.push(`"tags":[${fields.tags.map((t) => JSON.stringify(t)).join(",")}]`);
	parts.push(`"title":${JSON.stringify(fields.title)}`);
	return `{${parts.join(",")}}`;
}

/** SHA-256 hex over the byte-locked serialization. */
export function computeApprovalHash(fields: ApprovalFields): string {
	return createHash("sha256").update(serializeApprovalFields(fields), "utf8").digest("hex");
}

/** Project a gated candidate to the create-relevant approval subset. */
export function approvalFieldsFromCandidate(c: ProjectedCandidate): ApprovalFields {
	return {
		domain: c.domain,
		title: c.title,
		body: c.body,
		entryType: c.entryType,
		severity: c.severity,
		...(c.source !== undefined ? { source: c.source } : {}),
		...(c.tags !== undefined ? { tags: [...c.tags] } : {}),
		...(c.sourceVersion !== undefined ? { sourceVersion: c.sourceVersion } : {}),
	};
}

/**
 * Narrow a raw `expertise_create` tool input to the approval subset.
 * Returns `null` on any shape violation — the caller (the create gate)
 * treats that as "no approval can match" and blocks. Unknown extra keys
 * are IGNORED here (the tool's own schema rejects them); only the hashed
 * fields are validated.
 */
export function approvalFieldsFromCreateInput(
	input: Record<string, unknown>,
): ApprovalFields | null {
	const { domain, title, body, entryType, severity, source, tags, sourceVersion } = input;
	if (
		typeof domain !== "string" ||
		typeof title !== "string" ||
		typeof body !== "string" ||
		typeof entryType !== "string" ||
		typeof severity !== "string"
	) {
		return null;
	}
	if (source !== undefined && typeof source !== "string") return null;
	if (sourceVersion !== undefined && typeof sourceVersion !== "string") return null;
	let tagsOut: readonly string[] | undefined;
	if (tags !== undefined) {
		if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) return null;
		tagsOut = tags as string[];
	}
	return {
		domain,
		title,
		body,
		entryType,
		severity,
		...(source !== undefined ? { source } : {}),
		...(tagsOut !== undefined ? { tags: tagsOut } : {}),
		...(sourceVersion !== undefined ? { sourceVersion } : {}),
	};
}
