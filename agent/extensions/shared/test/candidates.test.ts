import assert from "node:assert/strict";
import { test } from "node:test";

import { getCandidates, type CandidatesContext, type RegistryModel } from "../candidates.ts";

function ctx(models: readonly RegistryModel[], async = false): CandidatesContext {
  return {
    modelRegistry: {
      getAvailable: () => (async ? Promise.resolve(models) : models),
    },
  };
}

const MODELS: RegistryModel[] = [
  { provider: "anthropic", id: "opus", contextWindow: 200_000, cost: { input: 5, output: 25 } },
  { provider: "anthropic", id: "haiku", contextWindow: 200_000 },
  { provider: "local", id: "devstral" },
];

test("getCandidates returns all credentialed models when no allowlist", async () => {
  const out = await getCandidates(ctx(MODELS));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    provider: "anthropic",
    id: "opus",
    contextWindow: 200_000,
    cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
  });
});

test("getCandidates awaits an async getAvailable()", async () => {
  const out = await getCandidates(ctx(MODELS, true));
  assert.equal(out.length, 3);
});

test("getCandidates filters by allowlist (provider/id)", async () => {
  const out = await getCandidates(ctx(MODELS), { allowlist: ["anthropic/haiku", "local/devstral"] });
  assert.deepEqual(
    out.map((c) => `${c.provider}/${c.id}`),
    ["anthropic/haiku", "local/devstral"],
  );
});

test("getCandidates applies the default context window when the registry omits it", async () => {
  const out = await getCandidates(ctx([{ provider: "local", id: "devstral" }]), {
    defaultContextWindow: 32_000,
  });
  assert.equal(out[0]?.contextWindow, 32_000);
});

test("getCandidates falls back to 128000 window by default", async () => {
  const out = await getCandidates(ctx([{ provider: "local", id: "devstral" }]));
  assert.equal(out[0]?.contextWindow, 128_000);
});

test("getCandidates ignores an empty allowlist (treats as no filter)", async () => {
  const out = await getCandidates(ctx(MODELS), { allowlist: [] });
  assert.equal(out.length, 3);
});

const COPILOT_MODELS: RegistryModel[] = [
  { provider: "github-copilot", id: "gpt-5.5" },
  { provider: "github-copilot", id: "gpt-5.4-nano" },
  { provider: "anthropic", id: "opus", contextWindow: 200_000 },
];

test("copilotFilter drops github-copilot models absent from the live set, keeping non-copilot", async () => {
  const out = await getCandidates(ctx(COPILOT_MODELS), { copilotFilter: new Set(["gpt-5.5"]) });
  assert.deepEqual(
    out.map((c) => `${c.provider}/${c.id}`),
    ["github-copilot/gpt-5.5", "anthropic/opus"],
  );
});

test("copilotFilter never touches non-copilot providers", async () => {
  // A live set that contains none of the anthropic ids must not drop anthropic.
  const out = await getCandidates(ctx(COPILOT_MODELS), { copilotFilter: new Set(["gpt-5.5"]) });
  assert.ok(out.some((c) => c.provider === "anthropic" && c.id === "opus"));
});

test("an empty copilotFilter is a no-op (cannot empty the menu)", async () => {
  const out = await getCandidates(ctx(COPILOT_MODELS), { copilotFilter: new Set() });
  assert.equal(out.length, 3);
});

test("a null/undefined copilotFilter leaves the static menu unchanged", async () => {
  assert.equal((await getCandidates(ctx(COPILOT_MODELS), { copilotFilter: null })).length, 3);
  assert.equal((await getCandidates(ctx(COPILOT_MODELS), {})).length, 3);
});

test("allowlist AND copilotFilter compose (a model must pass both)", async () => {
  // allowlist permits gpt-5.4-nano + opus; live filter permits only gpt-5.5 → nano dropped by filter,
  // gpt-5.5 dropped by allowlist, opus passes both.
  const out = await getCandidates(ctx(COPILOT_MODELS), {
    allowlist: ["github-copilot/gpt-5.4-nano", "anthropic/opus"],
    copilotFilter: new Set(["gpt-5.5"]),
  });
  assert.deepEqual(out.map((c) => `${c.provider}/${c.id}`), ["anthropic/opus"]);
});
