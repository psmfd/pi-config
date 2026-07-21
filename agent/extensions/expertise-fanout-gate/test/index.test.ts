/**
 * expertise-fanout-gate — index.ts wiring tests (ADR-0095, #613).
 *
 * All I/O is injected: fake fetch, fake git executor, temp `.env.local`,
 * temp telemetry dir, fixed clock. The handler under test is registered on a
 * fake `pi` (the gh-identity-guard harness pattern) and invoked directly.
 *
 * The load-bearing assertions:
 *   - injection happens ONLY for research-shaped parallel fanouts;
 *   - the injected block round-trips through `parseCanonicalResultsBlock`
 *     with the sha the derivation predicts;
 *   - every failure path (no config, git probe down, network down, 429)
 *     resolves without throwing — the runtime does not catch tool_call
 *     handler exceptions, so "never throws" IS the fail-open contract;
 *   - a 429 arms the session backoff (no second fetch inside the window).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeCanonicalBlob } from "../../expertise-indexer/canonicalize.ts";
import { parseCanonicalResultsBlock } from "../../expertise-indexer/collector.ts";
import { deriveFanoutCanonicalInputs } from "../../expertise-indexer/fanout-derive.ts";
import type { ExecResult, GitExecutor } from "../lib/git-info.ts";
import { telemetryDir } from "../lib/telemetry.ts";

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

function makeCtx(cwd: string): unknown {
	return {
		cwd,
		hasUI: false,
		ui: {
			notify() {
				/* headless in tests */
			},
		},
	};
}

const HEAD_SHA = "c".repeat(40);
const ORIGIN = "git@github.com:psmfd/pi-config.git";

const okGit: GitExecutor = (args: readonly string[]): Promise<ExecResult> => {
	if (args[0] === "rev-parse") return Promise.resolve({ exitCode: 0, stdout: `${HEAD_SHA}\n` });
	return Promise.resolve({ exitCode: 0, stdout: `${ORIGIN}\n` });
};

const deadGit: GitExecutor = (): Promise<ExecResult> =>
	Promise.resolve({ exitCode: 1, stdout: "" });

const API_ROW = {
	id: "e-1",
	domain: "ansible",
	title: "Handler semantics",
	body: "Handlers fire once per play.",
	entryType: "Caveat",
	severity: "Warning",
};

function okFetch(calls: string[]): typeof fetch {
	return ((url: unknown) => {
		calls.push(String(url));
		return Promise.resolve(
			new Response(JSON.stringify({ results: [API_ROW] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}) as typeof fetch;
}

function researchInput(): Record<string, unknown> {
	return {
		tasks: [
			{ agent: "ansible-expert", task: "investigate handler semantics" },
			{ agent: "docker-expert", task: "investigate compose interplay" },
			{ agent: "shell-expert", task: "investigate hook wiring" },
		],
	};
}

interface Harness {
	dir: string;
	envPath: string;
	upstreamEnvPath: string;
	agentDir: string;
	calls: string[];
	handler: Handler;
	ctx: unknown;
	nowValue: { ms: number };
}

async function makeHarness(opts: {
	git?: GitExecutor;
	fetchImpl?: typeof fetch;
	envContent?: string | null;
	upstreamEnvContent?: string | null;
	calls?: string[];
}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "fanout-gate-"));
	const envPath = join(dir, "env.local");
	if (opts.envContent !== null) {
		writeFileSync(
			envPath,
			opts.envContent ??
				"PI_EXPERTISE_API_BASE_URL=http://127.0.0.1:8080\nPI_EXPERTISE_API_KEY=test-key\n",
		);
	}
	const upstreamEnvPath = join(dir, "secrets.env");
	if (opts.upstreamEnvContent !== undefined && opts.upstreamEnvContent !== null) {
		writeFileSync(upstreamEnvPath, opts.upstreamEnvContent);
	}
	const agentDir = join(dir, "agent");
	const calls = opts.calls ?? [];
	const nowValue = { ms: 1_750_000_000_000 };
	const pi = makePi();
	mod.default(pi as never, {
		fetchImpl: opts.fetchImpl ?? okFetch(calls),
		gitExec: opts.git ?? okGit,
		envPath,
		upstreamEnvPath,
		agentDir,
		now: () => nowValue.ms,
	});
	const handler = pi.handlers.tool_call?.[0];
	assert.ok(handler, "tool_call handler registered");
	return {
		dir,
		envPath,
		upstreamEnvPath,
		agentDir,
		calls,
		handler,
		ctx: makeCtx(dir),
		nowValue,
	};
}

function telemetryLines(agentDir: string): Record<string, unknown>[] {
	// Derive the path from the library helper, not a hardcoded literal, so a
	// change to the on-disk layout is caught in one place (#815).
	const dir = telemetryDir(agentDir);
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return [];
	}
	const lines: Record<string, unknown>[] = [];
	for (const f of files.sort()) {
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (line.trim().length > 0) lines.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return lines;
}

// Env hygiene: the gate reads process.env through buildClientConfig; a
// developer machine's real values must not leak into assertions.
const ENV_KEYS = [
	"PI_EXPERTISE_API_BASE_URL",
	"PI_EXPERTISE_API_KEY",
	"PI_EXPERTISE_ALLOW_LOCALDEV_WRITE",
	"EXPERTISE_API_BASE_URL",
	"EXPERTISE_API_TOKEN",
	"EXPERTISE_API_SECRETS_FILE",
];
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) {
	savedEnv[k] = process.env[k];
	delete process.env[k];
}
process.on("exit", () => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
	}
});

