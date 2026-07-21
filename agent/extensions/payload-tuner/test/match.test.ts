import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { globMatch, matchRule, type ModelLike } from "../lib/match.ts";
import type { TunerRule } from "../lib/settings.ts";

const APPLY = { temperature: 0.5 };

function rule(match: TunerRule["match"]): TunerRule {
  return { match, apply: APPLY };
}

const GLM: ModelLike = {
  id: "glm-4.7-workhorse",
  provider: "omlx",
  baseUrl: "http://localhost:8000/v1",
};

describe("globMatch", () => {
  it("matches literal strings exactly and anchored", () => {
    assert.equal(globMatch("omlx", "omlx"), true);
    assert.equal(globMatch("omlx", "omlx2"), false);
    assert.equal(globMatch("omlx", "xomlx"), false);
  });

  it("supports * as a multi-character wildcard", () => {
    assert.equal(globMatch("glm-*", "glm-4.7-workhorse"), true);
    assert.equal(globMatch("glm-*", "glm-"), true);
    assert.equal(globMatch("glm-*", "gpt-4"), false);
    assert.equal(globMatch("http://localhost:8000/*", "http://localhost:8000/v1"), true);
    assert.equal(globMatch("http://127.0.0.1:*", "http://127.0.0.1:8000/v1"), true);
  });

  it("escapes regex metacharacters in the pattern", () => {
    assert.equal(globMatch("glm-4.7", "glm-407"), false);
    assert.equal(globMatch("a+b", "a+b"), true);
    assert.equal(globMatch("a+b", "aab"), false);
  });
});

describe("matchRule", () => {
  it("requires every present matcher field to match (AND)", () => {
    assert.ok(matchRule([rule({ provider: "omlx", modelId: "glm-*" })], GLM));
    assert.equal(matchRule([rule({ provider: "omlx", modelId: "gpt-*" })], GLM), null);
  });

  it("returns the first matching rule", () => {
    const first = rule({ provider: "omlx" });
    const second = rule({ modelId: "glm-*" });
    assert.equal(matchRule([first, second], GLM), first);
  });

  it("returns null when nothing matches or the model lacks the field", () => {
    assert.equal(matchRule([rule({ provider: "anthropic" })], GLM), null);
    assert.equal(matchRule([rule({ baseUrl: "http://*" })], { id: "glm" }), null);
  });
});
