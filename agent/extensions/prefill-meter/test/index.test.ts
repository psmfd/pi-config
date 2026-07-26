/**
 * prefill-meter wiring — the inert-by-default and first-firing-only invariants.
 *
 * Hermetic: HOME is redirected to a temp dir (the default ledger path resolves
 * under $HOME/.pi/agent), and the PREFILL_METER_CONFIG / PI_SUBAGENT_DEPTH env
 * vars are saved and restored around every test.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import prefillMeter, { readDepth } from "../index.ts";
import { readRecords } from "../state.ts";

const ENV_CONFIG = "PREFILL_METER_CONFIG";
const ENV_DEPTH = "PI_SUBAGENT_DEPTH";
const TOUCHED = [ENV_CONFIG, ENV_DEPTH, "HOME"] as const;

type Handler = (event: unknown, ctx: unknown) => unknown;

function loadExtension(): { fire: (event: string, payload: unknown) => Promise<unknown> } {
	const handlers: Record<string, Handler> = {};
	const pi = {
		on(event: string, handler: Handler) {
			handlers[event] = handler;
		},
	};
	prefillMeter(pi as never);
	return {
		fire: async (event, payload) => {
			const h = handlers[event];
			if (!h) throw new Error(`no handler registered for ${event}`);
			return h(payload, { model: { provider: "test-provider" } });
		},
	};
}

const SPAWN_EVENT = {
	type: "before_agent_start",
	prompt: "Task: measure me",
	systemPrompt: "base\n\nwrapper body",
	systemPromptOptions: { appendSystemPrompt: "wrapper body" },
};

const USAGE_EVENT = {
	message: { role: "assistant", model: "m1", usage: { input: 9000, output: 5 } },
};

const saved: Record<string, string | undefined> = {};
let tmpHome: string;
let agentDir: string;

beforeEach(() => {
	for (const k of TOUCHED) saved[k] = process.env[k];
	tmpHome = mkdtempSync(join(tmpdir(), "prefill-meter-home-"));
	process.env.HOME = tmpHome;
	agentDir = join(tmpHome, ".pi", "agent");
	delete process.env[ENV_CONFIG];
	delete process.env[ENV_DEPTH];
});
afterEach(() => {
	for (const k of TOUCHED) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(tmpHome, { recursive: true, force: true });
});

test("inert by default: no config var → nothing written, nothing returned", async () => {
	const ext = loadExtension();
	assert.equal(await ext.fire("before_agent_start", SPAWN_EVENT), undefined);
	assert.equal(await ext.fire("message_end", USAGE_EVENT), undefined);
	assert.equal(existsSync(join(agentDir, "extensions", "prefill-meter")), false);
});

test("armed: one spawn record on first firing only, handler stays inert", async () => {
	process.env[ENV_CONFIG] = " probe-3-after ";
	process.env[ENV_DEPTH] = "1";
	const ext = loadExtension();
	assert.equal(await ext.fire("before_agent_start", SPAWN_EVENT), undefined);
	assert.equal(await ext.fire("before_agent_start", SPAWN_EVENT), undefined);
	const recs = await readRecords(agentDir);
	assert.equal(recs.length, 1);
	assert.equal(recs[0].kind, "spawn");
	assert.equal(recs[0].label, "probe-3-after"); // trimmed
	assert.equal(recs[0].depth, 1);
	assert.equal((recs[0] as { appendBytes?: number }).appendBytes, "wrapper body".length);
});

test("armed: first assistant usage recorded once, with provider fallback", async () => {
	process.env[ENV_CONFIG] = "run";
	const ext = loadExtension();
	// A usage-less / non-assistant message does not consume the latch.
	await ext.fire("message_end", { message: { role: "user" } });
	await ext.fire("message_end", USAGE_EVENT);
	await ext.fire("message_end", USAGE_EVENT);
	const recs = await readRecords(agentDir);
	assert.equal(recs.length, 1);
	assert.equal(recs[0].kind, "first_usage");
	assert.equal((recs[0] as { provider?: string }).provider, "test-provider");
	assert.equal((recs[0] as { input?: number }).input, 9000);
	assert.equal(recs[0].depth, 0);
});

test("a ledger write failure never disturbs the turn", async () => {
	process.env[ENV_CONFIG] = "run";
	// Point HOME somewhere unwritable-as-a-directory: a FILE in its path.
	process.env.HOME = join(tmpHome, "not-a-dir-parent");
	const ext = loadExtension();
	// mkdir will fail under a missing/invalid tree only if creation fails —
	// force failure by making the parent a file.
	const { writeFileSync } = await import("node:fs");
	writeFileSync(process.env.HOME, "occupied", "utf8");
	await assert.doesNotReject(async () => {
		await ext.fire("before_agent_start", SPAWN_EVENT);
		await ext.fire("message_end", USAGE_EVENT);
	});
});

test("readDepth: absent, mangled, and negative all resolve to 0", () => {
	assert.equal(readDepth(undefined), 0);
	assert.equal(readDepth(""), 0);
	assert.equal(readDepth("banana"), 0);
	assert.equal(readDepth("-3"), 0);
	assert.equal(readDepth("2"), 2);
});
