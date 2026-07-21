import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeCost, ZERO_COST } from "../cost.ts";

test("normalizeCost fills missing fields with zero", () => {
  assert.deepEqual(normalizeCost({ input: 3, output: 15 }), {
    input: 3,
    output: 15,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(normalizeCost(undefined), ZERO_COST);
});

test("normalizeCost of a full cost is identity-shaped", () => {
  const full = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 };
  assert.deepEqual(normalizeCost(full), full);
});

test("ZERO_COST is frozen (shared immutable constant)", () => {
  assert.ok(Object.isFrozen(ZERO_COST));
});