// --- tests -------------------------------------------------------------------

test("installed client env path follows PI_CODING_AGENT_DIR package layout", () => {
	assert.equal(
		mod.resolveInstalledClientEnvPath({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" }),
		join(
			"/tmp/pi-agent",
			"git",
			"github.com",
			"psmfd",
			"pi-expertise-client",
			".env.local",
		),
	);
});

test("research fanout gets the canonical block injected into every task", async (tc) => {
	const h = await makeHarness({});
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const input = researchInput();
	const out = await h.handler({ toolName: "subagent", input }, h.ctx);
	assert.equal(out, undefined);
	assert.equal(h.calls.length, 1);
	assert.match(h.calls[0], /\/expertise\/search\/semantic\?q=/);

	const tasks = input.tasks as Record<string, unknown>[];
	const blocks = tasks.map((t) => t.expertiseInjection);
	assert.equal(blocks.length, 3);
	assert.ok(blocks.every((b) => typeof b === "string" && b.length > 0));
	assert.equal(new Set(blocks).size, 1, "one fanout, one block");

	const payload = parseCanonicalResultsBlock(blocks[0] as string);
	assert.ok(payload);
	assert.equal(payload.results.length, 1);

	// The anchor is exactly what the shared derivation predicts.
	const expected = computeCanonicalBlob(
		deriveFanoutCanonicalInputs({
			repoOrigin: ORIGIN,
			headSha: HEAD_SHA,
			tasks: (researchInput().tasks as { agent: string; task: string }[]).map((t) => ({
				agent: t.agent,
				task: t.task,
			})),
		}),
	).sha;
	assert.equal(payload.canonical_blob_sha, expected);

	const rows = telemetryLines(h.agentDir);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].event, "inject");
	assert.equal(rows[0].canonicalBlobSha, expected);
});

