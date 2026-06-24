import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, getUsage, THRESHOLDS, type UsageContext } from "../signals.ts";

test("classify maps fractions to threshold bands at exact boundaries", () => {
  assert.equal(classify(0), "ok");
  assert.equal(classify(0.69), "ok");
  assert.equal(classify(THRESHOLDS.PRUNE_AT), "prune");
  assert.equal(classify(0.84), "prune");
  assert.equal(classify(THRESHOLDS.ESCALATE_AT), "escalate");
  assert.equal(classify(0.89), "escalate");
  assert.equal(classify(THRESHOLDS.FORCE_COMPACT_AT), "force");
  assert.equal(classify(1.5), "force");
});

function ctx(usage: { tokens?: number } | undefined | null, contextWindow?: number): UsageContext {
  return { getContextUsage: () => usage, model: { contextWindow } };
}

test("getUsage normalizes tokens + window into pct and level", () => {
  const u = getUsage(ctx({ tokens: 90_000 }, 100_000));
  assert.deepEqual(u, { tokens: 90_000, window: 100_000, pct: 0.9, level: "force" });
});

test("getUsage returns null when usage is undefined", () => {
  assert.equal(getUsage(ctx(undefined, 100_000)), null);
});

test("getUsage returns null when usage has no token count", () => {
  assert.equal(getUsage(ctx({}, 100_000)), null);
});

test("getUsage returns null when the window is missing or non-positive", () => {
  assert.equal(getUsage(ctx({ tokens: 1000 }, undefined)), null);
  assert.equal(getUsage(ctx({ tokens: 1000 }, 0)), null);
});

test("getUsage clamps negative fractions to zero", () => {
  const u = getUsage(ctx({ tokens: -5 }, 100));
  assert.equal(u?.pct, 0);
  assert.equal(u?.level, "ok");
});
