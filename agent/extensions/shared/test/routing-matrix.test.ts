import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultMatrixPath,
  gardenMatrix,
  loadRoutingMatrix,
  loadRoutingMatrixResult,
} from "../routing-matrix.ts";

async function withFile(content: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "routing-matrix-"));
  const path = join(dir, "routing-matrix.json");
  try {
    await writeFile(path, content, "utf8");
    await fn(path);
  } finally {
    await chmod(path, 0o600).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

function validMatrix(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    lastReviewed: "2026-07-06",
    staleAfterDays: 180,
    models: {
      "omlx/workhorse": {
        capable: ["code-edit"],
        tier: "fast",
        rationale: "fixture evidence",
      },
    },
    ...overrides,
  });
}

test("loads and retains every runtime matrix metadata field", async () => {
  await withFile(
    validMatrix({
      refresh: {
        at: "2026-07-12T11:00:00Z",
        tool: "scripts/analyze-routing-matrix.sh",
        source: "214 routed turns",
        inputsHash: "sha256:abc",
      },
    }),
    async (path) => {
      const result = await loadRoutingMatrixResult(path, new Date("2026-07-16T00:00:00Z"));
      assert.equal(result.ok, true);
      if (!result.ok) assert.fail("expected a loaded matrix");
      assert.deepEqual(result.matrix, {
        v: 1,
        lastReviewed: "2026-07-06",
        staleAfterDays: 180,
        refresh: {
          at: "2026-07-12T11:00:00Z",
          tool: "scripts/analyze-routing-matrix.sh",
          source: "214 routed turns",
          inputsHash: "sha256:abc",
        },
        models: {
          "omlx/workhorse": {
            capable: ["code-edit"],
            tier: "fast",
            rationale: "fixture evidence",
          },
        },
      });
      assert.deepEqual(result.diagnostics, []);
    },
  );
});

test("canonicalizes model and capability order independently of JSON insertion order", async () => {
  const reverseModels = {
    "provider-z/zed": {
      capable: ["creative", "simple-qa"],
      rationale: "z evidence",
    },
    "provider-a/alpha": {
      capable: ["code-review", "code-edit"],
      rationale: "a evidence",
    },
  };
  await withFile(validMatrix({ models: reverseModels }), async (path) => {
    const result = await loadRoutingMatrixResult(path, new Date("2026-07-16T00:00:00Z"));
    if (!result.ok) assert.fail("expected a loaded matrix");
    assert.deepEqual(Object.keys(result.matrix.models), ["provider-a/alpha", "provider-z/zed"]);
    assert.deepEqual(result.matrix.models["provider-a/alpha"]?.capable, ["code-edit", "code-review"]);
    assert.equal(result.matrix.models["provider-a/alpha"]?.rationale, "a evidence");
    assert.deepEqual(result.matrix.models["provider-z/zed"]?.capable, ["simple-qa", "creative"]);
    assert.equal(result.matrix.models["provider-z/zed"]?.rationale, "z evidence");
  });
});

test("distinguishes missing, unreadable, and malformed files with stable codes", async () => {
  const missing = await loadRoutingMatrixResult("/nonexistent/routing-matrix.json");
  assert.equal(missing.ok, false);
  assert.equal(missing.diagnostics[0]?.code, "missing");

  await withFile(validMatrix(), async (path) => {
    await chmod(path, 0o000);
    const unreadable = await loadRoutingMatrixResult(path);
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.diagnostics[0]?.code, "unreadable");
  });

  await withFile("{not json", async (path) => {
    const malformed = await loadRoutingMatrixResult(path);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.diagnostics[0]?.code, "invalid-json");
  });
});

test("rejects unsupported versions separately from schema failures", async () => {
  await withFile(validMatrix({ v: 2 }), async (path) => {
    const result = await loadRoutingMatrixResult(path);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "unsupported-version");
  });

  await withFile(validMatrix({ models: [] }), async (path) => {
    const result = await loadRoutingMatrixResult(path);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "invalid-schema");
  });
});

test("strictly validates metadata, keys, rows, task types, tiers, and refresh shape", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["lastReviewed", { lastReviewed: "2026-02-30" }],
    ["future lastReviewed", { lastReviewed: "2099-01-01" }],
    ["staleAfterDays", { staleAfterDays: 0 }],
    ["model key", { models: { invalid: { capable: ["code-edit"], rationale: "r" } } }],
    ["row shape", { models: { "good/model": null } }],
    ["capable", { models: { "good/model": { capable: [], rationale: "r" } } }],
    ["task type", { models: { "good/model": { capable: ["invented"], rationale: "r" } } }],
    ["tier", { models: { "good/model": { capable: ["code-edit"], tier: "premium", rationale: "r" } } }],
    ["rationale", { models: { "good/model": { capable: ["code-edit"], rationale: "" } } }],
    ["refresh", { refresh: { at: 42, tool: null, source: "x" } }],
  ];

  for (const [name, overrides] of cases) {
    await withFile(validMatrix(overrides), async (path) => {
      const result = await loadRoutingMatrixResult(path);
      assert.equal(result.ok, false, name);
      assert.equal(result.diagnostics[0]?.code, "invalid-schema", name);
    });
  }
});

