/**
 * Spawn-integration test (#602 closeout, ADR-0095): drives the REAL
 * `subagent` tool registered by index.ts — not the pure helpers — and
 * asserts (a) `expertiseInjection` reaches the spawned child's argv as the
 * injected user-role `Task:` framing, and (b) a multi-child fanout's
 * EXPERTISE_CANDIDATES payloads flow through the real finalizer onto
 * `SubagentDetails.expertiseCandidates`.
 *
 * Isolation seams (no real pi binary, no network dependence asserted):
 *   - `PI_CODING_AGENT_DIR` → a temp agent dir with one test wrapper
 *     (set BEFORE importing index.ts; getAgentDir reads it per call).
 *   - `process.argv[1]` → a fake pi script (getPiInvocation spawns
 *     `process.execPath argv[1] …` when argv[1] exists on disk). The fake
 *     records its argv to a capture file and can emit a `message_end`
 *     JSONL event so the parent's stdout parser runs for real.
 *   - The test wrapper does NOT set `env-strict`, so the capture-file env
 *     vars pass through buildChildEnv's default passthrough mode.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderCanonicalResultsBlock } from "../../expertise-indexer/collector.ts";

const baseDir = mkdtempSync(join(tmpdir(), "subagent-itest-"));
const agentDir = join(baseDir, "agent");
mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(
	join(agentDir, "agents", "itest-agent.md"),
	// A restricted, bash-free tool surface: an undefined `tools` list makes
	// the wrapper local-forbidden (ADR-0094 structural floor), and with no
	// policy candidates the spawn is policy-blocked before argv is built.
	[
		"---",
		"name: itest-agent",
		"description: spawn-integration test agent",
		"tools: read, grep",
		"---",
		"",
	].join("\n"),
);

const capturePath = join(baseDir, "captured-argv.jsonl");
const fakePiPath = join(baseDir, "fake-pi.mjs");
writeFileSync(
	fakePiPath,
	[
		'import { appendFileSync } from "node:fs";',
		"appendFileSync(process.env.SUBAGENT_ITEST_CAPTURE, JSON.stringify(process.argv.slice(2)) + \"\\n\");",
		"// #841: record the depth stamp the parent's buildChildEnv applied.",
		"if (process.env.SUBAGENT_ITEST_DEPTH_CAPTURE) {",
		"  appendFileSync(process.env.SUBAGENT_ITEST_DEPTH_CAPTURE, String(process.env.PI_SUBAGENT_DEPTH) + \"\\n\");",
		"}",
		'const payload = process.env.SUBAGENT_ITEST_CHILD_OUTPUT ?? "";',
		"if (payload) {",
		"  process.stdout.write(JSON.stringify({ type: \"message_end\", message: { role: \"assistant\", content: [{ type: \"text\", text: payload }] } }) + \"\\n\");",
		"}",
		"",
	].join("\n"),
);

// Environment BEFORE the module import — getAgentDir and the child spawn
// both read process state at call time, but the registration-time tool
// description also calls getAgentDir.
const depthCapturePath = join(baseDir, "captured-depth.txt");

process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SUBAGENT_ITEST_CAPTURE = capturePath;
process.env.SUBAGENT_ITEST_DEPTH_CAPTURE = depthCapturePath;

const realArgv1 = process.argv[1];
process.argv[1] = fakePiPath;

const mod = await import("../index.ts");

interface RegisteredTool {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: (partial: unknown) => void,
		ctx: unknown,
	): Promise<{ content: unknown[]; details: Record<string, unknown> }>;
}

const registered: RegisteredTool[] = [];
mod.default({
	registerTool(def: RegisteredTool) {
		registered.push(def);
	},
	on() {
		/* session_start cache clears not needed here */
	},
} as never);

const tool = registered.find((t) => t.name === "subagent");
assert.equal(typeof tool?.execute, "function");

const ctx = {
	cwd: baseDir,
	hasUI: false,
	ui: {
		notify() {
			/* headless */
		},
	},
	modelRegistry: {
		getAvailable: () => [],
	},
};

const BLOCK = renderCanonicalResultsBlock(
	[
		{
			id: "e-1",
			domain: "itest",
			title: "T",
			body: "B",
			entryType: "Caveat",
			severity: "Info",
		},
	],
	"d".repeat(64),
);

const CANDIDATE_BLOCK = [
	"analysis done.",
	"<!-- BEGIN EXPERTISE_CANDIDATES -->",
	JSON.stringify({
		schemaVersion: 1,
		candidates: [
			{
				domain: "itest",
				title: "Spawn integration finding",
				body: "The fake pi emitted this candidate.",
				entryType: "Caveat",
				severity: "Warning",
				proposedBy: "itest-agent",
				dedupeQuery: "itest spawn integration",
				canonical_blob_sha: "d".repeat(64),
			},
		],
	}),
	"<!-- END EXPERTISE_CANDIDATES -->",
].join("\n");

