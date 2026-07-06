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
