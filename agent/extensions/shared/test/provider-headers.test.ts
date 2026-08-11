/**
 * shared/provider-headers.ts tests (#953) — pi v0.84.0 widened
 * `getApiKeyAndHeaders()` to `ProviderHeaders` (`Record<string, string | null>`)
 * where `null` is a header-DELETION marker. These pin the collapse semantics
 * and the two consumers that rebuild their own `fetch` init from the map.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeProviderHeaders } from "../provider-headers.ts";
import { buildAnthropicHeaders } from "../anthropic-discovery.ts";
import {
  clearCopilotCache,
  fetchCopilotEnabledModels,
  type FetchLike,
} from "../copilot-discovery.ts";

test("mergeProviderHeaders: overlay wins over base", () => {
  assert.deepEqual(
    mergeProviderHeaders({ accept: "application/json" }, { "x-trace": "abc" }),
    { accept: "application/json", "x-trace": "abc" },
  );
  assert.deepEqual(
    mergeProviderHeaders({ accept: "application/json" }, { accept: "text/plain" }),
    { accept: "text/plain" },
  );
});

test("mergeProviderHeaders: a null overlay value deletes the key and is never emitted", () => {
  const merged = mergeProviderHeaders(
    { accept: "application/json", "x-drop": "keep-me" },
    { "x-drop": null },
  );
  assert.deepEqual(merged, { accept: "application/json" });
  assert.equal("x-drop" in merged, false);
  // The regression this module exists for: no value may serialize as "null".
  assert.equal(Object.values(merged).includes("null"), false);
  assert.equal(
    Object.values(merged).some((v) => v === null || v === undefined),
    false,
  );
});

test("mergeProviderHeaders: a null for an absent key is a no-op, not an emitted header", () => {
  assert.deepEqual(mergeProviderHeaders({ accept: "a" }, { "x-nope": null }), { accept: "a" });
});

test("mergeProviderHeaders: undefined is skipped without disturbing the base", () => {
  const overlay = { accept: undefined } as unknown as Record<string, string | null>;
  assert.deepEqual(mergeProviderHeaders({ accept: "application/json" }, overlay), {
    accept: "application/json",
  });
});

test("mergeProviderHeaders: absent overlay returns a copy of the base", () => {
  const base = { accept: "application/json" };
  const merged = mergeProviderHeaders(base, undefined);
  assert.deepEqual(merged, base);
  assert.notEqual(merged, base, "must not alias the caller's base object");
});

test("mergeProviderHeaders: does not mutate its inputs", () => {
  const base = { accept: "application/json", "x-drop": "v" };
  const overlay: Record<string, string | null> = { "x-drop": null, "x-add": "1" };
  mergeProviderHeaders(base, overlay);
  assert.deepEqual(base, { accept: "application/json", "x-drop": "v" });
  assert.deepEqual(overlay, { "x-drop": null, "x-add": "1" });
});

test("mergeProviderHeaders: a __proto__ key stays an own data property", () => {
  const overlay = JSON.parse('{"__proto__":"polluted"}') as Record<string, string | null>;
  const merged = mergeProviderHeaders({ accept: "a" }, overlay);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(merged.accept, "a");
});

test("mergeProviderHeaders: pre-0.84.0 shape (no nulls) is a pass-through", () => {
  assert.deepEqual(
    mergeProviderHeaders({ accept: "application/json" }, { "x-a": "1", "x-b": "2" }),
    { accept: "application/json", "x-a": "1", "x-b": "2" },
  );
});

test("buildAnthropicHeaders: a null deletion marker never reaches the request", () => {
  const headers = buildAnthropicHeaders({
    ok: true,
    apiKey: "sk-ant-test",
    headers: { accept: null, "x-gateway": null, "x-keep": "yes" },
  });
  assert.ok(headers);
  assert.equal("accept" in headers, false);
  assert.equal("x-gateway" in headers, false);
  assert.equal(headers["x-keep"], "yes");
  assert.equal(
    Object.values(headers).some((v) => v === null || v === undefined),
    false,
  );
  // Our own credential and API-version headers remain authoritative.
  assert.equal(headers["x-api-key"], "sk-ant-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
});

test("buildAnthropicHeaders: a null cannot delete our credential or version header", () => {
  const headers = buildAnthropicHeaders({
    ok: true,
    apiKey: "sk-ant-test",
    headers: { "x-api-key": null, "anthropic-version": null },
  });
  assert.ok(headers);
  assert.equal(headers["x-api-key"], "sk-ant-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
});

test("fetchCopilotEnabledModels: a null deletion marker never reaches the request init", async () => {
  clearCopilotCache();
  let sent: Record<string, string> | undefined;
  const fetchFn: FetchLike = async (_url, init) => {
    sent = init.headers;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: [{ id: "gpt-5.5", model_picker_enabled: true, policy: { state: "enabled" } }] }),
    };
  };

  const models = await fetchCopilotEnabledModels(
    {
      ok: true,
      apiKey: "tid=abc;exp=9999;proxy-ep=proxy.individual.githubcopilot.com;ol=1",
      headers: { "Copilot-Integration-Id": "vscode-chat", "x-gateway": null },
    },
    { fetchFn },
  );

  assert.ok(models);
  assert.ok(sent);
  assert.equal("x-gateway" in sent, false);
  assert.equal(sent["Copilot-Integration-Id"], "vscode-chat");
  assert.equal(sent.Authorization?.startsWith("Bearer "), true);
  assert.equal(
    Object.values(sent).some((v) => v === null || v === undefined),
    false,
  );
  clearCopilotCache();
});
