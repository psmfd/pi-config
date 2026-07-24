/**
 * renderResult streaming-phase + shared-row coverage (#794, from the #793
 * review). Pins the mid-stream rendering states the spawn-integration test
 * never touched — running sentinel, partial output, per-task status icons,
 * running-vs-done status headers — plus the expanded per-row shape (step
 * headers, Task line, tool-call arrows, usage footers, totals), so the
 * chain/parallel row-rendering dedup is regression-guarded.
 *
 * pi-tui components expose `render(width): string[]`, so assertions run on
 * the joined rendered lines with an identity theme (fg/bold return the raw
 * text — icons and glyphs assert literally).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// getAgentDir() is consulted at registration time for the tool description.
const baseDir = mkdtempSync(join(tmpdir(), "subagent-render-"));
mkdirSync(join(baseDir, "agents"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = baseDir;

const mod = await import("../index.ts");

interface RenderedComponent {
	render(width: number): string[];
}
interface RegisteredTool {
	name: string;
	renderResult(
		result: { content: unknown[]; details?: unknown },
		opts: { expanded: boolean },
		theme: unknown,
		context: unknown,
	): RenderedComponent;
}

const registered: RegisteredTool[] = [];
mod.default({
	registerTool(def: RegisteredTool) {
		registered.push(def);
	},
	on() {
		/* not needed */
	},
} as never);
const tool = registered.find((t) => t.name === "subagent");
assert.equal(typeof tool?.renderResult, "function");

const theme = {
	fg: (_color: unknown, text: string) => text,
	bold: (text: string) => text,
};

function usage(partial: Partial<Record<string, number>> = {}) {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
		...partial,
	};
}

function asstText(text: string): unknown {
	return { role: "assistant", content: [{ type: "text", text }] };
}
function asstTool(name: string, args: Record<string, unknown>): unknown {
	return { role: "assistant", content: [{ type: "toolCall", id: "t1", name, arguments: args }] };
}

function makeResult(overrides: Record<string, unknown> = {}) {
	return {
		agent: "alpha",
		agentSource: "user",
		task: "inspect the flux capacitor",
		exitCode: 0,
		messages: [asstText("all good")],
		stderr: "",
		usage: usage({ input: 1000, output: 50, turns: 2 }),
		model: "prov/model-x",
		...overrides,
	};
}

function renderText(
	details: Record<string, unknown>,
	expanded: boolean,
): string {
	const component = tool!.renderResult(
		{ content: [{ type: "text", text: "unused" }], details },
		{ expanded },
		theme,
		undefined,
	);
	return component.render(200).join("\n");
}

test.after(async () => {
	await rm(baseDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Runtime provider failover telemetry (#868 / ADR-0122).
// -----------------------------------------------------------------------------

test("single rendering surfaces the failed and fallback model path", () => {
	const result = makeResult({
		model: "openai-codex/fallback",
		failover: {
			attemptedModels: ["github-copilot/quota-dead", "openai-codex/fallback"],
			failedModel: "github-copilot/quota-dead",
			fallbackModel: "openai-codex/fallback",
			outcome: "succeeded",
		},
	});
	for (const expanded of [false, true]) {
		const out = renderText(
			{ mode: "single", agentScope: "user", projectAgentsDir: null, results: [result] },
			expanded,
		);
		assert.match(out, /runtime failover succeeded: github-copilot\/quota-dead → openai-codex\/fallback/);
	}
});

test("parallel row rendering explains post-tool retry refusal", () => {
	const result = makeResult({
		exitCode: 1,
		stopReason: "error",
		errorMessage: "429 quota exceeded",
		failover: {
			attemptedModels: ["github-copilot/quota-dead"],
			failedModel: "github-copilot/quota-dead",
			outcome: "not-retried-after-tool",
		},
	});
	for (const expanded of [false, true]) {
		const out = renderText(
			{ mode: "parallel", agentScope: "user", projectAgentsDir: null, results: [result] },
			expanded,
		);
		assert.match(out, /runtime failover refused after tool execution: github-copilot\/quota-dead/);
	}
});

// -----------------------------------------------------------------------------
// Streaming (mid-run) states — previously untested (#794 item 2).
// -----------------------------------------------------------------------------

test("parallel collapsed mid-run: status header counts running tasks and shows the running sentinel", () => {
	const out = renderText(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				makeResult({ agent: "done-one" }),
				makeResult({ agent: "still-going", exitCode: -1, messages: [], model: undefined }),
			],
		},
		false,
	);
	assert.match(out, /1\/2 done, 1 running/);
	assert.match(out, /⏳/);
	assert.match(out, /\(running\.\.\.\)/, "running row shows the running sentinel, not (no output)");
	assert.match(out, /done-one · prov\/model-x/, "completed row carries its model label");
	assert.match(out, /still-going · model pending/, "running unpinned row shows the pending-model label");
});

test("parallel collapsed mid-run: partial output streams into the row before completion", () => {
	const out = renderText(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				makeResult({
					agent: "streamer",
					exitCode: -1,
					messages: [asstTool("read", { file_path: "/repo/src/a.ts" }), asstText("partial finding so far")],
				}),
			],
		},
		false,
	);
	assert.match(out, /0\/1 done, 1 running/);
	assert.match(out, /partial finding so far/);
	assert.match(out, /→ /, "tool-call arrow rendered mid-stream");
	// Totals are suppressed while tasks are still running.
	assert.doesNotMatch(out, /Total:/);
});