test("row schema diagnostics retain structured capability/rationale/tier context", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ models: { "good/model": { capable: [], rationale: "r" } } }, "capable"],
    [{ models: { "good/model": { capable: ["code-edit"], rationale: "" } } }, "rationale"],
    [{ models: { "good/model": { capable: ["code-edit"], tier: "premium", rationale: "r" } } }, "tier"],
  ];
  for (const [overrides, field] of cases) {
    await withFile(validMatrix(overrides), async (path) => {
      const result = await loadRoutingMatrixResult(path);
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]?.row, "good/model");
      assert.equal(result.diagnostics[0]?.field, field);
    });
  }
});

test("refresh diagnostics identify the invalid field and reject non-UTC or future timestamps", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ refresh: { at: "2026-07-12", tool: "tool", source: "source" } }, /refresh\.at must be an ISO/],
    [{ refresh: { at: "2099-01-01T00:00:00Z", tool: "tool", source: "source" } }, /refresh\.at must not be in the future/],
    [{ refresh: { at: "2026-07-12T00:00:00Z", tool: "", source: "source" } }, /refresh\.tool/],
    [{ refresh: { at: "2026-07-12T00:00:00Z", tool: "tool", source: "" } }, /refresh\.source/],
    [{ refresh: { at: "2026-07-12T00:00:00Z", tool: "tool", source: "source", inputsHash: "" } }, /refresh\.inputsHash/],
  ];
  for (const [overrides, message] of cases) {
    await withFile(validMatrix(overrides), async (path) => {
      const result = await loadRoutingMatrixResult(path, new Date("2026-07-16T00:00:00Z"));
      assert.equal(result.ok, false);
      assert.match(result.diagnostics[0]?.message ?? "", message);
    });
  }
});

test("reports stale policy as a warning while keeping the matrix usable", async () => {
  await withFile(
    validMatrix({ lastReviewed: "2026-01-01", staleAfterDays: 30 }),
    async (path) => {
      const result = await loadRoutingMatrixResult(path, new Date("2026-07-16T00:00:00Z"));
      assert.equal(result.ok, true);
      if (!result.ok) assert.fail("stale policy must remain loadable");
      assert.equal(result.diagnostics[0]?.code, "stale");
      assert.equal(result.diagnostics[0]?.severity, "warning");
      assert.equal(result.matrix.staleAfterDays, 30);
    },
  );
});

test("legacy fail-soft adapter returns null for typed load failures", async () => {
  assert.equal(await loadRoutingMatrix("/nonexistent/routing-matrix.json"), null);
  await withFile(validMatrix(), async (path) => {
    assert.notEqual(await loadRoutingMatrix(path), null);
  });
});

test("defaultMatrixPath resolves next to the shared module and loads the committed file", async () => {
  assert.match(defaultMatrixPath(), /agent\/extensions\/shared\/routing-matrix\.json$/);
  const result = await loadRoutingMatrixResult();
  if (!result.ok) assert.fail(result.diagnostics.map((d) => d.message).join("; "));
  assert.equal(result.ok, true);
  assert.equal(result.matrix.v, 1);
  assert.equal(Object.keys(result.matrix.models).length > 0, true);
});

test("no-write invariant: the loader module exposes no write API", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../routing-matrix.ts", import.meta.url), "utf8");
  assert.equal(/writeFile|appendFile|createWriteStream/.test(src), false);
});

test("gardenMatrix flags dangling rows only for onboarded providers", () => {
  const synthetic = {
    v: 1,
    lastReviewed: "2026-07-12",
    models: {
      "copilot/live": { capable: ["simple-qa"] },
      "copilot/retired": { capable: ["simple-qa"] },
      "openai-codex/gpt-5.6-sol": { capable: ["simple-qa"] },
    },
  };
  const g = gardenMatrix(synthetic, new Set(["copilot/live", "copilot/other"]));
  assert.deepEqual(g.danglingRows, ["copilot/retired"]);
  assert.deepEqual(g.unlistedByProvider, { copilot: 1 });
});

test("gardenMatrix returns an empty report for a clean matrix", () => {
  const synthetic = {
    v: 1,
    lastReviewed: "2026-07-12",
    models: { "p/a": { capable: ["simple-qa"] } },
  };
  const g = gardenMatrix(synthetic, new Set(["p/a"]));
  assert.deepEqual(g.danglingRows, []);
  assert.deepEqual(g.unlistedByProvider, {});
});
