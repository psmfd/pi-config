import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { clearAvailabilitySnapshot } from "../../shared/availability-snapshot.ts";
import { clearSessionUnavailable, sessionDeny } from "../../shared/session-unavailable.ts";

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
  join(agentDir, "agents", "omlx-pinned-agent.md"),
  [
    "---",
    "name: omlx-pinned-agent",
    "description: pin that is absent on this host, so the Copilot rung is consulted",
    "model: omlx/coding-workhorse",
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
      pinNote?: string;
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
  assert.deepEqual(sessionDeny.models().map((record) => record.key), [MODEL_A]);
});

test("retry budget is one and a second 429 marks both models unavailable", async () => {
  process.env.FAILOVER_RATE_LIMIT_MODELS = `${MODEL_A},${MODEL_B}`;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A, MODEL_B]);
  assert.equal(result.details.results[0].failover?.outcome, "fallback-failed");
  assert.deepEqual(result.details.results[0].failover?.attemptedModels, [MODEL_A, MODEL_B]);
  assert.deepEqual(sessionDeny.models().map((record) => record.key).sort(), [MODEL_A, MODEL_B].sort());
});

test("a tool edge before the 429 forbids replay", async () => {
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;
  process.env.FAILOVER_TOOL_FIRST_MODELS = MODEL_A;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(result.details.results[0].failover?.outcome, "not-retried-after-tool");
  assert.deepEqual(sessionDeny.models().map((record) => record.key), [MODEL_A]);
});

