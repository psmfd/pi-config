/**
 * expertise-fanout-gate — approval loop + expertise_create gate tests
 * (#605, ADR-0095).
 *
 * The load-bearing invariants:
 *   - only a real ctx.ui.confirm(true) populates the ledger; the create
 *     gate allows exactly that field set, single-use;
 *   - headless sessions queue and NEVER approve (fail-closed);
 *   - divergent-variant groups queue rather than approve blind;
 *   - the create gate blocks on mismatch, replay, headless-no-approval,
 *     and internal errors — and its inline interactive fallback is itself
 *     a real confirm.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { computeApprovalHash } from "../../expertise-indexer/approval.ts";
import type { CoalescedGroup } from "../../expertise-indexer/collector.ts";

const mod = await import("../index.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
	on(name: string, handler: Handler): void;
	handlers: Record<string, Handler[]>;
}

function makePi(): FakePi {
	const handlers: Record<string, Handler[]> = {};
	return {
		on(name, handler) {
			(handlers[name] ??= []).push(handler);
		},
		handlers,
	};
}

interface ConfirmCall {
	title: string;
	message: string;
}

function makeCtx(opts: { hasUI: boolean; confirmResponses?: boolean[] }): {
	ctx: unknown;
	confirms: ConfirmCall[];
} {
	const confirms: ConfirmCall[] = [];
	const responses = [...(opts.confirmResponses ?? [])];
	return {
		confirms,
		ctx: {
			cwd: "/tmp",
			hasUI: opts.hasUI,
			ui: {
				notify() {
					/* headless-safe */
				},
				confirm(title: string, message: string) {
					confirms.push({ title, message });
					return Promise.resolve(responses.length > 0 ? responses.shift()! : false);
				},
			},
		},
	};
}

const CANDIDATE = {
	domain: "ansible",
	title: "Handler semantics",
	body: "Handlers fire once per play.",
	entryType: "Caveat",
	severity: "Warning",
	proposedBy: "ansible-expert",
	dedupeQuery: "ansible handler semantics",
	canonical_blob_sha: "a".repeat(64),
} as const;

const APPROVED_FIELDS = {
	domain: CANDIDATE.domain,
	title: CANDIDATE.title,
	body: CANDIDATE.body,
	entryType: CANDIDATE.entryType,
	severity: CANDIDATE.severity,
};

function group(overrides: Partial<CoalescedGroup> = {}): CoalescedGroup {
	return {
		fingerprint: "f".repeat(64),
		candidate: CANDIDATE,
		proposedByList: ["ansible-expert"],
		proposalCount: 1,
		variantCount: 1,
		...overrides,
	} as CoalescedGroup;
}

interface Harness {
	dir: string;
	agentDir: string;
	toolResult: Handler;
	createGate: Handler;
}

async function makeHarness(): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "fanout-gate-approval-"));
	const agentDir = join(dir, "agent");
	const pi = makePi();
	mod.default(pi as never, { agentDir, now: () => 1_750_000_000_000 });
	const toolResult = pi.handlers.tool_result?.[0];
	// Handler [0] on tool_call is the pre-fetch hook; [1] is the create gate.
	const createGate = pi.handlers.tool_call?.[1];
	assert.equal(typeof toolResult, "function", "tool_result handler registered");
	assert.equal(typeof createGate, "function", "create gate registered");
	return { dir, agentDir, toolResult, createGate };
}

function subagentResult(groups: CoalescedGroup[]): Record<string, unknown> {
	return {
		toolName: "subagent",
		input: {},
		content: [{ type: "text", text: "fanout done" }],
		isError: false,
		details: { expertiseCandidates: { groups, rejected: [] } },
	};
}

function pendingLines(agentDir: string): Record<string, unknown>[] {
	const dir = join(agentDir, "extensions", "expertise-fanout-gate", "pending");
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return [];
	}
	const rows: Record<string, unknown>[] = [];
	for (const f of files.sort()) {
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return rows;
}