test("upstream static-OIDC config injects over HTTPS with agent headers", async (tc) => {
	const seen: { url?: string; headers?: Record<string, string> } = {};
	const fetchImpl = ((url: unknown, init?: RequestInit) => {
		seen.url = String(url);
		seen.headers = init?.headers as Record<string, string>;
		return Promise.resolve(
			new Response(
				JSON.stringify({
					results: [
						{
							...API_ROW,
							title: { contentClass: "user-supplied-free-text", value: API_ROW.title },
							body: { contentClass: "user-supplied-free-text", value: API_ROW.body },
						},
					],
				}),
				{ status: 200 },
			),
		);
	}) as typeof fetch;
	const h = await makeHarness({
		envContent: null,
		upstreamEnvContent:
			"EXPERTISE_API_BASE_URL=https://expertise.lan.example\n" +
			"EXPERTISE_API_TOKEN=header.payload.signature\n",
		fetchImpl,
	});
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const input = researchInput();
	await h.handler({ toolName: "subagent", input }, h.ctx);
	assert.match(seen.url ?? "", /^https:\/\/expertise\.lan\.example\//);
	assert.equal(seen.headers?.authorization, "Bearer header.payload.signature");
	assert.equal(seen.headers?.["x-actor-class"], "agent");
	assert.match(seen.headers?.["user-agent"] ?? "", /pi-coding-agent/);
	assert.ok(
		(input.tasks as Record<string, unknown>[]).every(
			(t) => typeof t.expertiseInjection === "string",
		),
	);
	const block = (input.tasks as Record<string, unknown>[])[0]
		.expertiseInjection as string;
	const payload = parseCanonicalResultsBlock(block);
	assert.equal(payload?.results[0]?.title, API_ROW.title);
});

test("non-subagent tools, single mode, small and review-only fanouts pass through", async (tc) => {
	const h = await makeHarness({});
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const single = { agent: "ansible-expert", task: "x" };
	await h.handler({ toolName: "bash", input: { command: "ls" } }, h.ctx);
	await h.handler({ toolName: "subagent", input: single }, h.ctx);
	const two = researchInput();
	(two.tasks as unknown[]).pop();
	await h.handler({ toolName: "subagent", input: two }, h.ctx);
	const review = {
		tasks: [
			{ agent: "code-review-expert", task: "review" },
			{ agent: "security-review-expert", task: "review" },
			{ agent: "linter", task: "lint" },
		],
	};
	await h.handler({ toolName: "subagent", input: review }, h.ctx);

	assert.equal(h.calls.length, 0, "no search fired");
	assert.equal((single as Record<string, unknown>).expertiseInjection, undefined);
	assert.ok(
		(review.tasks as Record<string, unknown>[]).every(
			(t) => t.expertiseInjection === undefined,
		),
	);
});

test("caller-supplied injection makes the gate stand down", async (tc) => {
	const h = await makeHarness({});
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const input = researchInput();
	(input.tasks as Record<string, unknown>[])[1].expertiseInjection = "<!-- caller block -->";
	await h.handler({ toolName: "subagent", input }, h.ctx);
	assert.equal(h.calls.length, 0);
	assert.equal(
		(input.tasks as Record<string, unknown>[])[0].expertiseInjection,
		undefined,
		"gate did not fill the other tasks",
	);
});

test("missing config skips fail-open with telemetry", async (tc) => {
	const h = await makeHarness({ envContent: null });
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const input = researchInput();
	await h.handler({ toolName: "subagent", input }, h.ctx);
	assert.equal(h.calls.length, 0);
	assert.equal((input.tasks as Record<string, unknown>[])[0].expertiseInjection, undefined);
	const rows = telemetryLines(h.agentDir);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].event, "skip");
	assert.equal(rows[0].reason, "no-config");
});

test("git probe failure skips fail-open", async (tc) => {
	const h = await makeHarness({ git: deadGit });
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	await h.handler({ toolName: "subagent", input: researchInput() }, h.ctx);
	assert.equal(h.calls.length, 0);
	assert.equal(telemetryLines(h.agentDir)[0]?.reason, "no-git");
});

test("network failure never throws; fanout proceeds uninjected", async (tc) => {
	const rejecting = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
	const h = await makeHarness({ fetchImpl: rejecting });
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const input = researchInput();
	await assert.doesNotReject(async () => {
		await h.handler({ toolName: "subagent", input }, h.ctx);
	});
	assert.equal((input.tasks as Record<string, unknown>[])[0].expertiseInjection, undefined);
	assert.equal(telemetryLines(h.agentDir)[0]?.reason, "search-failed");
});

test("429 arms the session backoff; Retry-After honored; window expiry re-enables", async (tc) => {
	let fetchCount = 0;
	const fetch429 = (() => {
		fetchCount += 1;
		return Promise.resolve(
			new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
		);
	}) as unknown as typeof fetch;
	const h = await makeHarness({ fetchImpl: fetch429 });
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	await h.handler({ toolName: "subagent", input: researchInput() }, h.ctx);
	assert.equal(fetchCount, 1);

	// Second fanout inside the window: skipped without a fetch.
	await h.handler({ toolName: "subagent", input: researchInput() }, h.ctx);
	assert.equal(fetchCount, 1);

	// Past the Retry-After window: the gate tries again.
	h.nowValue.ms += 31_000;
	await h.handler({ toolName: "subagent", input: researchInput() }, h.ctx);
	assert.equal(fetchCount, 2);

	const reasons = telemetryLines(h.agentDir).map((r) => r.reason);
	assert.deepEqual(reasons, ["rate-limited", "rate-limited", "rate-limited"]);
});