test("explicit wrapper pins never runtime-fail over", async () => {
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;
  const result = await execute({ agent: "pinned-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(result.details.results[0].failover, undefined);
  assert.equal(sessionDeny.size, 0);
});

test("generic provider failures are not retried or denied", async () => {
  process.env.FAILOVER_GENERIC_ERROR_MODELS = MODEL_A;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(result.details.results[0].failover, undefined);
  assert.equal(sessionDeny.size, 0);
});

test("stderr-only 429 text is not trusted as a retry signal", async () => {
  process.env.FAILOVER_STDERR_RATE_LIMIT_MODELS = MODEL_A;
  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
  assert.equal(result.details.results[0].failover, undefined);
  assert.equal(sessionDeny.size, 0);
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
  assert.equal(sessionDeny.size, 0);
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
  assert.equal(sessionDeny.size, 0);
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
  assert.deepEqual(sessionDeny.models().map((record) => record.key), [MODEL_A]);
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

// --- ADR-0126 (#903): the provider breaker and explicit pins ----------------

const PROVIDER = "openai-codex";

test("an explicit pin fails closed on a provider breaker, with provenance and a remedy", async () => {
  sessionDeny.markProvider(PROVIDER, { source: "operator", reason: "operator disable" });
  const result = await execute({ agent: "pinned-agent", task: "test" });

  assert.equal(result.isError, true);
  // Fail CLOSED: the pin is never silently swapped, and no child is spawned
  // onto a provider the operator took out of service.
  assert.deepEqual(captures(), [], "no spawn");
  const text = result.content[0]?.text ?? "";
  assert.match(text, /openai-codex\/gpt-5\.3-codex-spark/, "names the refused pin");
  assert.match(text, /disabled for this session/);
  assert.match(text, /operator: operator disable/, "carries source and reason");
  assert.match(text, /\/auto providers enable openai-codex/, "names the remedy");
});

test("an auto-escalated breaker refuses a pin the same way as an operator disable", async () => {
  sessionDeny.mark(`${PROVIDER}/gpt-5.5`, { rateLimited: true });
  sessionDeny.mark(`${PROVIDER}/gpt-5.6-sol`, { rateLimited: true });
  assert.equal(sessionDeny.isProviderDenied(PROVIDER), true, "precondition: breaker tripped");

  const result = await execute({ agent: "pinned-agent", task: "test" });
  assert.equal(result.isError, true);
  assert.deepEqual(captures(), []);
  assert.match(result.content[0]?.text ?? "", /auto-escalation: 2 distinct models rate-limited/);
});

test("a MODEL-scope deny of the pinned id still spawns (ADR-0122 pins stay authoritative)", async () => {
  // The breaker is provider scope only. ADR-0122 decided an explicit pin runs
  // and returns its own failure for a model-scope deny; that must not regress.
  sessionDeny.mark(MODEL_A, { rateLimited: false });
  const result = await execute({ agent: "pinned-agent", task: "test" });

  assert.notEqual(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A]);
});

test("a tripped breaker refuses every parallel pinned child without spawning", async () => {
  sessionDeny.markProvider(PROVIDER, { source: "operator", reason: "operator disable" });
  const result = await execute({
    tasks: [
      { agent: "pinned-agent", task: "one" },
      { agent: "pinned-agent", task: "two" },
      { agent: "pinned-agent", task: "three" },
    ],
  });

  assert.deepEqual(captures(), [], "deterministic: zero spawns regardless of scheduling");
  assert.equal(result.details.results.length, 3);
  assert.match(result.content[0]?.text ?? "", /disabled for this session/);
  for (const row of result.details.results) {
    assert.equal(row.usage.turns, 0, "every child refused before spawning");
  }
});

test("reselection blocked by a tripped breaker reports provider-breaker, not no-alternate", async () => {
  // One prior rate-limited model of this provider, so MODEL_A's own 429 is the
  // second piece of evidence and trips the breaker mid-failover. Reselection
  // then finds nothing — but for a reason the operator can act on.
  sessionDeny.mark(`${PROVIDER}/gpt-5.5`, { rateLimited: true });
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;

  const result = await execute({ agent: "policy-agent", task: "test" });

  assert.equal(result.isError, true);
  assert.deepEqual(captures().map((entry) => entry.model), [MODEL_A], "one spawn, no sibling probe");
  assert.equal(sessionDeny.isProviderDenied(PROVIDER), true);
  const failover = result.details.results[0]?.failover;
  assert.equal(failover?.outcome, "provider-breaker");
  assert.deepEqual(failover?.attemptedModels, [MODEL_A]);
  assert.match(result.content[0]?.text ?? "", /provider "openai-codex" is disabled for this session/);
  assert.match(result.content[0]?.text ?? "", /\/auto providers enable openai-codex/);
});

test("a plain matrix miss still reports no-alternate, not provider-breaker", async () => {
  // No breaker: only MODEL_A is credentialed, so its 429 leaves no alternate.
  availableModels = [
    { provider: "openai-codex", id: "gpt-5.3-codex-spark", contextWindow: 128_000, cost: { input: 1, output: 1 } },
  ];
  process.env.FAILOVER_RATE_LIMIT_MODELS = MODEL_A;

  const result = await execute({ agent: "policy-agent", task: "test" });
  assert.equal(result.details.results[0]?.failover?.outcome, "no-alternate");
  assert.equal(sessionDeny.isProviderDenied(PROVIDER), false, "one model is not a pattern");
});

test("a breaker tripped MID-fan-out disables the Copilot rung for later children", async () => {
  // Regression guard for the staleness found while designing fan-out re-queue:
  // `buildCopilotFallback` runs ONCE per tool call, before any child spawns, so
  // a breaker state captured there goes stale the moment a child trips one.
  // Chain mode makes the ordering deterministic — step 2 spawns strictly after
  // step 1 completes, inside the SAME tool call and the same prebuilt rung.
  availableModels = [
    // cheapest capable row → step 1's policy pick
    { provider: "github-copilot", id: "claude-sonnet-5", contextWindow: 200_000, cost: { input: 1, output: 1 } },
    // the rung's default substitute, registry-present so the pre-fix code path
    // would genuinely have substituted it
    { provider: "github-copilot", id: "gpt-5-mini", contextWindow: 128_000, cost: { input: 9, output: 9 } },
    // the non-Copilot alternate step 1 fails over to
    { provider: "openai-codex", id: "gpt-5.4", contextWindow: 272_000, cost: { input: 5, output: 5 } },
  ];
  // One prior rate-limited Copilot model, so step 1's single 429 is the SECOND
  // piece of evidence and trips the breaker partway through the tool call.
  sessionDeny.mark("github-copilot/claude-opus-4.8", { rateLimited: true });
  process.env.FAILOVER_RATE_LIMIT_MODELS = "github-copilot/claude-sonnet-5";

  const result = await execute({
    chain: [
      { agent: "policy-agent", task: "trip the breaker" },
      { agent: "omlx-pinned-agent", task: "consult the rung" },
    ],
  });

  assert.equal(sessionDeny.isProviderDenied("github-copilot"), true, "step 1 tripped the breaker");
  const spawned = captures().map((entry) => entry.model);
  assert.equal(
    spawned.includes("github-copilot/gpt-5-mini"),
    false,
    "step 2 must not spawn onto the breaker-excluded Copilot rung",
  );
  // Step 2 ran on the session default with the breaker named, not on a
  // substituted Copilot model.
  const step2 = result.details.results[1];
  assert.ok(step2);
  // "session/default" is the fake child's self-report when no --model reached
  // argv (the honest-reporting path); assert on the captured argv directly.
  assert.equal(captures().at(-1)?.argv.includes("--model"), false, "no --model pin reached argv");
  assert.match(step2.pinNote ?? "", /Copilot fallback rung is disabled this session/);
  assert.match(step2.pinNote ?? "", /provider breaker: auto-escalation/);
});
