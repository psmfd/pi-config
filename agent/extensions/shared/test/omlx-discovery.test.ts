import assert from "node:assert/strict";
import { test } from "node:test";

import type { FetchLike } from "../copilot-discovery.ts";
import {
  clearOmlxCache,
  fetchServedOmlxModels,
  getServedOmlxModels,
  omlxBaseUrl,
  parseServedModels,
  resolveOmlxFilter,
} from "../omlx-discovery.ts";

const BASE = "http://localhost:8000/v1";
const KEY = async (): Promise<string | null> => "test-key";

function withoutOmlxBaseEnv<T>(fn: () => T): T {
  const prev = process.env["OMLX_BASE_URL"];
  delete process.env["OMLX_BASE_URL"];
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["OMLX_BASE_URL"];
    else process.env["OMLX_BASE_URL"] = prev;
  }
}

async function withoutOmlxBaseEnvAsync<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env["OMLX_BASE_URL"];
  delete process.env["OMLX_BASE_URL"];
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["OMLX_BASE_URL"];
    else process.env["OMLX_BASE_URL"] = prev;
  }
}

function fetchReturning(status: number, body: string): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

function servedBody(...ids: string[]): string {
  return JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

test("omlxBaseUrl accepts loopback only", () => {
  assert.equal(omlxBaseUrl("http://localhost:8000/v1"), "http://localhost:8000/v1");
  assert.equal(omlxBaseUrl("http://127.0.0.1:9000/v1/"), "http://127.0.0.1:9000/v1");
  assert.equal(omlxBaseUrl("http://[::1]:8000/v1"), "http://[::1]:8000/v1");
  // The key must never be probed off-host (#364 posture).
  assert.equal(omlxBaseUrl("http://omlx.example.com/v1"), null);
  assert.equal(omlxBaseUrl("ftp://localhost/v1"), null);
  assert.equal(omlxBaseUrl("not a url"), null);
});

test("omlxBaseUrl uses configured provider baseUrl before localhost default", () => {
  withoutOmlxBaseEnv(() => {
    assert.equal(omlxBaseUrl(undefined, "http://127.0.0.1:9000/v1/"), "http://127.0.0.1:9000/v1");
    assert.equal(omlxBaseUrl("http://localhost:8000/v1", "http://127.0.0.1:9000/v1"), "http://localhost:8000/v1");
    assert.equal(omlxBaseUrl(undefined, "http://omlx.example.com/v1"), null);
  });
});

test("parseServedModels: ids extracted; empty 200 list is authoritative; malformed is null", () => {
  assert.deepEqual(parseServedModels(servedBody("coding-workhorse", "workhorse-8b")), new Set(["coding-workhorse", "workhorse-8b"]));
  assert.deepEqual(parseServedModels(servedBody()), new Set());
  assert.equal(parseServedModels("not json"), null);
  assert.equal(parseServedModels(JSON.stringify({ data: "nope" })), null);
});

test("served model list is returned when the server answers 200", async () => {
  const out = await fetchServedOmlxModels({
    fetchFn: fetchReturning(200, servedBody("coding-workhorse")),
    readKey: KEY,
    baseUrl: BASE,
  });
  assert.deepEqual(out, new Set(["coding-workhorse"]));
});

test("confirmed connection failure returns the authoritative empty set (server down)", async () => {
  const down: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };
  const out = await fetchServedOmlxModels({ fetchFn: down, readKey: KEY, baseUrl: BASE });
  assert.deepEqual(out, new Set());
});

test("timeout/abort fails open (a saturated server is not a dead server)", async () => {
  const slow: FetchLike = async () => {
    throw abortError();
  };
  assert.equal(await fetchServedOmlxModels({ fetchFn: slow, readKey: KEY, baseUrl: BASE }), null);
});

test("401/5xx fail open (server up; the probe's key must not kill a live candidate)", async () => {
  assert.equal(await fetchServedOmlxModels({ fetchFn: fetchReturning(401, ""), readKey: KEY, baseUrl: BASE }), null);
  assert.equal(await fetchServedOmlxModels({ fetchFn: fetchReturning(500, ""), readKey: KEY, baseUrl: BASE }), null);
});

test("malformed body fails open", async () => {
  assert.equal(await fetchServedOmlxModels({ fetchFn: fetchReturning(200, "garbage"), readKey: KEY, baseUrl: BASE }), null);
});

test("a missing key still probes (down-detection needs no auth); bearer sent when present", async () => {
  let seenAuth: string | undefined;
  const spy: FetchLike = async (_url, init) => {
    seenAuth = init.headers["Authorization"];
    return { ok: true, status: 200, text: async () => servedBody("coding-workhorse") };
  };
  await fetchServedOmlxModels({ fetchFn: spy, readKey: async () => null, baseUrl: BASE });
  assert.equal(seenAuth, undefined);
  await fetchServedOmlxModels({ fetchFn: spy, readKey: KEY, baseUrl: BASE });
  assert.equal(seenAuth, "Bearer test-key");
});