test("chain collapsed mid-run: per-step icons distinguish done, running, and failed", () => {
	const out = renderText(
		{
			mode: "chain",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				makeResult({ agent: "step-ok", step: 1 }),
				makeResult({ agent: "step-live", step: 2, exitCode: -1, messages: [] }),
			],
		},
		false,
	);
	assert.match(out, /Step 1: step-ok/);
	assert.match(out, /Step 2: step-live/);
	assert.match(out, /✓/);
	assert.match(out, /⏳/);
	assert.match(out, /1\/2 steps/);
});

test("parallel finished with one failure: mixed icon set and no running sentinel", () => {
	const out = renderText(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				makeResult({ agent: "winner" }),
				makeResult({ agent: "loser", exitCode: 1, stopReason: "error", messages: [asstText("boom")] }),
			],
		},
		false,
	);
	assert.match(out, /1\/2 tasks/);
	assert.match(out, /✓/);
	assert.match(out, /✗/);
	assert.doesNotMatch(out, /running/);
	assert.match(out, /Total:/, "totals render once nothing is running");
});

// -----------------------------------------------------------------------------
// Expanded per-row shape — the surface the #794 dedup must preserve.
// -----------------------------------------------------------------------------

test("chain expanded: step header, Task line, tool-call arrow, output, per-step usage, totals", () => {
	const out = renderText(
		{
			mode: "chain",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				makeResult({
					agent: "builder",
					step: 1,
					messages: [asstTool("bash", { command: "make build" }), asstText("built fine")],
				}),
				makeResult({ agent: "verifier", step: 2, messages: [asstText("verified")] }),
			],
		},
		true,
	);
	assert.match(out, /2\/2 steps/);
	assert.match(out, /─── Step 1: builder · prov\/model-x/);
	assert.match(out, /─── Step 2: verifier · prov\/model-x/);
	assert.match(out, /Task: inspect the flux capacitor/);
	assert.match(out, /\$ make build/);
	assert.match(out, /built fine/);
	assert.match(out, /verified/);
	assert.match(out, /2 turns/, "per-row usage footer");
	assert.match(out, /Total: 4 turns/, "aggregated totals across steps");
});

test("parallel expanded: unnumbered row headers, Task lines, and aggregated totals", () => {
	const out = renderText(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				makeResult({ agent: "a1", task: "task one" }),
				makeResult({ agent: "a2", task: "task two" }),
			],
		},
		true,
	);
	assert.match(out, /2\/2 tasks/);
	assert.match(out, /─── a1 · prov\/model-x ✓/);
	assert.match(out, /─── a2 · prov\/model-x ✓/);
	assert.doesNotMatch(out, /Step \d/, "parallel rows are not step-numbered");
	assert.match(out, /Task: task one/);
	assert.match(out, /Task: task two/);
	assert.match(out, /Total: 4 turns/);
});
