/**
 * subagent — guard-profile frontmatter tests (LOCAL PATCH #7; pi_config
 * #551, ADR-0091).
 *
 * Verifies the wrapper-side half of the report-only enforcement chain: the
 * `guard-profile` frontmatter key is parsed into AgentConfig.guardProfile,
 * absent/typo values behave as documented, and the repo's linter wrapper
 * actually declares the profile (the integration pin that keeps the
 * bash-destructive-guard profile reachable end-to-end).
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAgents } from "../agents.ts";
import { applyGuardProfile } from "../sanitize-env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

let fixtureCwd: string;

before(() => {
  fixtureCwd = mkdtempSync(join(tmpdir(), "subagent-guard-profile-"));
  const agentsDir = join(fixtureCwd, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "profiled.md"),
    `---\nname: profiled\ndescription: test wrapper with profile\ntools: bash\nguard-profile: report-only\n---\nbody\n`,
  );
  writeFileSync(
    join(agentsDir, "unprofiled.md"),
    `---\nname: unprofiled\ndescription: test wrapper without profile\ntools: bash\n---\nbody\n`,
  );
  writeFileSync(
    join(agentsDir, "typo.md"),
    `---\nname: typo\ndescription: test wrapper with unrecognized profile value\ntools: bash\nguard-profile: readonly-oops\n---\nbody\n`,
  );
});

after(() => {
  try {
    rmSync(fixtureCwd, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

test("guard-profile frontmatter is parsed into guardProfile", () => {
  const { agents } = discoverAgents(fixtureCwd, "project");
  const profiled = agents.find((a) => a.name === "profiled");
  assert.equal(profiled?.guardProfile, "report-only");
});

test("wrappers without the key have guardProfile undefined", () => {
  const { agents } = discoverAgents(fixtureCwd, "project");
  const unprofiled = agents.find((a) => a.name === "unprofiled");
  assert.equal(unprofiled?.guardProfile, undefined);
});

test("unrecognized values are preserved at parse time (spawn path drops them)", () => {
  // The parse layer is value-agnostic; index.ts only exports the recognized
  // value to PI_GUARD_PROFILE, so a typo yields no profile rather than a
  // half-armed one. This test pins the layering.
  const { agents } = discoverAgents(fixtureCwd, "project");
  const typo = agents.find((a) => a.name === "typo");
  assert.equal(typo?.guardProfile, "readonly-oops");
});

test("applyGuardProfile exports only the recognized value", () => {
  assert.equal(applyGuardProfile({}, "report-only").PI_GUARD_PROFILE, "report-only");
  assert.equal(applyGuardProfile({}, "readonly-oops").PI_GUARD_PROFILE, undefined);
  assert.equal(applyGuardProfile({}, undefined).PI_GUARD_PROFILE, undefined);
});

test("applyGuardProfile strips an inherited parent value for undeclared wrappers", () => {
  const env: NodeJS.ProcessEnv = { PI_GUARD_PROFILE: "report-only", PATH: "/usr/bin" };
  const out = applyGuardProfile(env, undefined);
  assert.equal(out.PI_GUARD_PROFILE, undefined);
  assert.equal(out.PATH, "/usr/bin");
});

test("integration pin: the repo linter wrapper declares guard-profile: report-only", () => {
  const linterMd = readFileSync(join(HERE, "..", "..", "..", "agents", "linter.md"), "utf-8");
  assert.match(linterMd, /^guard-profile: report-only$/m);
});
