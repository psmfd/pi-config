/**
 * shared/local-role.ts tests — the global local-LLM role lever (pi_config
 * #685, ADR-0094): strict value parsing and the hard candidate filter for
 * the two consumption contexts.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_LOCAL_ROLE,
  filterLocalCandidates,
  isLocalModelKey,
  isLocalProvider,
  parseLocalRole,
  readLocalRole,
} from "../local-role.ts";

test("parseLocalRole: only the three exact strings are recognized", () => {
  assert.equal(parseLocalRole("full"), "full");
  assert.equal(parseLocalRole("classifier-only"), "classifier-only");
  assert.equal(parseLocalRole("off"), "off");
  for (const bad of ["Full", "classifier", "OFF", true, 1, null, undefined, {}]) {
    assert.equal(parseLocalRole(bad), DEFAULT_LOCAL_ROLE, JSON.stringify(bad));
  }
});

test("isLocalProvider / isLocalModelKey: strict provider equality", () => {
  assert.equal(isLocalProvider("omlx"), true);
  assert.equal(isLocalProvider("omlx-cloud"), false);
  assert.equal(isLocalModelKey("omlx/coding-workhorse"), true);
  assert.equal(isLocalModelKey("omlx-cloud/thing"), false);
  assert.equal(isLocalModelKey("github-copilot/omlx"), false);
  assert.equal(isLocalModelKey("no-slash"), false);
});

test("filterLocalCandidates: role × context truth table", () => {
  const pool = [{ provider: "omlx" }, { provider: "anthropic" }];
  // full: local everywhere.
  assert.equal(filterLocalCandidates(pool, "full", "classifier").length, 2);
  assert.equal(filterLocalCandidates(pool, "full", "target").length, 2);
  // classifier-only: local runs the side-call, never the target.
  assert.equal(filterLocalCandidates(pool, "classifier-only", "classifier").length, 2);
  assert.deepEqual(filterLocalCandidates(pool, "classifier-only", "target"), [{ provider: "anthropic" }]);
  // off: local nowhere.
  assert.deepEqual(filterLocalCandidates(pool, "off", "classifier"), [{ provider: "anthropic" }]);
  assert.deepEqual(filterLocalCandidates(pool, "off", "target"), [{ provider: "anthropic" }]);
});

test("readLocalRole: reads the lever from an injected agent dir", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-role-"));
  try {
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ extensionSettings: { localLlm: { role: "classifier-only" } } }),
    );
    assert.equal(await readLocalRole(dir), "classifier-only");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readLocalRole: falls back to the default on missing file, bad JSON, or bad value", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-role-"));
  try {
    // Missing file.
    assert.equal(await readLocalRole(dir), DEFAULT_LOCAL_ROLE);
    // Malformed JSON.
    await fs.writeFile(path.join(dir, "settings.json"), "{nope");
    assert.equal(await readLocalRole(dir), DEFAULT_LOCAL_ROLE);
    // Unrecognized value.
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ extensionSettings: { localLlm: { role: "Full" } } }),
    );
    assert.equal(await readLocalRole(dir), DEFAULT_LOCAL_ROLE);
    // Absent block.
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({}));
    assert.equal(await readLocalRole(dir), DEFAULT_LOCAL_ROLE);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
