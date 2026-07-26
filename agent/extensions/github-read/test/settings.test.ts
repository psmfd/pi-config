import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadGithubReadSettings } from "../settings.ts";

test("sensitive domains default disabled", async () => {
  const settings = await loadGithubReadSettings("/definitely/missing/settings.json");
  assert.deepEqual(settings, { security: false, notifications: false });
});

test("only literal user-layer true enables sensitive domains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "github-read-settings-"));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ extensionSettings: { githubRead: { security: true, notifications: "true" } } }));
  const settings = await loadGithubReadSettings(path);
  assert.deepEqual(settings, { security: true, notifications: false });
});
