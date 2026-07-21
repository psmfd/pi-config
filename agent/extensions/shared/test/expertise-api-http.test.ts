/**
 * shared/expertise-api-http.ts tests — direct coverage of the bounded HTTP
 * helpers (ADR-0103), added by the #788 review: redirect refusal, the
 * MAX_BODY_BYTES truncation path, header composition (baseline credentials
 * always win over extraHeaders), Retry-After surfacing, and errorDetail's
 * cap/redaction behavior. expertise-client's suite exercises these only
 * incidentally through business logic; these cases pin the module's own
 * contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClientConfig } from "../expertise-api-config.ts";
import {
  AGENT_ACTOR_CLASS,
  AGENT_USER_AGENT,
  apiGet,
  apiPost,
  errorDetail,
  MAX_BODY_BYTES,
} from "../expertise-api-http.ts";

const CONFIG: ClientConfig = {
  baseUrl: "http://127.0.0.1:5000",
  bearerToken: "test-token",
  authMode: "local-api-key",
  allowWrite: false,
};

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** Minimal Response-alike + capture of what fetch was called with. */
function fakeFetch(
  bodyText: string,
  captured: CapturedCall[],
  headers: Record<string, string> = {},
  status = 200,
): typeof fetch {
  // apiGet/apiPost always pass a URL instance; the cast below restores the
  // full fetch signature for the callers.
  return (async (url: URL, init?: RequestInit) => {
    captured.push({ url: url.href, init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "OK",
      text: async () => bodyText,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    } as unknown as Response;
  }) as typeof fetch;
}

test("apiPost: refuses redirects and baseline headers win over extraHeaders", async () => {
  const calls: CapturedCall[] = [];
  await apiPost(CONFIG, "/v1/thing", {
    body: { a: 1 },
    extraHeaders: {
      "idempotency-key": "abc",
      authorization: "Bearer attacker",
      "content-type": "text/evil",
    },
    fetchImpl: fakeFetch("{}", calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "error");
  const h = calls[0].init.headers as Record<string, string>;
  // Per-request extras survive…
  assert.equal(h["idempotency-key"], "abc");
  // …but can never clobber the credential/content-type baseline (#323).
  assert.equal(h.authorization, `Bearer ${CONFIG.bearerToken}`);
  assert.equal(h["content-type"], "application/json");
  assert.equal(h["x-actor-class"], AGENT_ACTOR_CLASS);
  assert.equal(h["user-agent"], AGENT_USER_AGENT);
  assert.equal(calls[0].init.body, JSON.stringify({ a: 1 }));
});

test("apiGet: authenticated by default, anonymous mode omits the credential", async () => {
  const calls: CapturedCall[] = [];
  const impl = fakeFetch("{}", calls);
  await apiGet(CONFIG, "/v1/q", { searchParams: { q: "x" }, fetchImpl: impl });
  await apiGet(CONFIG, "/v1/q", { authenticated: false, fetchImpl: impl });
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].url.includes("q=x"));
  const authed = calls[0].init.headers as Record<string, string>;
  const anon = calls[1].init.headers as Record<string, string>;
  assert.equal(authed.authorization, `Bearer ${CONFIG.bearerToken}`);
  assert.equal(anon.authorization, undefined);
  assert.equal(anon["x-actor-class"], undefined);
});

test("bounded response: body over MAX_BODY_BYTES is truncated and flagged", async () => {
  const big = "x".repeat(MAX_BODY_BYTES + 1000);
  const res = await apiGet(CONFIG, "/v1/big", { fetchImpl: fakeFetch(big, []) });
  assert.equal(res.truncated, true);
  assert.equal(Buffer.byteLength(res.text, "utf-8"), MAX_BODY_BYTES);
  const small = await apiGet(CONFIG, "/v1/small", { fetchImpl: fakeFetch("ok", []) });
  assert.equal(small.truncated, false);
  assert.equal(small.text, "ok");
});

test("bounded response: Retry-After header is surfaced when present", async () => {
  const res = await apiPost(CONFIG, "/v1/rate", {
    fetchImpl: fakeFetch("slow down", [], { "retry-after": "30" }, 429),
  });
  assert.equal(res.status, 429);
  assert.equal(res.ok, false);
  assert.equal(res.retryAfter, "30");
  const none = await apiPost(CONFIG, "/v1/ok", { fetchImpl: fakeFetch("{}", []) });
  assert.equal(none.retryAfter, undefined);
});

test("errorDetail: empty body, cap slice, and credential redaction", () => {
  assert.equal(errorDetail(""), "");
  assert.equal(errorDetail("   "), "");
  assert.equal(errorDetail("boom"), " — boom");
  const sliced = errorDetail("a".repeat(600), 500);
  assert.equal(sliced, ` — ${"a".repeat(500)}…`);
  assert.equal(
    errorDetail("token test-token leaked", 500, ["test-token"]),
    " — token [REDACTED:credential] leaked",
  );
  // Empty secret entries never redact.
  assert.equal(errorDetail("plain", 500, [""]), " — plain");
});
