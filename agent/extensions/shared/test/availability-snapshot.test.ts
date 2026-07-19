import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  buildAvailabilitySnapshot,
  clearAvailabilitySnapshot,
  getAvailabilitySnapshot,
  peekAvailabilitySnapshot,
  type AvailabilitySnapshotContext,
} from "../availability-snapshot.ts";
import { clearAnthropicCache } from "../anthropic-discovery.ts";
import { clearCopilotCache, type FetchLike } from "../copilot-discovery.ts";
import { clearOmlxCache } from "../omlx-discovery.ts";

interface Model {
  provider: string;
  id: string;
  contextWindow: number;
  baseUrl?: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const MODELS: Model[] = [
  { provider: "github-copilot", id: "enabled", contextWindow: 100_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { provider: "github-copilot", id: "gated", contextWindow: 100_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { provider: "anthropic", id: "served", contextWindow: 200_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 } },
  { provider: "anthropic", id: "retired", contextWindow: 200_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 } },
  { provider: "omlx", id: "workhorse", contextWindow: 131_072, baseUrl: "http://localhost:8000/v1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { provider: "omlx", id: "unloaded", contextWindow: 131_072, baseUrl: "http://localhost:8000/v1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { provider: "openai-codex", id: "stable", contextWindow: 272_000, cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
];

function context(models: readonly Model[] = MODELS): AvailabilitySnapshotContext & { reads: number } {
  let reads = 0;
  const ctx: AvailabilitySnapshotContext & { reads: number } = {
    get reads() {
      return reads;
    },
    modelRegistry: {
      getAvailable: () => {
        reads += 1;
        return models;
      },
      find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: (model) => {
        const provider = (model as Model).provider;
        return provider === "github-copilot"
          ? { ok: true, apiKey: "proxy-ep=proxy.individual.githubcopilot.com;x=1" }
          : { ok: true, apiKey: "test-key" };
      },
    },
  };
  return ctx;
}

const providerFetch: FetchLike = async (url) => {
  const host = new URL(url).hostname;
  if (host === "githubcopilot.com" || host.endsWith(".githubcopilot.com")) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: "enabled", model_picker_enabled: true }] }),
    };
  }
  if (host === "api.anthropic.com") {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: "served" }], has_more: false, last_id: null }),
    };
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ id: "workhorse" }] }),
  };
};

beforeEach(() => {
  clearAvailabilitySnapshot();
  clearCopilotCache();
  clearAnthropicCache();
  clearOmlxCache();
});

test("builds one canonical generation from one registry read and all live filters", async () => {
  const ctx = context();
  const snapshot = await buildAvailabilitySnapshot(ctx, {
    fetchFn: providerFetch,
    now: () => Date.parse("2026-07-16T00:00:00Z"),
    generation: 7,
  });

  assert.equal(ctx.reads, 1);
  assert.equal(snapshot.generation, 7);
  assert.match(snapshot.hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    snapshot.candidates.map((candidate) => `${candidate.provider}/${candidate.id}`),
    ["anthropic/served", "github-copilot/enabled", "omlx/workhorse", "openai-codex/stable"],
  );
  assert.deepEqual(snapshot.filters.copilot, { state: "verified", ids: ["enabled"] });
  assert.deepEqual(snapshot.filters.anthropic, { state: "verified", ids: ["served"] });
  assert.deepEqual(snapshot.filters.omlx, { state: "verified", ids: ["workhorse"] });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.candidates), true);
  assert.equal(Object.isFrozen(snapshot.candidates[0]?.cost), true);
});

test("equivalent registry evidence yields the same hash independent of input order and generation", async () => {
  const forward = await buildAvailabilitySnapshot(context(MODELS), {
    fetchFn: providerFetch,
    now: () => 1,
    generation: 1,
  });
  clearCopilotCache();
  clearAnthropicCache();
  clearOmlxCache();
  const reverse = await buildAvailabilitySnapshot(context([...MODELS].reverse()), {
    fetchFn: providerFetch,
    now: () => 2,
    generation: 99,
  });
  assert.equal(forward.hash, reverse.hash);
  assert.deepEqual(forward.registryCandidates, reverse.registryCandidates);
  assert.deepEqual(forward.candidates, reverse.candidates);
});

