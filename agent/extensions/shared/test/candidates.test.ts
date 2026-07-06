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

// --- #538: live Anthropic availability filter -------------------------------

test("anthropicFilter drops retired anthropic ids, keeping other providers (#538)", async () => {
  const out = await getCandidates(ctx(MODELS), { anthropicFilter: new Set(["haiku"]) });
  assert.deepEqual(
    out.map((c) => `${c.provider}/${c.id}`),
    ["anthropic/haiku", "local/devstral"],
  );
});

test("an empty or null anthropicFilter fails open (menu unchanged, unlike omlxFilter)", async () => {
  assert.equal((await getCandidates(ctx(MODELS), { anthropicFilter: new Set() })).length, 3);
  assert.equal((await getCandidates(ctx(MODELS), { anthropicFilter: null })).length, 3);
});

test("anthropicFilter composes AND-wise with the allowlist", async () => {
  const out = await getCandidates(ctx(MODELS), {
    allowlist: ["anthropic/opus", "anthropic/haiku"],
    anthropicFilter: new Set(["opus"]),
  });
  assert.deepEqual(out.map((c) => `${c.provider}/${c.id}`), ["anthropic/opus"]);
});

// --- #364: live oMLX availability filter -----------------------------------
const MIXED: RegistryModel[] = [
  { provider: "omlx", id: "coding-workhorse", contextWindow: 131_072 },
  { provider: "anthropic", id: "opus", contextWindow: 200_000 },
];

test("an EMPTY omlxFilter is authoritative: drops omlx candidates, never frontier ones (#364)", async () => {
  const out = await getCandidates(ctx(MIXED), { omlxFilter: new Set() });
  assert.deepEqual(out.map((c) => `${c.provider}/${c.id}`), ["anthropic/opus"]);
});

test("omlxFilter keeps a served omlx model and drops an unserved one", async () => {
  const kept = await getCandidates(ctx(MIXED), { omlxFilter: new Set(["coding-workhorse"]) });
  assert.equal(kept.length, 2);
  const dropped = await getCandidates(ctx(MIXED), { omlxFilter: new Set(["other-model"]) });
  assert.deepEqual(dropped.map((c) => c.id), ["opus"]);
});

test("a null/undefined omlxFilter fails open (menu unchanged)", async () => {
  assert.equal((await getCandidates(ctx(MIXED), { omlxFilter: null })).length, 2);
  assert.equal((await getCandidates(ctx(MIXED), {})).length, 2);
});

test("omlxFilter composes AND-wise with allowlist and copilotFilter", async () => {
  const models: RegistryModel[] = [
    { provider: "omlx", id: "coding-workhorse" },
    { provider: "github-copilot", id: "gpt-5.5" },
    { provider: "github-copilot", id: "gpt-5.4-nano" },
    { provider: "anthropic", id: "opus" },
  ];
  const out = await getCandidates(ctx(models), {
    allowlist: ["omlx/coding-workhorse", "github-copilot/gpt-5.5", "github-copilot/gpt-5.4-nano"],
    copilotFilter: new Set(["gpt-5.5"]),
    omlxFilter: new Set(["coding-workhorse"]),
  });
  // opus fails the allowlist; nano fails the copilot filter; the rest pass all three.
  assert.deepEqual(out.map((c) => `${c.provider}/${c.id}`), [
    "omlx/coding-workhorse",
    "github-copilot/gpt-5.5",
  ]);
});

test("getCandidates preserves an explicit all-zero cost (local providers, #518)", async () => {
  // The omlx workhorse registers with cost 0 across the board (local-llm
  // ADR-009/010); zeros must survive normalization untouched — a fabricated
  // non-zero cost would corrupt the #363 cost-0 routing policy input.
  const out = await getCandidates(
    ctx([
      {
        provider: "omlx",
        id: "coding-workhorse",
        contextWindow: 131_072,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]),
  );
  assert.deepEqual(out[0], {
    provider: "omlx",
    id: "coding-workhorse",
    contextWindow: 131_072,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
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
