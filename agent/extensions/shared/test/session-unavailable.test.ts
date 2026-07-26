import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  clearSessionUnavailable,
  createSessionDeny,
  isProviderRateLimited,
  markSessionUnavailable,
  providerOf,
  sessionDeny,
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
  const deny = createSessionDeny();
  assert.equal(deny.mark("github-copilot/model"), true);
  assert.equal(deny.mark("openrouter/anthropic/claude"), true);
  assert.equal(deny.mark("bare-model"), false);
  assert.equal(deny.mark("/model"), false);
  assert.equal(deny.mark("provider/"), false);
  assert.equal(deny.mark("provider/model name"), false);
  assert.deepEqual(
    deny.models().map((record) => record.key),
    ["github-copilot/model", "openrouter/anthropic/claude"],
  );

  deny.clear();
  assert.equal(deny.size, 0);
});

test("providerOf reads the first path segment only", () => {
  assert.equal(providerOf("github-copilot/gpt-5"), "github-copilot");
  assert.equal(providerOf("openrouter/anthropic/claude"), "openrouter");
  assert.equal(providerOf("bare"), "");
  assert.equal(providerOf("/leading"), "");
});

test("markProvider refuses a qualified model key so a pin cannot pose as a provider", () => {
  const deny = createSessionDeny();
  assert.equal(deny.markProvider("github-copilot/gpt-5"), false);
  assert.equal(deny.markProvider("two words"), false);
  assert.equal(deny.markProvider(""), false);
  assert.equal(deny.markProvider("github-copilot"), true);
});

test("a provider-scope deny excludes every model of that provider", () => {
  const deny = createSessionDeny();
  deny.markProvider("github-copilot", { source: "operator", reason: "operator disable" });
  assert.equal(deny.has("github-copilot/gpt-5"), true);
  assert.equal(deny.has("github-copilot/claude-opus-4.7"), true);
  assert.equal(deny.has("openai-codex/gpt-5"), false);
  assert.equal(deny.isProviderDenied("github-copilot"), true);
  // Provider scope must not leak into the model-scope list — the two surfaces
  // answer different questions for telemetry.
  assert.deepEqual(deny.models(), []);
  assert.equal(deny.providers().length, 1);
});

test("records are first-writer-wins so concurrent children cannot rewrite provenance", () => {
  const deny = createSessionDeny();
  deny.mark("github-copilot/gpt-5", { source: "classifier-probe", reason: "rate-limited" });
  const first = deny.models()[0];
  assert.ok(first);
  deny.mark("github-copilot/gpt-5", { source: "runtime-failover", reason: "something else" });
  assert.deepEqual(deny.models()[0], first);

  deny.markProvider("openai-codex", { source: "operator", reason: "operator disable" });
  const provider = deny.providers().find((record) => record.key === "openai-codex");
  assert.ok(provider);
  deny.markProvider("openai-codex", { source: "auto-escalation", reason: "later" });
  assert.deepEqual(
    deny.providers().find((record) => record.key === "openai-codex"),
    provider,
  );
});

test("auto-escalation trips the breaker at the threshold, on rate-limit evidence only", () => {
  const deny = createSessionDeny();
  deny.mark("github-copilot/gpt-5", { rateLimited: true });
  assert.equal(deny.isProviderDenied("github-copilot"), false, "one model is not a pattern");

  deny.mark("github-copilot/claude-opus-4.7", { rateLimited: true });
  const record = deny.providerRecord("github-copilot");
  assert.ok(record);
  assert.equal(record.source, "auto-escalation");
  assert.equal(record.scope, "provider");
  assert.match(record.reason, /2 distinct models rate-limited/);
  // Every sibling row is now excluded, including ones never probed.
  assert.equal(deny.has("github-copilot/never-tried"), true);
});

test("non-rate-limited denies never escalate", () => {
  const deny = createSessionDeny();
  deny.mark("anthropic/a", { source: "classifier-probe", reason: "error", rateLimited: false });
  deny.mark("anthropic/b", { source: "classifier-probe", reason: "error", rateLimited: false });
  deny.mark("anthropic/c", { source: "classifier-probe", reason: "error", rateLimited: false });
  assert.equal(deny.isProviderDenied("anthropic"), false);
  assert.equal(deny.models().length, 3);
});

test("re-marking the same model does not double-count toward escalation", () => {
  const deny = createSessionDeny();
  deny.mark("github-copilot/gpt-5", { rateLimited: true });
  deny.mark("github-copilot/gpt-5", { rateLimited: true });
  deny.mark("github-copilot/gpt-5", { rateLimited: true });
  assert.equal(deny.isProviderDenied("github-copilot"), false);
});