test("shared cache freezes one generation until explicitly cleared and supports read-only peek", async () => {
  const ctx = context();
  assert.equal(peekAvailabilitySnapshot(), null);
  const firstPromise = getAvailabilitySnapshot(ctx, { fetchFn: providerFetch, now: () => 1 });
  assert.equal(peekAvailabilitySnapshot(), firstPromise);
  const first = await firstPromise;
  const second = await getAvailabilitySnapshot(context([]), { fetchFn: providerFetch, now: () => 2 });
  assert.equal(second, first);
  assert.equal(ctx.reads, 1);

  clearAvailabilitySnapshot();
  assert.equal(peekAvailabilitySnapshot(), null);
  const third = await getAvailabilitySnapshot(ctx, { fetchFn: providerFetch, now: () => 3 });
  assert.equal(third.generation, first.generation + 1);
  assert.notEqual(third, first);
  assert.equal(third.hash, first.hash);
});

test("a stale rejected build cannot evict a newer generation after clear", async () => {
  let rejectOld: ((error: Error) => void) | undefined;
  const oldContext: AvailabilitySnapshotContext = {
    modelRegistry: {
      getAvailable: () => new Promise<readonly Model[]>((_resolve, reject) => {
        rejectOld = reject;
      }),
      find: () => undefined,
      getApiKeyAndHeaders: () => ({ ok: false }),
    },
  };
  const oldBuild = getAvailabilitySnapshot(oldContext);
  clearAvailabilitySnapshot();
  const replacement = await getAvailabilitySnapshot(context(), { fetchFn: providerFetch });
  assert.ok(rejectOld, "old registry read did not start");
  rejectOld(new Error("old generation failed"));
  await assert.rejects(oldBuild, /old generation failed/);

  const cached = await getAvailabilitySnapshot(context([]));
  assert.equal(cached, replacement);
});

test("a cleared generation cannot begin late provider discovery after its registry read resolves", async () => {
  let resolveOld: ((models: readonly Model[]) => void) | undefined;
  let oldFetches = 0;
  const oldContext: AvailabilitySnapshotContext = {
    modelRegistry: {
      getAvailable: () =>
        new Promise<readonly Model[]>((resolve) => {
          resolveOld = resolve;
        }),
      find: (provider, id) => MODELS.find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: () => ({ ok: true, apiKey: "must-not-be-used" }),
    },
  };
  const oldBuild = getAvailabilitySnapshot(oldContext, {
    fetchFn: async () => {
      oldFetches += 1;
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });

  clearAvailabilitySnapshot();
  clearCopilotCache();
  clearAnthropicCache();
  clearOmlxCache();
  const replacement = await getAvailabilitySnapshot(context(), { fetchFn: providerFetch });
  assert.ok(resolveOld, "older registry read did not start");
  resolveOld(MODELS);
  await oldBuild;

  assert.equal(oldFetches, 0, "cleared generation must not start provider discovery");
  assert.equal(await getAvailabilitySnapshot(context([])), replacement);
});

test("marks absent providers not-applicable without probing", async () => {
  let fetches = 0;
  const onlyOpenAi = MODELS.filter((model) => model.provider === "openai-codex");
  const snapshot = await buildAvailabilitySnapshot(context(onlyOpenAi), {
    fetchFn: () => {
      fetches += 1;
      return Promise.reject(new Error("must not fetch"));
    },
  });
  assert.equal(fetches, 0);
  assert.equal(snapshot.filters.copilot.state, "not-applicable");
  assert.equal(snapshot.filters.anthropic.state, "not-applicable");
  assert.equal(snapshot.filters.omlx.state, "not-applicable");
  assert.equal(snapshot.candidates.length, 1);
});

test("Copilot and Anthropic discovery failures remain inconclusive and fail open", async () => {
  const remoteModels = MODELS.filter((model) => model.provider !== "omlx");
  const snapshot = await buildAvailabilitySnapshot(context(remoteModels), {
    fetchFn: () => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") }),
  });
  assert.equal(snapshot.filters.copilot.state, "inconclusive");
  assert.equal(snapshot.filters.anthropic.state, "inconclusive");
  assert.equal(snapshot.filters.omlx.state, "not-applicable");
  assert.deepEqual(snapshot.candidates, snapshot.registryCandidates);
});

test("confirmed-down oMLX is a verified empty filter and removes only local candidates", async () => {
  const localAndRemote = MODELS.filter((model) => model.provider === "omlx" || model.provider === "openai-codex");
  const snapshot = await buildAvailabilitySnapshot(context(localAndRemote), {
    fetchFn: async () => {
      throw new Error("connection refused");
    },
  });
  assert.deepEqual(snapshot.filters.omlx, { state: "verified", ids: [] });
  assert.deepEqual(snapshot.candidates.map((candidate) => candidate.provider), ["openai-codex"]);
});