// #841 (ADR-0118): runs FIRST — this file's final test owns the baseDir
// teardown, so the depth-refusal cases must precede it. The refusal fires
// before discovery/spawn, so the argv capture file must never be created.
test("depth guard: at the limit, every mode refuses before spawning", async () => {
	process.env.PI_SUBAGENT_DEPTH = "1"; // default maxSpawnDepth is 1
	try {
		const modes: Record<string, unknown>[] = [
			{ agent: "itest-agent", task: "single task" },
			{ tasks: [{ agent: "itest-agent", task: "parallel task" }] },
			{ chain: [{ agent: "itest-agent", task: "chain task" }] },
		];
		for (const params of modes) {
			const result = await tool!.execute(
				"tc-depth-refuse",
				params,
				undefined,
				() => {
					/* streaming updates not asserted */
				},
				ctx,
			);
			const first = result.content[0] as { type: string; text: string };
			assert.match(first.text, /spawn-depth limit is 1/);
			assert.match(first.text, /maxSpawnDepth/);
			assert.equal((result as { isError?: boolean }).isError, true);
		}
		assert.equal(existsSync(capturePath), false, "no child process was ever spawned");
	} finally {
		delete process.env.PI_SUBAGENT_DEPTH;
	}
});

test("depth guard: a garbage inherited depth reads as 0 and does not block", async () => {
	process.env.PI_SUBAGENT_DEPTH = "not-a-depth";
	try {
		const result = await tool!.execute(
			"tc-depth-garbage",
			{ agent: "itest-agent", task: "garbage-depth task" },
			undefined,
			() => {
				/* streaming updates not asserted */
			},
			ctx,
		);
		assert.notEqual((result as { isError?: boolean }).isError, true);
		assert.equal(existsSync(capturePath), true, "child spawned normally");
		// Reset the capture files so the injection test below still sees
		// exactly its own two children.
		writeFileSync(capturePath, "");
		writeFileSync(depthCapturePath, "");
	} finally {
		delete process.env.PI_SUBAGENT_DEPTH;
	}
});

test("expertiseInjection reaches each child's argv through the real dispatch", async (tc) => {
	tc.after(async () => {
		process.argv[1] = realArgv1;
		await rm(baseDir, { recursive: true, force: true });
	});
	process.env.SUBAGENT_ITEST_CHILD_OUTPUT = CANDIDATE_BLOCK;

	const result = await tool!.execute(
		"tc-itest-1",
		{
			tasks: [
				{ agent: "itest-agent", task: "alpha task", expertiseInjection: BLOCK },
				{ agent: "itest-agent", task: "beta task", expertiseInjection: BLOCK },
			],
		},
		undefined,
		() => {
			/* streaming updates not asserted */
		},
		ctx,
	);

	// (a) Both children received the injected block prepended to the
	// user-role Task: framing — the exact buildInjectedTaskArg shape.
	const argvLines = readFileSync(capturePath, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as string[]);
	assert.equal(argvLines.length, 2);
	const wantAlpha = `${BLOCK}\n\nTask: alpha task`;
	const wantBeta = `${BLOCK}\n\nTask: beta task`;
	const flat = argvLines.map((a) => a.join(" "));
	assert.ok(flat.some((a) => a.includes(wantAlpha)), "alpha child argv carries the injected block");
	assert.ok(flat.some((a) => a.includes(wantBeta)), "beta child argv carries the injected block");
	// The block must never travel via --append-system-prompt (no-mcp-servers.md).
	for (const argv of argvLines) {
		const idx = argv.indexOf("--append-system-prompt");
		assert.equal(idx, -1, "blank-system-prompt wrapper spawns without --append-system-prompt");
	}

	// #841 (ADR-0118): both children were stamped depth 1 (orchestrator is 0).
	const depthLines = readFileSync(depthCapturePath, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0);
	assert.deepEqual(depthLines, ["1", "1"], "children carry PI_SUBAGENT_DEPTH=1");

	// (b) The real finalizer coalesced the two children's identical
	// candidates into one group with orchestrator-attributed provenance.
	const details = result.details as {
		expertiseCandidates?: {
			groups: readonly {
				proposalCount: number;
				proposedByList: readonly string[];
				candidate: { title: string };
			}[];
		};
	};
	assert.ok(details.expertiseCandidates, "finalizer attached expertiseCandidates");
	assert.equal(details.expertiseCandidates.groups.length, 1);
	assert.equal(details.expertiseCandidates.groups[0].proposalCount, 2);
	assert.deepEqual(details.expertiseCandidates.groups[0].proposedByList, ["itest-agent"]);
	assert.equal(details.expertiseCandidates.groups[0].candidate.title, "Spawn integration finding");
});
