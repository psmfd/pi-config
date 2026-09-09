// P2 feasibility fixture only. This is not the P5 production mutation boundary.
import {
  createBashToolDefinition,
  createLocalBashOperations,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const instanceId = randomUUID();
const overridesEnabled = process.env.PI_P2_ENABLE_OVERRIDES === "1";
const boundaryEnabled = process.env.PI_EXPERTISE_MUTATION_BOUNDARY !== "0";
const confinementBypassed = process.env.SKIP_BASH_CONFINEMENT === "1";
const localBash = createLocalBashOperations();
let sessionGeneration = 0;
let sessionReady = false;
let shutdownCount = 0;
let lastStartReason = "none";
let lastShutdownReason = "none";

function markExecution(operation) {
  const marker = process.env.P2_EXECUTION_MARKER;
  if (marker) appendFileSync(marker, `${operation}\n`, "utf8");
}

const writeOperations = {
  async mkdir(path) {
    markExecution("write:mkdir");
    await mkdir(path, { recursive: true });
  },
  async writeFile(path, content) {
    markExecution("write:writeFile");
    await writeFile(path, content, "utf8");
  },
};

const bashOperations = {
  async exec(command, cwd, options) {
    markExecution("bash:exec");
    return localBash.exec(command, cwd, options);
  },
};

function selectedTools(pi) {
  const active = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter((tool) => ["write", "edit", "bash"].includes(tool.name))
    .map((tool) => ({
      name: tool.name,
      active: active.has(tool.name),
      description: tool.description,
      parameters: tool.parameters,
      promptGuidelines: tool.promptGuidelines,
      sourceInfo: tool.sourceInfo,
    }));
}

function appendSnapshot(pi, ctx, reason) {
  const output = process.env.P2_PROBE_OUT;
  if (!output) throw new Error("P2_PROBE_OUT is required");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  appendFileSync(
    output,
    `${JSON.stringify({
      reason,
      instanceId,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionGeneration,
      sessionReady,
      shutdownCount,
      lastStartReason,
      lastShutdownReason,
      overridesEnabled,
      boundaryEnabled,
      confinementBypassed,
      tools: selectedTools(pi),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export default function p2OwnershipFixture(pi) {
  pi.on("session_shutdown", (event) => {
    sessionReady = false;
    shutdownCount += 1;
    lastShutdownReason = event.reason;
  });
  pi.on("session_start", (event) => {
    sessionGeneration += 1;
    sessionReady = true;
    lastStartReason = event.reason;
  });

  if (overridesEnabled && boundaryEnabled && !confinementBypassed) {
    pi.registerTool(
      createWriteToolDefinition(process.cwd(), { operations: writeOperations }),
    );
    pi.registerTool(
      createBashToolDefinition(process.cwd(), { operations: bashOperations }),
    );
  }

  pi.registerCommand("p2-snapshot", {
    description: "Record P2 effective mutation-tool ownership",
    handler: async (args, ctx) => {
      appendSnapshot(pi, ctx, args.trim() || "manual");
    },
  });

  pi.registerCommand("p2-set-active", {
    description: "Set active tools for the P2 feasibility probe",
    handler: async (args) => {
      const requested = args
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      pi.setActiveTools(requested);
    },
  });

  pi.registerCommand("p2-reload", {
    description: "Reload the P2 feasibility runtime",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