test("a throwing dependency is swallowed (tool_call handlers are uncaught upstream)", async (tc) => {
	const bomb = ((): never => {
		throw new Error("synchronous fetch bomb");
	}) as unknown as typeof fetch;
	const h = await makeHarness({ fetchImpl: bomb });
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	await assert.doesNotReject(async () => {
		await h.handler({ toolName: "subagent", input: researchInput() }, h.ctx);
	});
});

test("overlapping fanouts never double-spend the one-search budget", async (tc) => {
	let resolveFetch: ((r: Response) => void) | undefined;
	let fetchCount = 0;
	const gatedFetch = (() => {
		fetchCount += 1;
		return new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
	}) as unknown as typeof fetch;
	const h = await makeHarness({ fetchImpl: gatedFetch });
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const first = h.handler({ toolName: "subagent", input: researchInput() }, h.ctx);
	// Give the first invocation time to reach the in-flight search.
	await new Promise((r) => setImmediate(r));
	const secondInput = researchInput();
	await h.handler({ toolName: "subagent", input: secondInput }, h.ctx);
	assert.equal(fetchCount, 1, "second overlapping fanout must not fire a search");
	assert.equal(
		(secondInput.tasks as Record<string, unknown>[])[0].expertiseInjection,
		undefined,
	);
	resolveFetch?.(
		new Response(JSON.stringify({ results: [API_ROW] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	await first;
	const reasons = telemetryLines(h.agentDir).map(
		(r) => `${String(r.event)}:${typeof r.reason === "string" ? r.reason : ""}`,
	);
	assert.ok(reasons.includes("skip:concurrent-fanout"));
	assert.ok(reasons.includes("inject:"));
});

test("malformed tasks arrays are left for the tool's own validation", async (tc) => {
	const h = await makeHarness({});
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	await h.handler({ toolName: "subagent", input: { tasks: [{ agent: 42, task: "x" }, "y", null] } }, h.ctx);
	await h.handler({ toolName: "subagent", input: { tasks: "not-an-array" } }, h.ctx);
	assert.equal(h.calls.length, 0);
});

test("overlapping fanouts racing on the git probe still spend one search (#815 TOCTOU)", async (tc) => {
	// Gate the FIRST git rev-parse so invocation A parks inside the git probe —
	// the window the pre-fix code left open by setting searchInFlight only after
	// the probe. The existing 'never double-spend' test gates the fetch, which is
	// too late to catch this race (mock git resolved same-microtask).
	let releaseGit: (() => void) | undefined;
	let revParseCalls = 0;
	const gatedGit: GitExecutor = (args: readonly string[]): Promise<ExecResult> => {
		if (args[0] === "rev-parse") {
			revParseCalls += 1;
			if (revParseCalls === 1) {
				return new Promise<ExecResult>((resolve) => {
					releaseGit = () => resolve({ exitCode: 0, stdout: `${HEAD_SHA}\n` });
				});
			}
			return Promise.resolve({ exitCode: 0, stdout: `${HEAD_SHA}\n` });
		}
		return Promise.resolve({ exitCode: 0, stdout: `${ORIGIN}\n` });
	};
	const calls: string[] = [];
	const h = await makeHarness({ git: gatedGit, calls });
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const first = h.handler({ toolName: "subagent", input: researchInput() }, h.ctx);
	// Let invocation A reach and park on the gated git probe.
	await new Promise((r) => setImmediate(r));
	const secondInput = researchInput();
	await h.handler({ toolName: "subagent", input: secondInput }, h.ctx);
	// searchInFlight is committed before the git probe, so B is rejected here.
	assert.equal(
		(secondInput.tasks as Record<string, unknown>[])[0].expertiseInjection,
		undefined,
		"second fanout must not inject while the first holds the one-search budget",
	);
	releaseGit?.();
	await first;
	assert.equal(calls.length, 1, "exactly one search fired across the overlap");
	const reasons = telemetryLines(h.agentDir).map(
		(r) => `${String(r.event)}:${typeof r.reason === "string" ? r.reason : ""}`,
	);
	assert.ok(reasons.includes("skip:concurrent-fanout"), "second logged concurrent-fanout");
	assert.ok(reasons.includes("inject:"));
});

test("a rejecting git executor hits the outer catch and records event=error (#815)", async (tc) => {
	// probeGitInfo has no internal try/catch, so a REJECTING executor (distinct
	// from deadGit, which resolves exitCode 1) propagates into the handler's
	// top-level catch — the load-bearing fail-open path, previously untested.
	const rejectingGit: GitExecutor = (): Promise<ExecResult> =>
		Promise.reject(new Error("git spawn blew up"));
	const h = await makeHarness({ git: rejectingGit });
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	await assert.doesNotReject(async () => {
		await h.handler({ toolName: "subagent", input: researchInput() }, h.ctx);
	});
	const rows = telemetryLines(h.agentDir);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].event, "error");
	assert.equal(typeof rows[0].detail, "string");
});

test("a secret-shaped token in a task is never sent as a query param (#815)", async (tc) => {
	const calls: string[] = [];
	const h = await makeHarness({ calls });
	tc.after(() => rm(h.dir, { recursive: true, force: true }));

	const token = `ghp_${"a".repeat(40)}`;
	const input = {
		tasks: [
			{ agent: "ansible-expert", task: `leaked ${token} in handler notes` },
			{ agent: "docker-expert", task: "investigate compose interplay" },
			{ agent: "shell-expert", task: "investigate hook wiring" },
		],
	};
	await h.handler({ toolName: "subagent", input }, h.ctx);
	assert.equal(calls.length, 0, "no outbound request when the query carries a secret");
	assert.equal((input.tasks as Record<string, unknown>[])[0].expertiseInjection, undefined);
	const rows = telemetryLines(h.agentDir);
	assert.equal(rows[0]?.reason, "secret-in-query");
	// The redacted query must not carry the raw token even in telemetry.
	assert.ok(
		!JSON.stringify(rows).includes(token),
		"raw token must not appear in telemetry",
	);
});

test("source-tree .env.local wins over the installed package copy (#815)", async (tc) => {
	// Exercises loadLegacyClientEnv's dual-source merge branch (deps.envPath
	// undefined) via the injectable path overrides — the merge that makes the
	// source-tree copy win was previously only tested at the path-string level.
	const dir = await mkdtemp(join(tmpdir(), "fanout-merge-"));
	tc.after(() => rm(dir, { recursive: true, force: true }));
	const installed = join(dir, "installed.env");
	const sourceTree = join(dir, "source.env");
	writeFileSync(
		installed,
		"PI_EXPERTISE_API_BASE_URL=http://127.0.0.1:8080\nPI_EXPERTISE_API_KEY=installed-key\n",
	);
	// Source-tree copy defines only the key; the base URL falls through from the
	// installed copy, proving the merge (not a wholesale override) and precedence.
	writeFileSync(sourceTree, "PI_EXPERTISE_API_KEY=source-key\n");

	const seen: Record<string, string>[] = [];
	const fetchImpl = ((url: unknown, init?: RequestInit) => {
		void url;
		seen.push((init?.headers ?? {}) as Record<string, string>);
		return Promise.resolve(
			new Response(JSON.stringify({ results: [API_ROW] }), { status: 200 }),
		);
	}) as typeof fetch;

	const pi = makePi();
	mod.default(pi as never, {
		fetchImpl,
		gitExec: okGit,
		installedClientEnvPath: installed,
		clientEnvPath: sourceTree,
		upstreamEnvPath: join(dir, "absent-secrets.env"),
		agentDir: join(dir, "agent"),
		now: () => 1_750_000_000_000,
	});
	const handler = pi.handlers.tool_call?.[0];
	assert.ok(handler, "tool_call handler registered");

	await handler({ toolName: "subagent", input: researchInput() }, makeCtx(dir));
	assert.equal(seen.length, 1, "merged config produced a valid search");
	// Local API-key profile carries the key as the bearer token.
	assert.equal(
		seen[0]?.authorization,
		"Bearer source-key",
		"source-tree key must win over the installed-package key",
	);
});
