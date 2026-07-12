/**
 * subagent — per-wrapper strict-env wiring tests (LOCAL PATCH #11;
 * pi_config #606, follow-up to #596).
 *
 * Verifies the missing link #606 closes: `env-strict` / `env-allow` /
 * `env-allow-prefix` frontmatter parses into AgentConfig, buildChildEnv
 * translates those fields into SanitizeEnvOptions (composing the
 * guard-profile signal), the strict base now carries the pi plumbing
 * namespace without weakening the secret-suffix denies, and — the rollout
 * pin — every non-bash first-party wrapper actually declares strict mode.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAgents } from "../agents.ts";
import { buildChildEnv } from "../sanitize-env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_AGENTS_DIR = join(HERE, "..", "..", "..", "agents");

let fixtureCwd: string;

before(() => {
  fixtureCwd = mkdtempSync(join(tmpdir(), "subagent-strict-env-"));
  const agentsDir = join(fixtureCwd, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "strict.md"),
    `---\nname: strict\ndescription: strict wrapper\ntools: read\nenv-strict: true\nenv-allow: GH_TOKEN, SPECIAL_VAR\nenv-allow-prefix: AWS_, AZURE_\n---\nbody\n`,
  );
  writeFileSync(
    join(agentsDir, "default.md"),
    `---\nname: default\ndescription: wrapper without env keys\ntools: read\n---\nbody\n`,
  );
  writeFileSync(
    join(agentsDir, "typo.md"),
    `---\nname: typo\ndescription: unrecognized env-strict value\ntools: read\nenv-strict: yes\n---\nbody\n`,
  );
});

after(() => {
  try {
    rmSync(fixtureCwd, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

test("env-strict/env-allow/env-allow-prefix frontmatter parses into AgentConfig", () => {
  const { agents } = discoverAgents(fixtureCwd, "project");
  const strict = agents.find((a) => a.name === "strict");
  assert.equal(strict?.envStrict, true);
  assert.deepEqual(strict?.envAllow, ["GH_TOKEN", "SPECIAL_VAR"]);
  assert.deepEqual(strict?.envAllowPrefixes, ["AWS_", "AZURE_"]);
});

test("wrappers without the keys keep the default mode", () => {
  const { agents } = discoverAgents(fixtureCwd, "project");
  const dflt = agents.find((a) => a.name === "default");
  assert.equal(dflt?.envStrict, undefined);
  assert.equal(dflt?.envAllow, undefined);
  assert.equal(dflt?.envAllowPrefixes, undefined);
});

test("only the literal 'true' enables strict mode (fail-safe on typos)", () => {
  const { agents } = discoverAgents(fixtureCwd, "project");
  assert.equal(agents.find((a) => a.name === "typo")?.envStrict, undefined);
});

// --- buildChildEnv (pure composition) ---

const PARENT: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  RANDOM_VAR: "x",
  GH_TOKEN: "tok",
  PI_PACKAGE_DIR: "/opt/pi",
  PI_CODING_AGENT_DIR: "/home/u/.pi/agent",
  PI_EXPERTISE_API_KEY: "sekret",
  PI_EXPERTISE_ALLOW_LOCALDEV_WRITE: "1",
  HTTPS_PROXY: "http://proxy:3128",
};

test("strict wrapper: base allowlist + pi plumbing pass; arbitrary vars drop", () => {
  const env = buildChildEnv(PARENT, { envStrict: true });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.PI_PACKAGE_DIR, "/opt/pi");
  assert.equal(env.PI_CODING_AGENT_DIR, "/home/u/.pi/agent");
  assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
  assert.equal(env.RANDOM_VAR, undefined);
  assert.equal(env.GH_TOKEN, undefined);
});

test("strict wrapper: secret-suffix keys inside the PI_ namespace stay denied", () => {
  const env = buildChildEnv(PARENT, { envStrict: true });
  assert.equal(env.PI_EXPERTISE_API_KEY, undefined);
});

test("strict wrapper: ALWAYS_DENY beats everything, even an exact env-allow", () => {
  const env = buildChildEnv(PARENT, {
    envStrict: true,
    envAllow: ["PI_EXPERTISE_ALLOW_LOCALDEV_WRITE"],
  });
  assert.equal(env.PI_EXPERTISE_ALLOW_LOCALDEV_WRITE, undefined);
});

test("strict wrapper: per-wrapper env-allow re-admits a named secret", () => {
  const env = buildChildEnv(PARENT, { envStrict: true, envAllow: ["GH_TOKEN"] });
  assert.equal(env.GH_TOKEN, "tok");
});

test("default wrapper: passthrough with the always-deny strip, unchanged", () => {
  const env = buildChildEnv(PARENT, {});
  assert.equal(env.RANDOM_VAR, "x");
  assert.equal(env.GH_TOKEN, "tok");
  assert.equal(env.PI_EXPERTISE_ALLOW_LOCALDEV_WRITE, undefined);
});

test("guard-profile composes: set for report-only, stripped otherwise", () => {
  const withProfile = buildChildEnv(PARENT, { envStrict: true, guardProfile: "report-only" });
  assert.equal(withProfile.PI_GUARD_PROFILE, "report-only");
  const inherited = buildChildEnv({ ...PARENT, PI_GUARD_PROFILE: "report-only" }, { envStrict: true });
  assert.equal(inherited.PI_GUARD_PROFILE, undefined);
});

// --- rollout pin (#606) ---

test("integration pin: every first-party wrapper declares env-strict: true", () => {
  const wrappers = readdirSync(REPO_AGENTS_DIR).filter((f) => f.endsWith(".md"));
  assert.ok(wrappers.length >= 21, `expected the wrapper catalog, found ${wrappers.length} files`);
  for (const file of wrappers) {
    const content = readFileSync(join(REPO_AGENTS_DIR, file), "utf-8");
    assert.match(content, /^env-strict: true$/m, `${file} does not declare env-strict: true`);
  }
});

test("integration pin: credential-bearing wrappers carry their justified env-allow entries", () => {
  const expectations: Record<string, RegExp> = {
    "gh-cli-expert.md": /^env-allow: GH_TOKEN, GITHUB_TOKEN$/m,
    "gitflow-expert.md": /^env-allow: GH_TOKEN, GITHUB_TOKEN, SSH_AUTH_SOCK$/m,
    "work-item-management-expert.md": /^env-allow: GH_TOKEN, GITHUB_TOKEN, AZURE_DEVOPS_EXT_PAT$/m,
    "checkmarx-expert.md": /^env-allow: CX_APIKEY, CX_CLIENT_SECRET$/m,
    "helm-expert.md": /^env-allow: KUBECONFIG$/m,
  };
  for (const [file, pattern] of Object.entries(expectations)) {
    const content = readFileSync(join(REPO_AGENTS_DIR, file), "utf-8");
    assert.match(content, pattern, `${file} env-allow drifted from the justified set`);
  }
});
