import assert from "node:assert/strict";
import { test } from "node:test";

import type { Candidate } from "../candidates.ts";
import type { RoutingMatrix } from "../routing-matrix.ts";
import { costRank, orderRankedCandidates, resolveCapabilityPick, resolveTierPick } from "../model-ranking.ts";

function cand(provider: string, id: string, input: number, window = 200_000): Candidate {
  return { provider, id, contextWindow: window, cost: { input, output: input * 4, cacheRead: 0, cacheWrite: 0 } };
}

const M = (models: Record<string, { capable: string[] }>): RoutingMatrix => ({
  v: 1,
  lastReviewed: "2026-07-11",
  models,
});

const NONE = new Set<string>();

test("costRank uses input + output with k=1", () => {
  const c: Candidate = { provider: "p", id: "m", contextWindow: 1, cost: { input: 2, output: 7, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(costRank(c), 9);
});

test("orderRankedCandidates ranks local providers above cheaper non-local when local is preferred", () => {
  const local = cand("omlx", "coding-workhorse", 0, 200_000);
  const remote = cand("github-copilot", "free-mini", 0, 100_000);
  assert.deepEqual(orderRankedCandidates([remote, local]).map((c) => `${c.provider}/${c.id}`), [
    "omlx/coding-workhorse",
    "github-copilot/free-mini",
  ]);
});

test("orderRankedCandidates can disable the local-first lane", () => {
  const local = cand("omlx", "coding-workhorse", 0, 200_000);
  const remote = cand("github-copilot", "free-mini", 0, 100_000);
  assert.deepEqual(orderRankedCandidates([local, remote], { preferLocal: false }).map((c) => `${c.provider}/${c.id}`), [
    "github-copilot/free-mini",
    "omlx/coding-workhorse",
  ]);
});

test("resolveCapabilityPick applies capability floor before local-first cheapest ranking", () => {
  const local = cand("omlx", "coding-workhorse", 0, 200_000);
  const cheapIncapable = cand("github-copilot", "free-mini", 0, 100_000);
  const capableRemote = cand("openai", "capable", 1, 100_000);
  const matrix = M({
    "omlx/coding-workhorse": { capable: ["code-edit"] },
    "openai/capable": { capable: ["code-edit"] },
  });
  const pick = resolveCapabilityPick([cheapIncapable, capableRemote, local], "code-edit", matrix, NONE, null);
  assert.equal(pick && `${pick.provider}/${pick.id}`, "omlx/coding-workhorse");
});

test("resolveCapabilityPick removes local only when caller filters it out before ranking", () => {
  const local = cand("omlx", "coding-workhorse", 0, 200_000);
  const remote = cand("openai", "provider-pick", 0.1, 100_000);
  const matrix = M({
    "omlx/coding-workhorse": { capable: ["code-review"] },
    "openai/provider-pick": { capable: ["code-review"] },
  });
  const localForbiddenCandidates = [local, remote].filter((c) => c.provider !== "omlx");
  const pick = resolveCapabilityPick(localForbiddenCandidates, "code-review", matrix, NONE, null);
  assert.equal(pick && `${pick.provider}/${pick.id}`, "openai/provider-pick");
});

// --- resolveTierPick (#656; direct coverage added by the #788 review) -------

const T = (
  models: Record<string, { capable: string[]; tier?: "frontier" | "capable" | "fast" }>,
): RoutingMatrix => ({ v: 1, lastReviewed: "2026-07-11", models });

test("resolveTierPick enforces the tier floor and excludes untiered rows", () => {
  const fast = cand("openai", "fast-model", 1, 100_000);
  const capable = cand("openai", "capable-model", 2, 100_000);
  const untiered = cand("openai", "untiered-model", 0, 400_000);
  const matrix = T({
    "openai/fast-model": { capable: ["code-edit"], tier: "fast" },
    "openai/capable-model": { capable: ["code-edit"], tier: "capable" },
    "openai/untiered-model": { capable: ["code-edit"] },
  });
  const pick = resolveTierPick([fast, capable, untiered], "capable", "code-edit", matrix, NONE);
  assert.equal(pick && `${pick.provider}/${pick.id}`, "openai/capable-model");
});

test("resolveTierPick picks the HIGHEST qualifying tier, ignoring cost", () => {
  const cheapCapable = cand("openai", "cheap-capable", 0, 100_000);
  const pricyFrontier = cand("anthropic", "pricy-frontier", 20, 100_000);
  const matrix = T({
    "openai/cheap-capable": { capable: ["research"], tier: "capable" },
    "anthropic/pricy-frontier": { capable: ["research"], tier: "frontier" },
  });
  const pick = resolveTierPick([cheapCapable, pricyFrontier], "capable", "research", matrix, NONE);
  assert.equal(pick && `${pick.provider}/${pick.id}`, "anthropic/pricy-frontier");
});

test("resolveTierPick filters on taskType coverage and the unavailable set", () => {
  const a = cand("openai", "a", 1, 100_000);
  const b = cand("openai", "b", 1, 100_000);
  const matrix = T({
    "openai/a": { capable: ["research"], tier: "frontier" },
    "openai/b": { capable: ["code-edit"], tier: "frontier" },
  });
  // a covers research but is unavailable; b does not cover research.
  const pick = resolveTierPick([a, b], "fast", "research", matrix, new Set(["openai/a"]));
  assert.equal(pick, null);
});

test("resolveTierPick tie-breaks on context window then provider/id lexical order", () => {
  const small = cand("openai", "zz-small", 1, 100_000);
  const bigLexLater = cand("openai", "m-big", 1, 200_000);
  const bigLexEarlier = cand("anthropic", "a-big", 1, 200_000);
  const matrix = T({
    "openai/zz-small": { capable: ["code-edit"], tier: "capable" },
    "openai/m-big": { capable: ["code-edit"], tier: "capable" },
    "anthropic/a-big": { capable: ["code-edit"], tier: "capable" },
  });
  const pick = resolveTierPick([small, bigLexLater, bigLexEarlier], "fast", "code-edit", matrix, NONE);
  assert.equal(pick && `${pick.provider}/${pick.id}`, "anthropic/a-big");
});

test("resolveTierPick returns null with no matrix", () => {
  assert.equal(resolveTierPick([cand("openai", "x", 1)], "fast", "code-edit", null, NONE), null);
});
