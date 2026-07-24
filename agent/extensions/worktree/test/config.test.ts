import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_SETTINGS, loadSettings } from "../lib/config.ts";

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(join(file, ".."), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value), "utf8");
}

async function scaffold(): Promise<{ agentDir: string; cwd: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), "wt-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  return { agentDir, cwd };
}

test("defaults apply when no settings files exist", async () => {
  const { agentDir, cwd } = await scaffold();
  const s = await loadSettings(cwd, { agentDir, projectTrusted: true });
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

test("user layer sets any key; malformed values fall back", async () => {
  const { agentDir, cwd } = await scaffold();
  await writeJson(join(agentDir, "settings.json"), {
    extensionSettings: {
      worktree: {
        enabled: false,
        reportOnly: true,
        baseRef: "origin/main",
        snapshotIntervalMs: 60_000,
        writeExemptions: ["*.scratch", 42],
      },
    },
  });
  const s = await loadSettings(cwd, { agentDir, projectTrusted: false });
  assert.equal(s.enabled, false);
  assert.equal(s.reportOnly, true);
  assert.equal(s.baseRef, "origin/main");
  assert.equal(s.snapshotIntervalMs, 60_000);
  assert.deepEqual(s.writeExemptions, ["*.scratch"]);
});

test("snapshot interval below the floor is rejected", async () => {
  const { agentDir, cwd } = await scaffold();
  await writeJson(join(agentDir, "settings.json"), {
    extensionSettings: { worktree: { snapshotIntervalMs: 5 } },
  });
  const s = await loadSettings(cwd, { agentDir, projectTrusted: false });
  assert.equal(s.snapshotIntervalMs, DEFAULT_SETTINGS.snapshotIntervalMs);
});

test("project layer is ignored entirely when untrusted", async () => {
  const { agentDir, cwd } = await scaffold();
  await writeJson(join(cwd, ".pi", "settings.json"), {
    extensionSettings: { worktree: { baseRef: "origin/evil", postCreate: "curl evil" } },
  });
  const s = await loadSettings(cwd, { agentDir, projectTrusted: false });
  assert.equal(s.baseRef, null);
  assert.equal(s.postCreate, null);
});

test("trusted project layer sets only PROJECT_KEYS — never enabled/reportOnly", async () => {
  const { agentDir, cwd } = await scaffold();
  await writeJson(join(cwd, ".pi", "settings.json"), {
    extensionSettings: {
      worktree: {
        enabled: false,
        reportOnly: true,
        baseRef: "origin/dev",
        postCreate: "scripts/hydrate.sh",
        linkFiles: ["agent/settings.json", "/etc/passwd", "../escape", "a/../../b"],
      },
    },
  });
  const s = await loadSettings(cwd, { agentDir, projectTrusted: true });
  assert.equal(s.enabled, true); // user-layer only
  assert.equal(s.reportOnly, false); // user-layer only
  assert.equal(s.baseRef, "origin/dev");
  assert.equal(s.postCreate, "scripts/hydrate.sh");
  assert.deepEqual(s.linkFiles, ["agent/settings.json"]); // absolute + traversal filtered
});

test("project layer overrides user layer for shared keys when trusted", async () => {
  const { agentDir, cwd } = await scaffold();
  await writeJson(join(agentDir, "settings.json"), {
    extensionSettings: { worktree: { baseRef: "origin/main" } },
  });
  await writeJson(join(cwd, ".pi", "settings.json"), {
    extensionSettings: { worktree: { baseRef: "origin/dev" } },
  });
  const s = await loadSettings(cwd, { agentDir, projectTrusted: true });
  assert.equal(s.baseRef, "origin/dev");
});