test("the escalation threshold is configurable but floored at two", () => {
  const deny = createSessionDeny();
  assert.equal(deny.threshold, 2);
  assert.equal(deny.setThreshold(3), true);
  assert.equal(deny.threshold, 3);
  // A threshold of 1 would make every model-scope 429 provider-wide.
  assert.equal(deny.setThreshold(1), false);
  assert.equal(deny.setThreshold(0), false);
  assert.equal(deny.setThreshold(2.5), false);
  assert.equal(deny.setThreshold("3"), false);
  assert.equal(deny.setThreshold(undefined), false);
  assert.equal(deny.threshold, 3);

  deny.mark("github-copilot/a", { rateLimited: true });
  deny.mark("github-copilot/b", { rateLimited: true });
  assert.equal(deny.isProviderDenied("github-copilot"), false, "under the raised threshold");
  deny.mark("github-copilot/c", { rateLimited: true });
  assert.equal(deny.isProviderDenied("github-copilot"), true);
});

test("clearProvider re-enables a provider and drops its escalation evidence", () => {
  const deny = createSessionDeny();
  deny.mark("github-copilot/a", { rateLimited: true });
  deny.mark("github-copilot/b", { rateLimited: true });
  assert.equal(deny.isProviderDenied("github-copilot"), true);

  assert.equal(deny.clearProvider("github-copilot"), true);
  assert.equal(deny.isProviderDenied("github-copilot"), false);
  assert.equal(deny.has("github-copilot/a"), false, "model-scope records go too");
  assert.equal(deny.size, 0);

  // The accumulated counts are gone, so one further failure must not re-trip.
  deny.mark("github-copilot/a", { rateLimited: true });
  assert.equal(deny.isProviderDenied("github-copilot"), false);

  assert.equal(deny.clearProvider("never-denied"), false);
});

test("clearProvider leaves other providers untouched", () => {
  const deny = createSessionDeny();
  deny.mark("github-copilot/a", { rateLimited: false });
  deny.mark("anthropic/a", { rateLimited: false });
  deny.markProvider("openai-codex");
  deny.clearProvider("github-copilot");
  assert.deepEqual(
    deny.models().map((record) => record.key),
    ["anthropic/a"],
  );
  assert.deepEqual(
    deny.providers().map((record) => record.key),
    ["openai-codex"],
  );
});

test("keepOperator preserves explicit disables and drops runtime evidence", () => {
  const deny = createSessionDeny();
  deny.markProvider("github-copilot", { source: "operator", reason: "operator disable" });
  deny.mark("anthropic/a", { rateLimited: true });
  deny.mark("anthropic/b", { rateLimited: true });
  assert.equal(deny.isProviderDenied("anthropic"), true, "auto-escalated");

  // `/auto matrix refresh --retry-unavailable`
  deny.clear({ keepOperator: true });
  assert.equal(deny.isProviderDenied("github-copilot"), true, "operator directive survives");
  assert.equal(deny.isProviderDenied("anthropic"), false, "runtime evidence cleared");
  assert.equal(deny.has("anthropic/a"), false);

  // Cleared escalation evidence must not let one further failure re-trip.
  deny.mark("anthropic/a", { rateLimited: true });
  assert.equal(deny.isProviderDenied("anthropic"), false);

  // Session start clears everything, operator entries included.
  deny.clear();
  assert.equal(deny.size, 0);
});

test("an operator disable survives repeated retry-unavailable refreshes", () => {
  const deny = createSessionDeny();
  deny.markProvider("github-copilot", { source: "operator" });
  deny.clear({ keepOperator: true });
  deny.clear({ keepOperator: true });
  assert.equal(deny.isProviderDenied("github-copilot"), true);
  assert.equal(deny.clearProvider("github-copilot"), true);
  assert.equal(deny.isProviderDenied("github-copilot"), false);
});

test("size counts records across both scopes, never the models a breaker implies", () => {
  const deny = createSessionDeny();
  deny.markProvider("github-copilot");
  deny.mark("anthropic/a", { rateLimited: false });
  assert.equal(deny.size, 2);
});

test("the canonical singleton is shared through the module-level helpers", () => {
  assert.equal(markSessionUnavailable("github-copilot/gpt-5", { rateLimited: false }), true);
  assert.equal(sessionDeny.has("github-copilot/gpt-5"), true);
  assert.equal(markSessionUnavailable("bare"), false);
  clearSessionUnavailable();
  assert.equal(sessionDeny.size, 0);
});

test("instances are isolated from the canonical singleton", () => {
  const deny = createSessionDeny();
  deny.markProvider("github-copilot");
  assert.equal(sessionDeny.isProviderDenied("github-copilot"), false);
});
