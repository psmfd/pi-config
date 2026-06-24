import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCostTable,
  lookupCost,
  modelKey,
  normalizeCost,
  ZERO_COST,
} from "../cost.ts";

test("modelKey joins provider and id", () => {
  assert.equal(modelKey("anthropic", "claude-opus-4-5"), "anthropic/claude-opus-4-5");
});

test("normalizeCost fills missing fields with zero", () => {
  assert.deepEqual(normalizeCost({ input: 3, output: 15 }), {
    input: 3,
    output: 15,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(normalizeCost(undefined), ZERO_COST);
});

test("buildCostTable + lookupCost round-trip known models", () => {
  const table = buildCostTable([
    { provider: "anthropic", id: "opus", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 } },
    { provider: "local", id: "devstral" },
  ]);
  assert.deepEqual(lookupCost(table, "anthropic", "opus"), {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6,
  });
  // local model with no cost normalizes to zero
  assert.deepEqual(lookupCost(table, "local", "devstral"), ZERO_COST);
});

test("lookupCost falls back to ZERO_COST for unknown models", () => {
  const table = buildCostTable([]);
  assert.deepEqual(lookupCost(table, "nope", "missing"), ZERO_COST);
});

test("ZERO_COST is frozen (shared immutable constant)", () => {
  assert.ok(Object.isFrozen(ZERO_COST));
});
