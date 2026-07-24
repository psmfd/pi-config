import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  clearSessionUnavailable,
  isProviderRateLimited,
  markSessionUnavailable,
  sessionUnavailableModels,
} from "../session-unavailable.ts";

afterEach(() => clearSessionUnavailable());

test("rate-limit classifier recognizes provider quota forms", () => {
  for (const value of [
    new Error("HTTP 429"),
    "quota exceeded",
    "rate-limited",
    "rate limit reached",
    "Too Many Requests",
  ]) {
    assert.equal(isProviderRateLimited(value), true, String(value));
  }
  assert.equal(isProviderRateLimited("provider unavailable"), false);
  assert.equal(isProviderRateLimited(undefined), false);
});

test("session deny state accepts only qualified provider/id keys", () => {
  assert.equal(markSessionUnavailable("github-copilot/model"), true);
  assert.equal(markSessionUnavailable("openrouter/anthropic/claude"), true);
  assert.equal(markSessionUnavailable("bare-model"), false);
  assert.equal(markSessionUnavailable("/model"), false);
  assert.equal(markSessionUnavailable("provider/"), false);
  assert.equal(markSessionUnavailable("provider/model name"), false);
  assert.deepEqual([...sessionUnavailableModels], [
    "github-copilot/model",
    "openrouter/anthropic/claude",
  ]);

  clearSessionUnavailable();
  assert.equal(sessionUnavailableModels.size, 0);
});
