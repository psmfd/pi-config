/**
 * shared/local-role.ts tests — the global local-LLM role lever (pi_config
 * #685, ADR-0094): strict value parsing and the hard candidate filter for
 * the two consumption contexts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_LOCAL_ROLE,
  filterLocalCandidates,
  isLocalModelKey,
  isLocalProvider,
  parseLocalRole,
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
