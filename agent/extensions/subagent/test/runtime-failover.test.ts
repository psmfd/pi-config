import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { clearAvailabilitySnapshot } from "../../shared/availability-snapshot.ts";
import {
  clearSessionUnavailable,
  sessionUnavailableModels,
} from "../../shared/session-unavailable.ts";

const MODEL_A = "openai-codex/gpt-5.3-codex-spark";
const MODEL_B = "openai-codex/gpt-5.4";
const baseDir = mkdtempSync(join(tmpdir(), "subagent-failover-"));
const agentDir = join(baseDir, "agent");
const capturePath = join(baseDir, "captured.jsonl");
const fakePiPath = join(baseDir, "fake-pi.mjs");
mkdirSync(join(agentDir, "agents"), { recursive: true });

writeFileSync(
  join(agentDir, "agents", "policy-agent.md"),
  ["---", "name: policy-agent", "description: runtime failover policy agent", "tools: read, grep", "---", ""].join("\n"),
);
writeFileSync(
  join(agentDir, "agents", "pinned-agent.md"),
  [
    "---",
    "name: pinned-agent",
    "description: runtime failover pinned agent",
    "model: openai-codex/gpt-5.3-codex-spark",
    "tools: read, grep",
    "---",
    "",
  ].join("\n"),
);

writeFileSync(
  fakePiPath,
  [
    'import { appendFileSync } from "node:fs";',
    'const argv = process.argv.slice(2);',
    'const modelIndex = argv.indexOf("--model");',
    'const model = modelIndex >= 0 ? argv[modelIndex + 1] : "session/default";',
    'appendFileSync(process.env.FAILOVER_CAPTURE, JSON.stringify({ argv, model }) + "\\n");',
    'const rateLimited = new Set((process.env.FAILOVER_RATE_LIMIT_MODELS ?? "").split(",").filter(Boolean));',
    'const genericErrors = new Set((process.env.FAILOVER_GENERIC_ERROR_MODELS ?? "").split(",").filter(Boolean));',
    'const stderrOnly = new Set((process.env.FAILOVER_STDERR_RATE_LIMIT_MODELS ?? "").split(",").filter(Boolean));',
    'const toolFirst = new Set((process.env.FAILOVER_TOOL_FIRST_MODELS ?? "").split(",").filter(Boolean));',
    'const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 }, totalTokens: 10 };',
    'const delayMs = Number(process.env.FAILOVER_DELAY_MS ?? "0");',
    'if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));',
    'if (toolFirst.has(model)) {',
    '  process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "read" }) + "\\n");',
    '}',
    'if (stderrOnly.has(model)) {',
    '  process.stderr.write("429 quota exceeded\\n");',
    '  process.exitCode = 1;',
    '} else if (rateLimited.has(model)) {',
    '  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", model, content: [], stopReason: "error", errorMessage: "429 quota exceeded", usage } }) + "\\n");',
    '} else if (genericErrors.has(model)) {',
    '  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", model, content: [], stopReason: "error", errorMessage: "503 provider unavailable", usage } }) + "\\n");',
    '} else {',
    '  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", model, content: [{ type: "text", text: `ok:${model}` }], stopReason: "stop", usage } }) + "\\n");',
    '}',
  ].join("\n"),
);

process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.FAILOVER_CAPTURE = capturePath;
const realArgv1 = process.argv[1];
process.argv[1] = fakePiPath;

const mod = await import("../index.ts");

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: {
    results: Array<{
      agent: string;
      model?: string;
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        contextTokens: number;
        turns: number;
      };
      failover?: {
        attemptedModels: string[];
        failedModel: string;
        fallbackModel?: string;
        outcome: string;
        snapshotGeneration?: number;
        snapshotHash?: string;
      };
    }>;
  };
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: (partial: unknown) => void,
    ctx: unknown,
  ): Promise<ToolResult>;
}

const registered: RegisteredTool[] = [];
mod.default({
  registerTool(def: RegisteredTool) {
    registered.push(def);
  },
  on() {
    // Tests clear shared session state directly between invocations.
  },
} as never);
const tool = registered.find((entry) => entry.name === "subagent");
assert.ok(tool);

let availableModels = [
  { provider: "openai-codex", id: "gpt-5.3-codex-spark", contextWindow: 128_000, cost: { input: 1, output: 1 } },
  { provider: "openai-codex", id: "gpt-5.4", contextWindow: 272_000, cost: { input: 2, output: 2 } },
];
const ctx = {
  cwd: baseDir,
  hasUI: false,
  ui: { notify() {}, confirm: () => Promise.resolve(true) },
  modelRegistry: {
    getAvailable: () => availableModels,
    find: () => undefined,
    getApiKeyAndHeaders: () => ({ ok: false }),
  },
};

function captures(): Array<{ argv: string[]; model: string }> {
  try {
    return readFileSync(capturePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; model: string });
  } catch {
    return [];
  }
}

beforeEach(() => {
  clearAvailabilitySnapshot();
  clearSessionUnavailable();
  writeFileSync(capturePath, "");
  availableModels = [
    { provider: "openai-codex", id: "gpt-5.3-codex-spark", contextWindow: 128_000, cost: { input: 1, output: 1 } },
    { provider: "openai-codex", id: "gpt-5.4", contextWindow: 272_000, cost: { input: 2, output: 2 } },
  ];
  delete process.env.FAILOVER_RATE_LIMIT_MODELS;
  delete process.env.FAILOVER_GENERIC_ERROR_MODELS;
  delete process.env.FAILOVER_STDERR_RATE_LIMIT_MODELS;
  delete process.env.FAILOVER_TOOL_FIRST_MODELS;
  delete process.env.FAILOVER_DELAY_MS;
});

