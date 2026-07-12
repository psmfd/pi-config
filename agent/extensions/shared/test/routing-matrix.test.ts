import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultMatrixPath, loadRoutingMatrix } from "../routing-matrix.ts";

// Loader behavior only (#352) — the committed file's schema/taxonomy checks
// live in auto-router/test/routing-matrix.test.ts (they need TASK_TYPES,
// which shared/ must not import).

async function withFile(content: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), "routing-matrix-"));
  const path = join(dir, "routing-matrix.json");
  try {
    await fs.writeFile(path, content, "utf8");
    await fn(path);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("loads a well-formed matrix", async () => {
  await withFile(
    JSON.stringify({
      v: 1,
      lastReviewed: "2026-07-06",
      models: { "omlx/workhorse": { capable: ["code-edit"], rationale: "r" } },
    }),
    async (path) => {
      const m = await loadRoutingMatrix(path);
      assert.deepEqual(m, {
        v: 1,
        lastReviewed: "2026-07-06",
        models: { "omlx/workhorse": { capable: ["code-edit"] } },
      });
    },
  );
});

test("missing file, malformed JSON, and non-object models all yield null (fail-soft)", async () => {
  assert.equal(await loadRoutingMatrix("/nonexistent/routing-matrix.json"), null);
  await withFile("{not json", async (path) => {
    assert.equal(await loadRoutingMatrix(path), null);
  });
  await withFile('{"v":1,"models":[]}', async (path) => {
    assert.equal(await loadRoutingMatrix(path), null);
  });
  await withFile('{"v":1,"lastReviewed":"2026-07-06"}', async (path) => {
    assert.equal(await loadRoutingMatrix(path), null);
  });
});

test("drops malformed rows and non-string capable entries, keeps the rest", async () => {
  await withFile(
    JSON.stringify({
      v: 1,
      lastReviewed: "2026-07-06",
      models: {
        "good/model": { capable: ["simple-qa", 42, "code-edit", null] },
        "bad/no-capable": { rationale: "no capable array" },
        "bad/capable-not-array": { capable: "simple-qa" },
      },
    }),
    async (path) => {
      const m = await loadRoutingMatrix(path);
      assert.deepEqual(m?.models, { "good/model": { capable: ["simple-qa", "code-edit"] } });
    },
  );
});

test("defaultMatrixPath resolves next to the shared module and loads the committed file", async () => {
  assert.match(defaultMatrixPath(), /agent\/extensions\/shared\/routing-matrix\.json$/);
  const m = await loadRoutingMatrix();
  assert.notEqual(m, null);
  assert.equal(m!.v, 1);
  assert.equal(Object.keys(m!.models).length > 0, true);
});

// --- #660: refresh audit block ---

test("parses a valid refresh block; inputsHash optional", async () => {
  await withFile(
    JSON.stringify({
      v: 1,
      lastReviewed: "2026-07-06",
      refresh: {
        at: "2026-07-12T11:00:00Z",
        tool: "scripts/analyze-routing-matrix.sh",
        source: "214 turn(s) from 1 log(s), 2026-06-01..2026-07-10",
        inputsHash: "sha256:abc",
      },
      models: { "good/model": { capable: ["simple-qa"] } },
    }),
    async (path) => {
      const m = await loadRoutingMatrix(path);
      assert.deepEqual(m?.refresh, {
        at: "2026-07-12T11:00:00Z",
        tool: "scripts/analyze-routing-matrix.sh",
        source: "214 turn(s) from 1 log(s), 2026-06-01..2026-07-10",
        inputsHash: "sha256:abc",
      });
    },
  );
});

test("absent or malformed refresh block is dropped; matrix still loads", async () => {
  await withFile(
    JSON.stringify({ v: 1, lastReviewed: "2026-07-06", models: { "a/b": { capable: ["simple-qa"] } } }),
    async (path) => {
      const m = await loadRoutingMatrix(path);
      assert.equal(m?.refresh, undefined);
      assert.equal(Object.keys(m!.models).length, 1);
    },
  );
  await withFile(
    JSON.stringify({
      v: 1,
      lastReviewed: "2026-07-06",
      refresh: { at: 42, tool: null },
      models: { "a/b": { capable: ["simple-qa"] } },
    }),
    async (path) => {
      const m = await loadRoutingMatrix(path);
      assert.equal(m?.refresh, undefined);
      assert.equal(Object.keys(m!.models).length, 1);
    },
  );
});

test("no-write invariant (#660): the loader module exposes no write API", async () => {
  // The never-auto-refresh discipline is structural: routing-matrix.ts must
  // never gain a write path. Pins the module source itself.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../routing-matrix.ts", import.meta.url), "utf8");
  assert.equal(/writeFile|appendFile|createWriteStream/.test(src), false);
});

// --- matrix gardening (#656 follow-through) ---

test("gardenMatrix: dangling rows flagged only for onboarded providers", async () => {
  const synthetic = {
    v: 1,
    lastReviewed: "2026-07-12",
    models: {
      "copilot/live": { capable: ["simple-qa"] },
      "copilot/retired": { capable: ["simple-qa"] },
      "openai-codex/gpt-5.6-sol": { capable: ["simple-qa"] },
    },
  };
  const { gardenMatrix } = await import("../routing-matrix.ts");
  const g = gardenMatrix(synthetic, new Set(["copilot/live", "copilot/other"]));
  // copilot/retired: provider onboarded, id gone → dangling.
  // openai-codex row: provider not onboarded at all → inert, NOT dangling.
  assert.deepEqual(g.danglingRows, ["copilot/retired"]);
  assert.deepEqual(g.unlistedByProvider, { copilot: 1 });
});

test("gardenMatrix: clean matrix yields empty report", async () => {
  const { gardenMatrix } = await import("../routing-matrix.ts");
  const synthetic = {
    v: 1,
    lastReviewed: "2026-07-12",
    models: { "p/a": { capable: ["simple-qa"] } },
  };
  const g = gardenMatrix(synthetic, new Set(["p/a"]));
  assert.deepEqual(g.danglingRows, []);
  assert.deepEqual(g.unlistedByProvider, {});
});