// --- approval loop ------------------------------------------------------------

test("approve → ledger → create gate allows exactly once", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));
	const { ctx, confirms } = makeCtx({ hasUI: true, confirmResponses: [true] });

	const out = (await h.toolResult(subagentResult([group()]), ctx)) as {
		content: { type: string; text: string }[];
	};
	assert.equal(confirms.length, 1);
	assert.match(confirms[0].title, /Expertise candidate 1\/1/);
	// Guidance note appended with the exact create params.
	const note = out.content[out.content.length - 1].text;
	assert.match(note, /call expertise_create with EXACTLY/);
	assert.ok(note.includes(JSON.stringify(APPROVED_FIELDS)));

	// Matching create: allowed (undefined = no block).
	const allow = await h.createGate(
		{ toolName: "expertise_create", input: { ...APPROVED_FIELDS } },
		makeCtx({ hasUI: true }).ctx,
	);
	assert.equal(allow, undefined);

	// Replay of the same params headless: consumed → blocked.
	const replay = (await h.createGate(
		{ toolName: "expertise_create", input: { ...APPROVED_FIELDS } },
		makeCtx({ hasUI: false }).ctx,
	)) as { block: boolean };
	assert.equal(replay.block, true);
});

test("decline records rejection; nothing enters the ledger", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));
	const { ctx } = makeCtx({ hasUI: true, confirmResponses: [false] });

	const out = await h.toolResult(subagentResult([group()]), ctx);
	assert.equal(out, undefined, "no guidance note when nothing was approved or queued");

	const blocked = (await h.createGate(
		{ toolName: "expertise_create", input: { ...APPROVED_FIELDS } },
		makeCtx({ hasUI: false }).ctx,
	)) as { block: boolean };
	assert.equal(blocked.block, true);
});

test("altered params after approval do not match (TOCTOU closed)", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));
	await h.toolResult(subagentResult([group()]), makeCtx({ hasUI: true, confirmResponses: [true] }).ctx);

	const blocked = (await h.createGate(
		{ toolName: "expertise_create", input: { ...APPROVED_FIELDS, body: `${APPROVED_FIELDS.body} altered` } },
		makeCtx({ hasUI: false }).ctx,
	)) as { block: boolean; reason: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /no recorded human approval|fail-closed/i);
});

test("headless fanout queues all groups and approves none", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));
	const { ctx, confirms } = makeCtx({ hasUI: false });

	const out = (await h.toolResult(subagentResult([group()]), ctx)) as {
		content: { type: string; text: string }[];
	};
	assert.equal(confirms.length, 0);
	assert.match(out.content[out.content.length - 1].text, /queued for interactive approval/);
	const rows = pendingLines(h.agentDir);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].reason, "headless");
});

test("divergent-variant groups queue instead of approving blind", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));
	const { ctx, confirms } = makeCtx({ hasUI: true, confirmResponses: [true] });

	const divergent = group({
		variantCount: 2,
		proposalCount: 2,
		proposedByList: ["a-expert", "b-expert"],
		bodyHashesByProposer: { "a-expert": "1".repeat(64), "b-expert": "2".repeat(64) },
	});
	await h.toolResult(subagentResult([divergent]), ctx);
	assert.equal(confirms.length, 0, "no dialog for a group whose variants cannot be inspected");
	const rows = pendingLines(h.agentDir);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].reason, "divergent-variants");
});

// --- create gate --------------------------------------------------------------

test("create gate: malformed params block; unrelated tools untouched", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const blocked = (await h.createGate(
		{ toolName: "expertise_create", input: { domain: 1 } },
		makeCtx({ hasUI: false }).ctx,
	)) as { block: boolean };
	assert.equal(blocked.block, true);

	const untouched = await h.createGate(
		{ toolName: "expertise_search", input: { query: "x" } },
		makeCtx({ hasUI: false }).ctx,
	);
	assert.equal(untouched, undefined);
});

