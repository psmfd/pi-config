/**
 * expertise-client — expertise_search tests (ADR-0028).
 *
 * Includes a secret-non-disclosure assertion: the API key is sent as a header
 * but must never appear in tool-visible output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ClientConfig } from "../lib/config.ts";
import { searchExpertise } from "../lib/search.ts";

const SECRET = "super-secret-api-key";
const CONFIG: ClientConfig = {
  baseUrl: "http://127.0.0.1:8080",
  apiKey: SECRET,
  allowWrite: false,
};

interface Captured {
  url?: URL;
  headers?: Record<string, string>;
}

function capturingFetch(
  cap: Captured,
  status: number,
  body: string,
): typeof fetch {
  return (async (url: URL, init: RequestInit) => {
    cap.url = url;
    cap.headers = init.headers as Record<string, string>;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

test("searchExpertise returns body on success", async () => {
  const cap: Captured = {};
  const r = await searchExpertise(
    CONFIG,
    { query: "kafka", limit: 5 },
    { fetchImpl: capturingFetch(cap, 200, '{"results":[]}') },
  );
  assert.ok(r.ok);
  if (r.ok) assert.match(r.text, /results/);
  assert.equal(cap.url?.pathname, "/expertise/search");
  assert.equal(cap.url?.searchParams.get("query"), "kafka");
  assert.equal(cap.url?.searchParams.get("limit"), "5");
});

test("searchExpertise sends the API key as x-api-key", async () => {
  const cap: Captured = {};
  await searchExpertise(
    CONFIG,
    { query: "x" },
    { fetchImpl: capturingFetch(cap, 200, "{}") },
  );
  assert.equal(cap.headers?.["x-api-key"], SECRET);
});

test("searchExpertise never leaks the API key into output", async () => {
  const cap: Captured = {};
  const r = await searchExpertise(
    CONFIG,
    { query: "x" },
    { fetchImpl: capturingFetch(cap, 200, "ok") },
  );
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.text.includes(SECRET), false);
});

test("searchExpertise fails closed on non-2xx, without leaking the key", async () => {
  const cap: Captured = {};
  const r = await searchExpertise(
    CONFIG,
    { query: "x" },
    { fetchImpl: capturingFetch(cap, 401, "unauthorized") },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /401/);
    assert.equal(r.reason.includes(SECRET), false);
  }
});

test("searchExpertise fails closed on a network error", async () => {
  const throwing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await searchExpertise(CONFIG, { query: "x" }, { fetchImpl: throwing });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /failed/i);
});
