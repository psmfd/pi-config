/**
 * subagent — spawn-time model policy tests (LOCAL PATCH #12; pi_config #685,
 * ADR-0094, extending the ADR-0090 seam extracted to policy-model.ts).
 *
 * Covers the lever → local-llm tag → matrix composition, the structural
 * bash floor the tag can never override, the applyLocalRole pin backstop
 * (fail-closed even on an unreadable registry), and the first-party wrapper
 * migration pins: no `model: omlx/*` frontmatter remains, the tag never
 * appears on a bash-capable wrapper, and only literal-true enables it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Candidate } from "../../shared/candidates.ts";
import type { RoutingMatrix } from "../../shared/routing-matrix.ts";
import type { AgentConfig } from "../agents.ts";
import { applyLocalRole } from "../model-pin.ts";
import { isLocalForbiddenAgent, selectSubagentPolicyModel } from "../policy-model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_AGENTS_DIR = join(HERE, "..", "..", "..", "agents");

function cand(provider: string, id: string, input: number, window = 200_000): Candidate {
  return { provider, id, contextWindow: window, cost: { input, output: input * 4, cacheRead: 0, cacheWrite: 0 } };
}

function agentCfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "t",
    description: "test wrapper",
    tools: ["read"],
    systemPrompt: "body",
    source: "user",
    filePath: "/tmp/t.md",
    ...overrides,
  };
}

const MATRIX: RoutingMatrix = {
  v: 1,
  lastReviewed: "2026-07-11",
  models: {
    "omlx/coding-workhorse": { capable: ["agentic-loop"] },
    "github-copilot/frontier": { capable: ["agentic-loop"] },
  },
};

const POOL = [cand("omlx", "coding-workhorse", 0), cand("github-copilot", "frontier", 3)];

test("explicit wrapper pin bypasses the policy seam entirely", () => {
  assert.equal(selectSubagentPolicyModel(agentCfg({ model: "github-copilot/x" }), POOL, MATRIX, "full"), null);
});

test("tagged non-bash agent under full lever gets the matrix's local pick", () => {
  const sel = selectSubagentPolicyModel(agentCfg({ localLlm: true }), POOL, MATRIX, "full");
  assert.ok(sel && "model" in sel);
  assert.equal(sel.model, "omlx/coding-workhorse");
});

test("untagged agent never rides local — matrix picks the non-local row", () => {
  const sel = selectSubagentPolicyModel(agentCfg(), POOL, MATRIX, "full");
  assert.ok(sel && "model" in sel);
  assert.equal(sel.model, "github-copilot/frontier");
});

test("the tag cannot override the structural bash floor", () => {
  const bashAgent = agentCfg({ localLlm: true, tools: ["read", "bash"] });
  assert.equal(isLocalForbiddenAgent(bashAgent), true);
  const sel = selectSubagentPolicyModel(bashAgent, POOL, MATRIX, "full");
  assert.ok(sel && "model" in sel);
  assert.equal(sel.model, "github-copilot/frontier");
});

test("classifier-only and off both strip local for children", () => {
  for (const role of ["classifier-only", "off"] as const) {
    const sel = selectSubagentPolicyModel(agentCfg({ localLlm: true }), POOL, MATRIX, role);
    assert.ok(sel && "model" in sel, `role=${role}`);
    assert.equal(sel.model, "github-copilot/frontier", `role=${role}`);
  }
});

test("local-forbidden agent with no non-local matrix pick still fails closed", () => {
  const localOnlyMatrix: RoutingMatrix = {
    v: 1,
    lastReviewed: "2026-07-11",
    models: { "omlx/coding-workhorse": { capable: ["agentic-loop"] } },
  };
  const sel = selectSubagentPolicyModel(
    agentCfg({ tools: ["read", "bash"] }),
    POOL,
    localOnlyMatrix,
    "full",
  );
  assert.ok(sel && "blockedReason" in sel);
});

test("non-forbidden agent with no matrix pick falls through to session default (null)", () => {
  const sel = selectSubagentPolicyModel(agentCfg({ localLlm: true }), POOL, null, "full");
  assert.equal(sel, null);
});

// --- capability-tier (quality floor, #656) ---

const TIERED_MATRIX: RoutingMatrix = {
  v: 1,
  lastReviewed: "2026-07-12",
  models: {
    "omlx/coding-workhorse": { capable: ["agentic-loop"], tier: "fast" },
    "github-copilot/frontier": { capable: ["agentic-loop"], tier: "frontier" },
    "github-copilot/mid": { capable: ["agentic-loop"], tier: "capable" },
    "openai/sol": { capable: ["agentic-loop"], tier: "frontier" },
  },
};
const TIERED_POOL = [
  cand("omlx", "coding-workhorse", 0),
  cand("github-copilot", "frontier", 3),
  cand("github-copilot", "mid", 1),
];

test("capability-tier: frontier agent gets the highest-tier credentialed pick, cost ignored", () => {
  const sel = selectSubagentPolicyModel(
    agentCfg({ tools: ["read", "bash"], capabilityTier: "frontier" }),
    TIERED_POOL,
    TIERED_MATRIX,
    "full",
  );
  assert.ok(sel && "model" in sel);
  assert.equal(sel.model, "github-copilot/frontier");
  assert.match(sel.note, /tier frontier/);
});

test("capability-tier: or-better — a capable request may resolve to a frontier row", () => {
  const noMidPool = [cand("github-copilot", "frontier", 3)];
  const sel = selectSubagentPolicyModel(
    agentCfg({ capabilityTier: "capable" }),
    noMidPool,
    TIERED_MATRIX,
    "full",
  );
  assert.ok(sel && "model" in sel);
  assert.equal(sel.model, "github-copilot/frontier");
});

test("capability-tier: an uncredentialed provider's row is inert, not an error", () => {
  // openai/sol is frontier in the matrix but absent from the candidate pool
  // (no credential) — selection proceeds over what exists.
  const sel = selectSubagentPolicyModel(
    agentCfg({ capabilityTier: "frontier" }),
    TIERED_POOL,
    TIERED_MATRIX,
    "full",
  );
  assert.ok(sel && "model" in sel);
  assert.equal(sel.model, "github-copilot/frontier");
});

test("capability-tier: no qualifying tiered row falls through to untiered selection", () => {
  const untieredMatrix: RoutingMatrix = {
    v: 1,
    lastReviewed: "2026-07-12",
    models: { "github-copilot/mid": { capable: ["agentic-loop"] } },
  };
  const sel = selectSubagentPolicyModel(
    agentCfg({ capabilityTier: "frontier" }),
    TIERED_POOL,
    untieredMatrix,
    "full",
  );
  assert.ok(sel && "model" in sel);
  assert.equal(sel.model, "github-copilot/mid");
});

test("capability-tier: tier selection still respects the local-eligibility pool", () => {
  const localFrontierMatrix: RoutingMatrix = {
    v: 1,
    lastReviewed: "2026-07-12",
    models: {
      "omlx/coding-workhorse": { capable: ["agentic-loop"], tier: "frontier" },
      "github-copilot/frontier": { capable: ["agentic-loop"], tier: "frontier" },
    },
  };
  // Untagged agent: local is out of the pool even if a local row claims frontier.
  const sel = selectSubagentPolicyModel(
    agentCfg({ capabilityTier: "frontier" }),
    TIERED_POOL,
    localFrontierMatrix,
    "full",
  );
  assert.ok(sel && "model" in sel);
  assert.equal(sel.model, "github-copilot/frontier");
});

// --- applyLocalRole (pin backstop) ---

test("applyLocalRole: full is a passthrough", () => {
  const ids = new Set(["omlx/coding-workhorse", "github-copilot/frontier"]);
  const gate = applyLocalRole("omlx/coding-workhorse", ids, "full");
  assert.equal(gate.requestedModel, "omlx/coding-workhorse");
  assert.equal(gate.availableIds, ids);
  assert.equal(gate.note, undefined);
});

test("applyLocalRole: restricted lever drops a local pin with a note and strips local ids", () => {
  const ids = new Set(["omlx/coding-workhorse", "github-copilot/frontier"]);
  const gate = applyLocalRole("omlx/coding-workhorse", ids, "classifier-only");
  assert.equal(gate.requestedModel, undefined);
  assert.match(gate.note ?? "", /localLlm\.role=classifier-only/);
  assert.deepEqual([...(gate.availableIds ?? [])], ["github-copilot/frontier"]);
});

test("applyLocalRole: fail-closed on an unreadable registry (availableIds null)", () => {
  const gate = applyLocalRole("omlx/coding-workhorse", null, "off");
  assert.equal(gate.requestedModel, undefined);
  assert.equal(gate.availableIds, null);
  assert.ok(gate.note);
});

test("applyLocalRole: non-local pins pass through under a restricted lever", () => {
  const gate = applyLocalRole("github-copilot/frontier", null, "off");
  assert.equal(gate.requestedModel, "github-copilot/frontier");
  assert.equal(gate.note, undefined);
});

// --- first-party wrapper migration pins (#685) ---

test("integration pin: no first-party wrapper carries any model: pin (#656)", () => {
  for (const file of readdirSync(REPO_AGENTS_DIR).filter((f) => f.endsWith(".md"))) {
    const content = readFileSync(join(REPO_AGENTS_DIR, file), "utf-8");
    assert.equal(
      /^model:/m.test(content),
      false,
      `${file} carries a model: pin — use capability-tier / local-llm (the pin is an escape hatch only)`,
    );
  }
});

test("integration pin: the review trio declares capability-tier: frontier", () => {
  for (const file of ["checkmarx-expert.md", "code-review-expert.md", "security-review-expert.md"]) {
    const content = readFileSync(join(REPO_AGENTS_DIR, file), "utf-8");
    assert.match(content, /^capability-tier: frontier$/m, file);
  }
});

test("integration pin: local-llm tag never appears on a bash-capable wrapper", () => {
  let tagged = 0;
  for (const file of readdirSync(REPO_AGENTS_DIR).filter((f) => f.endsWith(".md"))) {
    const content = readFileSync(join(REPO_AGENTS_DIR, file), "utf-8");
    if (!/^local-llm: true$/m.test(content)) continue;
    tagged += 1;
    const tools = content.match(/^tools:(.*)$/m)?.[1] ?? "";
    assert.equal(tools.includes("bash"), false, `${file} is bash-capable but tagged local-llm: true`);
  }
  assert.equal(tagged, 13, `expected the 13 migrated wrappers, found ${tagged}`);
});

test("combined local-llm + capability-tier: tier pick may select local ONLY within lever+tag eligibility", () => {
  const localFrontier: RoutingMatrix = {
    v: 1,
    lastReviewed: "2026-07-12",
    models: {
      "omlx/coding-workhorse": { capable: ["agentic-loop"], tier: "frontier" },
      "github-copilot/frontier": { capable: ["agentic-loop"], tier: "frontier" },
    },
  };
  // Eligible (tagged, non-bash, lever full): a local row claiming the tier is
  // selectable — tier ties break on window desc then lexical, and the copilot
  // candidate's larger window wins here; pin the deterministic outcome.
  const eligible = selectSubagentPolicyModel(
    agentCfg({ localLlm: true, capabilityTier: "frontier" }),
    [cand("omlx", "coding-workhorse", 0, 131_072), cand("github-copilot", "frontier", 3)],
    localFrontier,
    "full",
  );
  assert.ok(eligible && "model" in eligible);
  assert.equal(eligible.model, "github-copilot/frontier");
  // Restricted lever: identical wrapper, local can never be the tier pick.
  const restricted = selectSubagentPolicyModel(
    agentCfg({ localLlm: true, capabilityTier: "frontier" }),
    [cand("omlx", "coding-workhorse", 0, 131_072), cand("github-copilot", "frontier", 3)],
    localFrontier,
    "off",
  );
  assert.ok(restricted && "model" in restricted);
  assert.equal(restricted.model, "github-copilot/frontier");
  // Local-only pool + eligible: the local row satisfies the tier request.
  const localOnly = selectSubagentPolicyModel(
    agentCfg({ localLlm: true, capabilityTier: "frontier" }),
    [cand("omlx", "coding-workhorse", 0, 131_072)],
    localFrontier,
    "full",
  );
  assert.ok(localOnly && "model" in localOnly);
  assert.equal(localOnly.model, "omlx/coding-workhorse");
});