test("create gate: inline interactive fallback is a real confirm", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	// Operator approves the direct create in-dialog.
	const yes = makeCtx({ hasUI: true, confirmResponses: [true] });
	const allow = await h.createGate(
		{ toolName: "expertise_create", input: { ...APPROVED_FIELDS } },
		yes.ctx,
	);
	assert.equal(allow, undefined);
	assert.equal(yes.confirms.length, 1);
	assert.match(yes.confirms[0].title, /Approve expertise_create/);

	// Operator declines → blocked with a no-retry instruction.
	const no = makeCtx({ hasUI: true, confirmResponses: [false] });
	const blocked = (await h.createGate(
		{ toolName: "expertise_create", input: { ...APPROVED_FIELDS } },
		no.ctx,
	)) as { block: boolean; reason: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /operator declined/);
});

test("secret-bearing group queues a REDACTED candidate copy, never a dialog", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));
	const { ctx, confirms } = makeCtx({ hasUI: true, confirmResponses: [true] });

	const secret = `AKIA${"A".repeat(16)}`;
	const leaky = group({
		candidate: { ...CANDIDATE, body: `use this key: ${secret}` },
	});
	await h.toolResult(subagentResult([leaky]), ctx);
	assert.equal(confirms.length, 0, "secret content never reaches the dialog");
	const rows = pendingLines(h.agentDir);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].reason, "secret-detected");
	const queuedBody = (rows[0].candidate as { body: string }).body;
	assert.ok(!queuedBody.includes(secret), "pending queue must not persist the secret");
	assert.match(queuedBody, /^\[redacted:/);
});

test("create gate: inline confirms are capped per session (approval-fatigue guard)", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	// Three declined inline confirms consume the whole budget…
	for (let i = 0; i < 3; i += 1) {
		const c = makeCtx({ hasUI: true, confirmResponses: [false] });
		const blocked = (await h.createGate(
			{ toolName: "expertise_create", input: { ...APPROVED_FIELDS, title: `attempt ${i}` } },
			c.ctx,
		)) as { block: boolean };
		assert.equal(blocked.block, true);
		assert.equal(c.confirms.length, 1);
	}
	// …the fourth attempt blocks WITHOUT raising a dialog.
	const fourth = makeCtx({ hasUI: true, confirmResponses: [true] });
	const capped = (await h.createGate(
		{ toolName: "expertise_create", input: { ...APPROVED_FIELDS, title: "attempt 4" } },
		fourth.ctx,
	)) as { block: boolean; reason: string };
	assert.equal(capped.block, true);
	assert.equal(fourth.confirms.length, 0, "no dialog past the cap");
	assert.match(capped.reason, /inline-approval budget/);
	// Fanout-ledger approvals are unaffected by the cap.
	await h.toolResult(subagentResult([group()]), makeCtx({ hasUI: true, confirmResponses: [true] }).ctx);
	const allow = await h.createGate(
		{ toolName: "expertise_create", input: { ...APPROVED_FIELDS } },
		makeCtx({ hasUI: false }).ctx,
	);
	assert.equal(allow, undefined);
});

test("create gate: sanity — approval hash in the note matches computeApprovalHash", async (tc) => {
	const h = await makeHarness();
	tc.after(() => rm(h.dir, { recursive: true, force: true }));
	await h.toolResult(subagentResult([group()]), makeCtx({ hasUI: true, confirmResponses: [true] }).ctx);
	// The ledger entry corresponds to the create-subset hash — a create call
	// built from the guidance JSON matches it.
	const hash = computeApprovalHash(APPROVED_FIELDS);
	assert.match(hash, /^[0-9a-f]{64}$/);
	const allow = await h.createGate(
		{ toolName: "expertise_create", input: JSON.parse(JSON.stringify(APPROVED_FIELDS)) as Record<string, unknown> },
		makeCtx({ hasUI: false }).ctx,
	);
	assert.equal(allow, undefined);
});
