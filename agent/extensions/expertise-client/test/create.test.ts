/**
 * expertise-client — expertise_create / runCreate tests (ADR-0028, #318).
 *
 * Covers the create policy ladder (opt-in gate → body-secret scan → readiness
 * → create) at the runCreate dispatch boundary, plus the transport-level
 * createExpertise (path, headers, Idempotency-Key uniqueness, fail-closed).
 * Secret-non-disclosure: the API key is sent as a header but must never appear
 * in any tool-visible output or refusal reason.
 *
 * Fixture secret literals are assembled at runtime from fragments so this file
 * contains no committed secret pattern.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ClientConfig } from "../lib/config.ts";
import { CREATE_PATH, createExpertise } from "../lib/create.ts";
import { runCreate } from "../lib/run-create.ts";

const SECRET = "super-secret-api-key";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

const WRITE_CONFIG: ClientConfig = {
  baseUrl: "http://127.0.0.1:8080",
  apiKey: SECRET,
  allowWrite: true,
};
const NO_WRITE_CONFIG: ClientConfig = { ...WRITE_CONFIG, allowWrite: false };

interface Captured {
  url?: URL;
  headers?: Record<string, string>;
  body?: string;
}

function capturingFetch(
  cap: Captured,
  status: number,
  body: string,
): typeof fetch {
  return (async (url: URL, init: RequestInit) => {
    cap.url = url;
    cap.headers = init.headers as Record<string, string>;
    cap.body = init.body as string;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

const readyOk = async () => ({ ready: true as const });

// --- runCreate policy ladder ------------------------------------------------

test("runCreate refuses when allowWrite is false (before any network call)", async () => {
  let called = false;
  const r = await runCreate(
    NO_WRITE_CONFIG,
    { title: "t", content: "c" },
    {
      checkReady: (async () => {
        called = true;
        return { ready: true };
      }) as never,
      createExpertise: (async () => {
        called = true;
        return { ok: true, status: 201, text: "{}", truncated: false };
      }) as never,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /PI_EXPERTISE_ALLOW_LOCALDEV_WRITE/);
  assert.equal(called, false);
});

test("runCreate refuses a body containing a credential, without echoing it", async () => {
  let networkTouched = false;
  const r = await runCreate(
    WRITE_CONFIG,
    { title: "t", content: `leak ${AWS_KEY}` },
    {
      checkReady: (async () => {
        networkTouched = true;
        return { ready: true };
      }) as never,
      createExpertise: (async () => {
        networkTouched = true;
        return { ok: true, status: 201, text: "{}", truncated: false };
      }) as never,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /aws-access-key/);
    assert.equal(r.reason.includes(AWS_KEY), false);
  }
  assert.equal(networkTouched, false);
});

test("runCreate succeeds through the full ladder", async () => {
  const cap: Captured = {};
  const r = await runCreate(
    WRITE_CONFIG,
    { title: "kafka", content: "tune it", tags: ["mq"], source: "pi-session" },
    { checkReady: readyOk as never, fetchImpl: capturingFetch(cap, 201, '{"id":1}') },
  );
  assert.ok(r.ok);
  if (r.ok) assert.match(r.text, /id/);
  assert.equal(cap.url?.pathname, CREATE_PATH);
});

test("runCreate fails closed when readiness fails", async () => {
  const r = await runCreate(
    WRITE_CONFIG,
    { title: "t", content: "c" },
    { checkReady: (async () => ({ ready: false, reason: "down" })) as never },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not ready/);
});

// --- createExpertise transport ---------------------------------------------

test("createExpertise POSTs to CREATE_PATH with JSON body, x-api-key, Idempotency-Key", async () => {
  const cap: Captured = {};
  const r = await createExpertise(
    WRITE_CONFIG,
    { title: "kafka", content: "tune it", tags: ["mq"], source: "pi-session" },
    { fetchImpl: capturingFetch(cap, 201, "{}") },
  );
  assert.ok(r.ok);
  assert.equal(cap.url?.pathname, CREATE_PATH);
  assert.equal(cap.headers?.["x-api-key"], SECRET);
  assert.equal(cap.headers?.["content-type"], "application/json");
  assert.ok(cap.headers?.["Idempotency-Key"]);
  const parsed = JSON.parse(cap.body ?? "{}") as {
    title?: string;
    tags?: string[];
    source?: string;
  };
  assert.equal(parsed.title, "kafka");
  assert.deepEqual(parsed.tags, ["mq"]);
  assert.equal(parsed.source, "pi-session");
});

test("createExpertise sends a fresh, unique Idempotency-Key per call", async () => {
  const cap1: Captured = {};
  const cap2: Captured = {};
  await createExpertise(WRITE_CONFIG, { title: "t", content: "c" }, {
    fetchImpl: capturingFetch(cap1, 201, "{}"),
  });
  await createExpertise(WRITE_CONFIG, { title: "t", content: "c" }, {
    fetchImpl: capturingFetch(cap2, 201, "{}"),
  });
  const k1 = cap1.headers?.["Idempotency-Key"];
  const k2 = cap2.headers?.["Idempotency-Key"];
  assert.ok(k1);
  assert.ok(k2);
  assert.notEqual(k1, k2);
});

test("createExpertise fails closed on non-2xx without leaking the key", async () => {
  const cap: Captured = {};
  const r = await createExpertise(WRITE_CONFIG, { title: "t", content: "c" }, {
    fetchImpl: capturingFetch(cap, 409, "conflict"),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /409/);
    assert.equal(r.reason.includes(SECRET), false);
  }
});

test("createExpertise fails closed on a network error", async () => {
  const throwing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await createExpertise(WRITE_CONFIG, { title: "t", content: "c" }, {
    fetchImpl: throwing,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /failed/i);
    assert.equal(r.reason.includes(SECRET), false);
  }
});
