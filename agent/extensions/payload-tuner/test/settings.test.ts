import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { DISABLED, parseSettings } from "../lib/settings.ts";

const VALID = {
  enabled: true,
  rules: [
    {
      match: {
        provider: "omlx",
        baseUrl: "http://host.lima.internal:8000/v1",
        modelId: "coding-workhorse",
      },
      apply: { chatTemplateKwargs: { reasoning_effort: "medium" } },
    },
  ],
};

describe("parseSettings", () => {
  it("parses a valid block", () => {
    const s = parseSettings(VALID);
    assert.equal(s.enabled, true);
    assert.equal(s.rules.length, 1);
    assert.equal(s.rules[0].match.modelId, "coding-workhorse");
    assert.equal(s.rules[0].match.baseUrl, "http://host.lima.internal:8000/v1");
  });

  it("keeps the tracked settings example inert and aligned with the tested rule", () => {
    const template = JSON.parse(
      readFileSync(new URL("../../../settings.example.json", import.meta.url), "utf8"),
    ) as { extensionSettings: { payloadTuner: typeof VALID } };
    const tracked = template.extensionSettings.payloadTuner;
    assert.equal(tracked.enabled, false);
    assert.deepEqual({ ...tracked, enabled: true }, VALID);
    assert.deepEqual(parseSettings(tracked), DISABLED);
  });

  it("is disabled unless enabled is exactly true", () => {
    assert.deepEqual(parseSettings({ ...VALID, enabled: "true" }), DISABLED);
    assert.deepEqual(parseSettings({ ...VALID, enabled: 1 }), DISABLED);
    assert.deepEqual(parseSettings({ ...VALID, enabled: undefined }), DISABLED);
  });

  it("is disabled on missing, empty, or non-array rules", () => {
    assert.deepEqual(parseSettings({ enabled: true }), DISABLED);
    assert.deepEqual(parseSettings({ enabled: true, rules: [] }), DISABLED);
    assert.deepEqual(parseSettings({ enabled: true, rules: {} }), DISABLED);
  });

  it("fails closed on any malformed rule (no partial application)", () => {
    const bad = [
      { ...VALID, rules: [...VALID.rules, { match: {}, apply: { temperature: 1 } }] },
      { ...VALID, rules: [{ match: { modelId: "x" }, apply: {} }] },
      { ...VALID, rules: [{ match: { modelId: "" }, apply: { temperature: 1 } }] },
      { ...VALID, rules: [{ match: { modelId: "x" }, apply: { maxTokensCap: 0 } }] },
      { ...VALID, rules: [{ match: { modelId: "x" }, apply: { maxTokensCap: 1.5 } }] },
      { ...VALID, rules: [{ match: { modelId: "x" }, apply: { temperature: "hot" } }] },
      { ...VALID, rules: [{ match: { modelId: "x" }, apply: { chatTemplateKwargs: [] } }] },
      { ...VALID, rules: ["nope"] },
    ];
    for (const b of bad) {
      assert.deepEqual(parseSettings(b), DISABLED, JSON.stringify(b));
    }
  });

  it("rejects unrecognized keys at every level (no silent half-application)", () => {
    const bad = [
      // Typo'd apply key alongside a valid one: must disable, not half-apply.
      { ...VALID, rules: [{ match: { modelId: "x" }, apply: { temperature: 1, toP: 0.9 } }] },
      // Typo'd match key alongside a valid one.
      { ...VALID, rules: [{ match: { modelId: "x", modelld: "y" }, apply: { temperature: 1 } }] },
      // Extra rule-level key.
      { ...VALID, rules: [{ match: { modelId: "x" }, apply: { temperature: 1 }, note: "hi" }] },
      // Extra top-level key.
      { ...VALID, comment: "hi" },
      // Empty chatTemplateKwargs is a no-op tweak.
      { ...VALID, rules: [{ match: { modelId: "x" }, apply: { chatTemplateKwargs: {} } }] },
    ];
    for (const b of bad) {
      assert.deepEqual(parseSettings(b), DISABLED, JSON.stringify(b));
    }
  });

  it("is disabled on non-object input", () => {
    for (const v of [null, undefined, "x", 3, []]) {
      assert.deepEqual(parseSettings(v), DISABLED);
    }
  });
});