after(async () => {
  process.argv[1] = realArgv1;
  clearAvailabilitySnapshot();
  clearSessionUnavailable();
  await rm(baseDir, { recursive: true, force: true });
});

async function execute(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return tool!.execute("tc-failover", params, signal, () => {}, ctx);
}

test("policy-selected pre-tool 429 retries once on the next matrix model", async () => {
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.notEqual(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A, MODEL_B]);
  assert.deepEqual(result.details.results[0].failover, {
    attemptedModels: [MODEL_A, MODEL_B],
    failedModel: MODEL_A,
    fallbackModel: MODEL_B,
    outcome: "succeeded",
    snapshotGeneration: result.details.results[0].failover?.snapshotGeneration,
    snapshotHash: result.details.results[0].failover?.snapshotHash,
  });
  assert.equal(typeof result.details.results[0].failover?.snapshotGeneration, "number");
  assert.match(result.details.results[0].failover?.snapshotHash ?? "", /^sha256:/);
  assert.match(result.content[0].text, /runtime failover/);
  assert.deepEqual(result.details.results[0].usage, {
    input: 2,
    output: 4,
    cacheRead: 6,
    cacheWrite: 8,
    cost: 1,
    contextTokens: 10,
    turns: 2,
  });
  assert.deepEqual([...sessionUnavailableModels], [MODEL_A]);
});

test("retry budget is one and a second 429 marks both models unavailable", async () => {
  process.env.FAILOVER_RATE_LIMIT_MODELS = `${MODEL_A},${MODEL_B}`;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A, MODEL_B]);
  assert.equal(result.details.results[0].failover?.outcome, "fallback-failed");
  assert.deepEqual(result.details.results[0].failover?.attemptedModels, [MODEL_A, MODEL_B]);
  assert.deepEqual([...sessionUnavailableModels].sort(), [MODEL_A, MODEL_B].sort());
});

test("a tool edge before the 429 forbids replay", async () => {
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;
  process.env.FAILOVER_TOOL_FIRST_MODELS = MODEL_A;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(result.details.results[0].failover?.outcome, "not-retried-after-tool");
  assert.deepEqual([...sessionUnavailableModels], [MODEL_A]);
});

test("explicit wrapper pins never runtime-fail over", async () => {
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;
  const result = await execute({ agent: "pinned-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(result.details.results[0].failover, undefined);
  assert.equal(sessionUnavailableModels.size, 0);
});

test("generic provider failures are not retried or denied", async () => {
  process.env.FAILOVER_GENERIC_ERROR_MODELS = MODEL_A;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(result.details.results[0].failover, undefined);
  assert.equal(sessionUnavailableModels.size, 0);
});

test("stderr-only 429 text is not trusted as a retry signal", async () => {
  process.env.FAILOVER_STDERR_RATE_LIMIT_MODELS = MODEL_A;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(result.details.results[0].failover, undefined);
  assert.equal(sessionUnavailableModels.size, 0);
});

test("a structured 429 from a session-default child is not retried", async () => {
  availableModels = [
    { provider: "unlisted-provider", id: "unlisted-model", contextWindow: 128_000, cost: { input: 1, output: 1 } },
  ];
  process.env.FAILOVER_RATE_LIMIT_MODELS = "session/default";
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), ["session/default"]);
  assert.equal(result.details.results[0].failover, undefined);
  assert.equal(sessionUnavailableModels.size, 0);
});

test("an aborted child is not retried", async () => {
  process.env.FAILOVER_DELAY_MS = "1000";
  const controller = new AbortController();
  const pending = execute({ agent: "policy-agent", task: "test" }, controller.signal);
  for (let i = 0; i < 100 && captures().length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(captures().length, 1, "child reached the fake runtime before abort");
  controller.abort();
  await assert.rejects(pending, /Subagent was aborted/);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(sessionUnavailableModels.size, 0);
});

test("no eligible alternate returns structured no-alternate telemetry without a second spawn", async () => {
  availableModels = availableModels.slice(0, 1);
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(result.details.results[0].failover?.outcome, "no-alternate");
  assert.match(result.content[0].text, /no eligible alternate/);
});

test("parallel mode preserves input ordering while sharing the session deny state", async () => {
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;
  const result = await execute({
    tasks: [
      { agent: "policy-agent", task: "alpha" },
      { agent: "policy-agent", task: "beta" },
    ],
  });

  assert.notEqual(result.isError, true);
  assert.deepEqual(result.details.results.map((entry) => entry.agent), ["policy-agent", "policy-agent"]);
  assert.ok(result.details.results.every((entry) => entry.model === MODEL_B));
  const spawned = captures().map((entry) => entry.model);
  assert.ok(spawned.length === 3 || spawned.length === 4, `unexpected spawn count: ${spawned.length}`);
  assert.ok(spawned.includes(MODEL_A));
  assert.ok(spawned.includes(MODEL_B));
  assert.deepEqual([...sessionUnavailableModels], [MODEL_A]);
});

test("chain preserves result ordering after a first-step failover", async () => {
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;
  const result = await execute({
    chain: [
      { agent: "policy-agent", task: "first" },
      { agent: "policy-agent", task: "second {previous}" },
    ],
  });

  assert.notEqual(result.isError, true);
  assert.deepEqual(result.details.results.map((entry) => entry.agent), ["policy-agent", "policy-agent"]);
  assert.equal(result.details.results[0].failover?.outcome, "succeeded");
  assert.equal(result.details.results[1].model, MODEL_B);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A, MODEL_B, MODEL_B]);
});
