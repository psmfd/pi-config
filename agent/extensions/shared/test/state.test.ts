import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadState, saveState, stateFile, STATE_SCHEMA_VERSION } from "../state.ts";

async function tmpAgentDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "pi-suite-state-"));
}

interface RouterState {
  enabled: boolean;
  classifierModel: string;
}

test("stateFile resolves under <agentDir>/extensions/<namespace>/state.json", () => {
  assert.equal(
    stateFile("auto-router", "/base"),
    join("/base", "extensions", "auto-router", "state.json"),
  );
});

test("saveState then loadState round-trips data", async () => {
  const dir = await tmpAgentDir();
  const value: RouterState = { enabled: true, classifierModel: "anthropic/haiku" };
  await saveState("auto-router", value, dir);
  const loaded = await loadState<RouterState>("auto-router", { enabled: false, classifierModel: "" }, dir);
  assert.deepEqual(loaded, value);
});

test("loadState returns the fallback when the file is missing", async () => {
  const dir = await tmpAgentDir();
  const fallback: RouterState = { enabled: false, classifierModel: "default" };
  assert.deepEqual(await loadState("auto-router", fallback, dir), fallback);
});

test("loadState returns the fallback on a schema-version mismatch", async () => {
  const dir = await tmpAgentDir();
  const file = stateFile("auto-router", dir);
  await fs.mkdir(join(dir, "extensions", "auto-router"), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ v: STATE_SCHEMA_VERSION + 99, data: { enabled: true } }), "utf8");
  const fallback: RouterState = { enabled: false, classifierModel: "default" };
  assert.deepEqual(await loadState("auto-router", fallback, dir), fallback);
});

test("loadState returns the fallback on malformed JSON", async () => {
  const dir = await tmpAgentDir();
  const file = stateFile("auto-router", dir);
  await fs.mkdir(join(dir, "extensions", "auto-router"), { recursive: true });
  await fs.writeFile(file, "{ not json", "utf8");
  const fallback: RouterState = { enabled: false, classifierModel: "default" };
  assert.deepEqual(await loadState("auto-router", fallback, dir), fallback);
});

test("saveState writes a schema-versioned envelope", async () => {
  const dir = await tmpAgentDir();
  await saveState("indexer", { lastIndexed: 123 }, dir);
  const raw = await fs.readFile(stateFile("indexer", dir), "utf8");
  const parsed = JSON.parse(raw) as { v: number; data: { lastIndexed: number } };
  assert.equal(parsed.v, STATE_SCHEMA_VERSION);
  assert.equal(parsed.data.lastIndexed, 123);
});
