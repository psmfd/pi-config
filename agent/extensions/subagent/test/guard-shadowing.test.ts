/**
 * subagent — guard-profile shadowing tests (LOCAL PATCH #10; pi_config
 * #671, ADR-0093).
 *
 * Verifies the fail-closed shadow gate: a project-scoped wrapper that
 * collides with a guard-profiled user wrapper is detected by
 * discoverAgents (both under scope "both" and the detection-only probe
 * under scope "project"), and evaluateShadowGate refuses widening shadows
 * outright, refuses profile-weakening shadows headlessly, and demands an
 * interactive confirm otherwise. Ordinary project overrides of unprofiled
 * names must remain untouched (the documented override feature).
 *
 * The user-agent catalog is injected via the runtime's agent-dir env
 * override (ENV_AGENT_DIR, i.e. PI_CODING_AGENT_DIR) so the test never
 * reads the developer's real ~/.pi/agent/agents.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAgents, evaluateShadowGate, type ProfiledShadow } from "../agents.ts";

// The runtime's config.ts computes this as `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`
// but does not re-export the constant from the package index.
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

let fixtureRoot: string;
let fixtureCwd: string;
let savedAgentDir: string | undefined;

function writeWrapper(dir: string, name: string, extra: string): void {
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: test wrapper\n${extra}---\nbody\n`);
}

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "subagent-guard-shadowing-"));

  // Injected user catalog: <agentDir>/agents/*.md
  const agentHome = join(fixtureRoot, "agent-home");
  const userAgentsDir = join(agentHome, "agents");
  mkdirSync(userAgentsDir, { recursive: true });
  savedAgentDir = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = agentHome;

  writeWrapper(userAgentsDir, "guarded", "tools: read, grep, bash\nguard-profile: report-only\n");
  writeWrapper(userAgentsDir, "guarded-widen", "tools: read\nguard-profile: report-only\n");
  writeWrapper(userAgentsDir, "guarded-equal", "tools: read, bash\nguard-profile: report-only\n");
  writeWrapper(userAgentsDir, "plain", "tools: read\n");

  // Project catalog: <cwd>/.pi/agents/*.md
  fixtureCwd = join(fixtureRoot, "project");
  const projectAgentsDir = join(fixtureCwd, ".pi", "agents");
  mkdirSync(projectAgentsDir, { recursive: true });

  // Weakens: same name, no guard-profile, tools a subset of the user's.
  writeWrapper(projectAgentsDir, "guarded", "tools: read, bash\n");
  // Widens: declares the same profile but adds a tool the user wrapper lacks.
  writeWrapper(projectAgentsDir, "guarded-widen", "tools: read, write\nguard-profile: report-only\n");
  // Equal profile, subset tools: a legitimate override, not a shadow.
  writeWrapper(projectAgentsDir, "guarded-equal", "tools: read\nguard-profile: report-only\n");
  // Unprofiled override of an unprofiled user wrapper: the documented feature.
  writeWrapper(projectAgentsDir, "plain", "tools: read, write\n");
});

after(() => {
  if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
  else process.env[ENV_AGENT_DIR] = savedAgentDir;
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

test("scope both: profile-weakening shadow is detected; project agent still wins the map", () => {
  const { agents, shadowedProfiledAgents } = discoverAgents(fixtureCwd, "both");
  const shadow = shadowedProfiledAgents.find((s) => s.name === "guarded");
  assert.ok(shadow, "expected a shadow entry for 'guarded'");
  assert.equal(shadow.weakensProfile, true);
  assert.equal(shadow.widensTools, false);
  assert.equal(shadow.userProfile, "report-only");
  // The documented override precedence is unchanged — detection only.
  const winner = agents.find((a) => a.name === "guarded");
  assert.equal(winner?.source, "project");
  assert.equal(winner?.guardProfile, undefined);
});

test("scope both: tool-surface widening is detected even with an equal profile", () => {
  const { shadowedProfiledAgents } = discoverAgents(fixtureCwd, "both");
  const shadow = shadowedProfiledAgents.find((s) => s.name === "guarded-widen");
  assert.ok(shadow, "expected a shadow entry for 'guarded-widen'");
  assert.equal(shadow.weakensProfile, false);
  assert.equal(shadow.widensTools, true);
});

test("scope both: equal profile with subset tools is not a shadow", () => {
  const { shadowedProfiledAgents } = discoverAgents(fixtureCwd, "both");
  assert.equal(
    shadowedProfiledAgents.find((s) => s.name === "guarded-equal"),
    undefined,
  );
});

test("scope both: unprofiled-over-unprofiled override is untouched", () => {
  const { agents, shadowedProfiledAgents } = discoverAgents(fixtureCwd, "both");
  assert.equal(
    shadowedProfiledAgents.find((s) => s.name === "plain"),
    undefined,
  );
  assert.equal(agents.find((a) => a.name === "plain")?.source, "project");
});

test("scope project: user catalog is probed detection-only; shadows still surface", () => {
  const { agents, shadowedProfiledAgents } = discoverAgents(fixtureCwd, "project");
  // The result set contains only project agents (scope semantics preserved)...
  assert.ok(agents.every((a) => a.source === "project"));
  // ...but the profiled-name collision is still detected.
  assert.ok(shadowedProfiledAgents.find((s) => s.name === "guarded"));
  assert.ok(shadowedProfiledAgents.find((s) => s.name === "guarded-widen"));
});

test("scope user: no project agents, no shadows", () => {
  const { shadowedProfiledAgents } = discoverAgents(fixtureCwd, "user");
  assert.deepEqual(shadowedProfiledAgents, []);
});

// --- evaluateShadowGate (pure policy) ---

const weakening: ProfiledShadow = {
  name: "guarded",
  userProfile: "report-only",
  weakensProfile: true,
  widensTools: false,
  userTools: ["read", "bash"],
  projectTools: ["read", "bash"],
};
const widening: ProfiledShadow = {
  name: "guarded-widen",
  userProfile: "report-only",
  weakensProfile: false,
  widensTools: true,
  userTools: ["read"],
  projectTools: ["read", "write"],
};

test("gate: allow when no requested agent is shadowed", () => {
  const decision = evaluateShadowGate([weakening], new Set(["other"]), true);
  assert.equal(decision.action, "allow");
});

test("gate: widening is refused outright, even with a UI", () => {
  const decision = evaluateShadowGate([widening], new Set(["guarded-widen"]), true);
  assert.equal(decision.action, "refuse");
  assert.match((decision as { reason: string }).reason, /widen the tool surface/);
});

test("gate: weakening shadow refuses headlessly", () => {
  const decision = evaluateShadowGate([weakening], new Set(["guarded"]), false);
  assert.equal(decision.action, "refuse");
  assert.match((decision as { reason: string }).reason, /cannot confirm interactively/);
});

test("gate: weakening shadow demands confirmation when a UI exists", () => {
  const decision = evaluateShadowGate([weakening], new Set(["guarded"]), true);
  assert.equal(decision.action, "confirm");
  const confirm = decision as { shadows: ProfiledShadow[]; message: string };
  assert.deepEqual(
    confirm.shadows.map((s) => s.name),
    ["guarded"],
  );
  assert.match(confirm.message, /DISABLE mechanical guard enforcement/);
});

test("gate: widening wins over weakening when both are requested", () => {
  const decision = evaluateShadowGate([weakening, widening], new Set(["guarded", "guarded-widen"]), true);
  assert.equal(decision.action, "refuse");
});