test("cache: conclusive results are reused within the TTL; null is never cached", async () => {
  clearOmlxCache();
  let calls = 0;
  const counting: FetchLike = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => servedBody("coding-workhorse") };
  };
  const deps = { fetchFn: counting, readKey: KEY, baseUrl: BASE };
  await getServedOmlxModels({ ...deps, now: () => 0 });
  await getServedOmlxModels({ ...deps, now: () => 30_000 });
  assert.equal(calls, 1); // within TTL — served from cache
  await getServedOmlxModels({ ...deps, now: () => 61_000 });
  assert.equal(calls, 2); // TTL expired — re-probed

  clearOmlxCache();
  let failCalls = 0;
  const failing: FetchLike = async () => {
    failCalls += 1;
    throw abortError(); // → null (ambiguous)
  };
  await getServedOmlxModels({ fetchFn: failing, readKey: KEY, baseUrl: BASE, now: () => 0 });
  await getServedOmlxModels({ fetchFn: failing, readKey: KEY, baseUrl: BASE, now: () => 1 });
  assert.equal(failCalls, 2); // null result was not cached — every call re-probes
  clearOmlxCache();
});

test("clearOmlxCache forces a fresh probe", async () => {
  clearOmlxCache();
  let calls = 0;
  const counting: FetchLike = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => servedBody("coding-workhorse") };
  };
  const deps = { fetchFn: counting, readKey: KEY, baseUrl: BASE, now: () => 0 };
  await getServedOmlxModels(deps);
  clearOmlxCache();
  await getServedOmlxModels(deps);
  assert.equal(calls, 2);
  clearOmlxCache();
});

test("resolveOmlxFilter: no omlx model registered → null without probing", async () => {
  let probed = 0;
  const spy: FetchLike = async () => {
    probed += 1;
    return { ok: true, status: 200, text: async () => servedBody() };
  };
  const out = await resolveOmlxFilter(
    { modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "opus" }] } },
    { fetchFn: spy, readKey: KEY, baseUrl: BASE },
  );
  assert.equal(out, null);
  assert.equal(probed, 0);
});

test("resolveOmlxFilter probes when an omlx model is registered", async () => {
  clearOmlxCache();
  const out = await resolveOmlxFilter(
    {
      modelRegistry: {
        getAvailable: () => [
          { provider: "omlx", id: "coding-workhorse" },
          { provider: "anthropic", id: "opus" },
        ],
      },
    },
    { fetchFn: fetchReturning(200, servedBody("coding-workhorse")), readKey: KEY, baseUrl: BASE },
  );
  assert.deepEqual(out, new Set(["coding-workhorse"]));
  clearOmlxCache();
});

test("resolveOmlxFilter probes the configured omlx baseUrl from the registry", async () => {
  await withoutOmlxBaseEnvAsync(async () => {
    clearOmlxCache();
    let seenUrl = "";
    const spy: FetchLike = async (url) => {
      seenUrl = String(url);
      return { ok: true, status: 200, text: async () => servedBody("coding-workhorse") };
    };
    const out = await resolveOmlxFilter(
      {
        modelRegistry: {
          getAvailable: () => [
            { provider: "omlx", id: "coding-workhorse", baseUrl: "http://127.0.0.1:9000/v1" },
          ],
        },
      },
      { fetchFn: spy, readKey: KEY },
    );
    assert.equal(seenUrl, "http://127.0.0.1:9000/v1/models");
    assert.deepEqual(out, new Set(["coding-workhorse"]));
    clearOmlxCache();
  });
});

test("resolveOmlxFilter uses modelRegistry.find baseUrl when available", async () => {
  await withoutOmlxBaseEnvAsync(async () => {
    clearOmlxCache();
    let seenUrl = "";
    const spy: FetchLike = async (url) => {
      seenUrl = String(url);
      return { ok: true, status: 200, text: async () => servedBody("coding-workhorse") };
    };
    const out = await resolveOmlxFilter(
      {
        modelRegistry: {
          getAvailable: () => [{ provider: "omlx", id: "coding-workhorse" }],
          find: () => ({ provider: "omlx", id: "coding-workhorse", baseUrl: "http://127.0.0.1:9100/v1" }),
        },
      },
      { fetchFn: spy, readKey: KEY },
    );
    assert.equal(seenUrl, "http://127.0.0.1:9100/v1/models");
    assert.deepEqual(out, new Set(["coding-workhorse"]));
    clearOmlxCache();
  });
});

test("resolveOmlxFilter fails open for a configured non-loopback baseUrl instead of probing default localhost", async () => {
  await withoutOmlxBaseEnvAsync(async () => {
    clearOmlxCache();
    let probed = 0;
    const spy: FetchLike = async () => {
      probed += 1;
      throw new TypeError("default localhost should not be probed");
    };
    const out = await resolveOmlxFilter(
      {
        modelRegistry: {
          getAvailable: () => [
            { provider: "omlx", id: "coding-workhorse", baseUrl: "http://omlx.example.com/v1" },
          ],
        },
      },
      { fetchFn: spy, readKey: KEY },
    );
    assert.equal(out, null);
    assert.equal(probed, 0);
    clearOmlxCache();
  });
});
