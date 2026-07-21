import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyRule } from "../lib/apply.ts";

const BASE = {
  model: "glm-4.7-workhorse",
  messages: [{ role: "user", content: "hi" }],
  temperature: 1,
  max_tokens: 32000,
  stream: true,
};

describe("applyRule", () => {
  it("injects chat_template_kwargs by merge", () => {
    const r = applyRule(BASE, { chatTemplateKwargs: { enable_thinking: false } });
    assert.equal(r.changed, true);
    const p = r.payload as Record<string, unknown>;
    assert.deepEqual(p.chat_template_kwargs, { enable_thinking: false });
  });

  it("merges over existing kwargs without dropping unrelated keys", () => {
    const withKwargs = { ...BASE, chat_template_kwargs: { foo: 1, enable_thinking: true } };
    const r = applyRule(withKwargs, { chatTemplateKwargs: { enable_thinking: false } });
    const p = r.payload as Record<string, unknown>;
    assert.deepEqual(p.chat_template_kwargs, { foo: 1, enable_thinking: false });
  });

  it("sets temperature and top_p", () => {
    const r = applyRule(BASE, { temperature: 0.6, topP: 0.95 });
    const p = r.payload as Record<string, unknown>;
    assert.equal(p.temperature, 0.6);
    assert.equal(p.top_p, 0.95);
    assert.equal(r.changed, true);
  });

  it("clamps max_tokens only downward", () => {
    const r = applyRule(BASE, { maxTokensCap: 8192 });
    assert.equal((r.payload as Record<string, unknown>).max_tokens, 8192);
    const under = applyRule({ ...BASE, max_tokens: 4000 }, { maxTokensCap: 8192 });
    assert.equal(under.changed, false);
    assert.equal((under.payload as Record<string, unknown>).max_tokens, 4000);
  });

  it("clamps max_completion_tokens variant too", () => {
    const alt = { ...BASE, max_tokens: undefined, max_completion_tokens: 32000 };
    delete (alt as Record<string, unknown>).max_tokens;
    const r = applyRule(alt, { maxTokensCap: 8192 });
    assert.equal((r.payload as Record<string, unknown>).max_completion_tokens, 8192);
  });

  it("clamps max_output_tokens (Responses API) downward (#778)", () => {
    const alt = { model: "m", messages: [], max_output_tokens: 32000 };
    const r = applyRule(alt, { maxTokensCap: 8192 });
    assert.equal((r.payload as Record<string, unknown>).max_output_tokens, 8192);
    const under = applyRule({ ...alt, max_output_tokens: 4000 }, { maxTokensCap: 8192 });
    assert.equal(under.changed, false);
  });

  it("floors max_output_tokens at 16 (Responses API rejects lower) (#778)", () => {
    const alt = { model: "m", messages: [], max_output_tokens: 32000 };
    const r = applyRule(alt, { maxTokensCap: 4 });
    assert.equal((r.payload as Record<string, unknown>).max_output_tokens, 16);
    // max_tokens has no floor — a cap of 4 applies as-is.
    const plain = applyRule({ model: "m", messages: [], max_tokens: 32000 }, { maxTokensCap: 4 });
    assert.equal((plain.payload as Record<string, unknown>).max_tokens, 4);
    // Already at the floor: no change, identical object.
    const atFloor = applyRule({ ...alt, max_output_tokens: 16 }, { maxTokensCap: 4 });
    assert.equal(atFloor.changed, false);
  });

  it("never adds a max-tokens field the adapter omitted", () => {
    const noCap = { model: "m", messages: [] };
    const r = applyRule(noCap, { maxTokensCap: 8192 });
    assert.equal(r.changed, false);
    assert.equal("max_tokens" in (r.payload as Record<string, unknown>), false);
  });

  it("never touches messages, system, or tools", () => {
    const withAll = { ...BASE, system: "s", tools: [{ name: "t" }] };
    const r = applyRule(withAll, {
      chatTemplateKwargs: { enable_thinking: false },
      temperature: 0.2,
      maxTokensCap: 100,
    });
    const p = r.payload as Record<string, unknown>;
    assert.equal(p.messages, withAll.messages);
    assert.equal(p.system, withAll.system);
    assert.equal(p.tools, withAll.tools);
  });

  it("returns changed=false and the original object when nothing changes", () => {
    const same = { ...BASE, temperature: 0.6 };
    const r = applyRule(same, { temperature: 0.6 });
    assert.equal(r.changed, false);
    assert.equal(r.payload, same);
  });

  it("passes non-object payloads through untouched", () => {
    for (const v of [null, undefined, "str", 42, [1, 2]]) {
      const r = applyRule(v, { temperature: 0 });
      assert.equal(r.changed, false);
      assert.equal(r.payload, v);
    }
  });

  it("is idempotent: double application is byte-identical", () => {
    const tweaks = {
      chatTemplateKwargs: { enable_thinking: false },
      temperature: 0.6,
      topP: 0.9,
      maxTokensCap: 8192,
    };
    const once = applyRule(BASE, tweaks);
    assert.equal(once.changed, true);
    const twice = applyRule(once.payload, tweaks);
    assert.equal(twice.changed, false);
    assert.equal(JSON.stringify(twice.payload), JSON.stringify(once.payload));
  });
});
