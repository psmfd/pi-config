/**
 * expertise-client — /health/ready preflight tests (ADR-0028).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ClientConfig } from "../lib/config.ts";
import { checkReady } from "../lib/health.ts";

const CONFIG: ClientConfig = {
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "test-key",
  allowWrite: false,
};

function fetchReturning(status: number): typeof fetch {
  return (async () => new Response("ok", { status })) as unknown as typeof fetch;
}

function fetchThrowing(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

test("checkReady is ready on HTTP 200", async () => {
  const r = await checkReady(CONFIG, { fetchImpl: fetchReturning(200) });
  assert.deepEqual(r, { ready: true });
});

test("checkReady fails closed on non-200", async () => {
  const r = await checkReady(CONFIG, { fetchImpl: fetchReturning(503) });
  assert.equal(r.ready, false);
  if (!r.ready) assert.match(r.reason, /503/);
});

test("checkReady fails closed on a network error", async () => {
  const r = await checkReady(CONFIG, {
    fetchImpl: fetchThrowing("ECONNREFUSED"),
  });
  assert.equal(r.ready, false);
  if (!r.ready) assert.match(r.reason, /unreachable/i);
});

test("checkReady targets /health/ready", async () => {
  let seen = "";
  const capture = (async (url: URL) => {
    seen = url.pathname;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  await checkReady(CONFIG, { fetchImpl: capture });
  assert.equal(seen, "/health/ready");
});
