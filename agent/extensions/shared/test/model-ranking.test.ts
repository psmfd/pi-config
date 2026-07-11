import assert from "node:assert/strict";
import { test } from "node:test";

import type { Candidate } from "../candidates.ts";
import type { RoutingMatrix } from "../routing-matrix.ts";
import { costRank, orderRankedCandidates, resolveCapabilityPick } from "../model-ranking.ts";

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
