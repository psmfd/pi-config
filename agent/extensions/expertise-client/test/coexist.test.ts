/**
 * expertise-client — coexistence guard tests (ADR-0029).
 *
 * Verifies the global client stands down when the current project ships a
 * conflicting expertise extension, honors the SKIP_EXPERTISE_CLIENT override,
 * and otherwise registers normally. Hermetic: all detection runs against
 * throwaway temp directories.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  shouldSkipRegistration,
  findConflictingProjectExtension,
  SKIP_ENV,
  MAX_SCAN_ENTRIES,
} from "../lib/coexist.ts";

/** Create `<root>/.pi/extensions/<name>/index.ts` containing `body`. */
async function writeProjectExtension(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, ".pi", "extensions", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "index.ts"), body);
}

/** Create the single-file form `<root>/.pi/extensions/<name>.ts` containing `body`. */
async function writeSingleFileExtension(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, ".pi", "extensions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${name}.ts`), body);
}

const SEARCH_REG = 'pi.registerTool({ name: "expertise_search", label: "x" });';
const CREATE_REG = "pi.registerTool({ name: 'expertise_create' });";
const UNRELATED_REG = 'pi.registerTool({ name: "something_else" });';

test("SKIP_EXPERTISE_CLIENT truthy forces skip without touching the filesystem", () => {
  for (const v of ["1", "true", "YES", " on "]) {
    const d = shouldSkipRegistration({ env: { [SKIP_ENV]: v }, cwd: "/nonexistent" });
    assert.equal(d.skip, true, `value ${JSON.stringify(v)} should skip`);
    assert.match(d.reason, /SKIP_EXPERTISE_CLIENT/);
  }
});

test("SKIP_EXPERTISE_CLIENT falsey does not force skip", () => {
  for (const v of ["0", "false", "", undefined]) {
    const d = shouldSkipRegistration({ env: { [SKIP_ENV]: v }, cwd: "/nonexistent" });
    assert.equal(d.skip, false, `value ${JSON.stringify(v)} should not skip`);
  }
});

test("no skip when the project has no .pi/extensions directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "exp-coexist-"));
  try {
    assert.equal(findConflictingProjectExtension(root), null);
    assert.equal(shouldSkipRegistration({ env: {}, cwd: root }).skip, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skip when a project extension registers expertise_search", async () => {
  const root = await mkdtemp(join(tmpdir(), "exp-coexist-"));
  try {
    await writeProjectExtension(root, "expertise-api", SEARCH_REG);
    assert.equal(findConflictingProjectExtension(root), "expertise-api");
    const d = shouldSkipRegistration({ env: {}, cwd: root });
    assert.equal(d.skip, true);
    assert.match(d.reason, /expertise-api/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skip when a project extension registers expertise_create (single-quoted)", async () => {
  const root = await mkdtemp(join(tmpdir(), "exp-coexist-"));
  try {
    await writeProjectExtension(root, "some-ext", CREATE_REG);
    assert.equal(shouldSkipRegistration({ env: {}, cwd: root }).skip, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skip when a single-file project extension (.pi/extensions/<name>.ts) conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "exp-coexist-"));
  try {
    await writeSingleFileExtension(root, "expertise-api", SEARCH_REG);
    assert.equal(findConflictingProjectExtension(root), "expertise-api.ts");
    const d = shouldSkipRegistration({ env: {}, cwd: root });
    assert.equal(d.skip, true);
    assert.match(d.reason, /expertise-api\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no skip when a project extension registers only unrelated tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "exp-coexist-"));
  try {
    await writeProjectExtension(root, "unrelated-ext", UNRELATED_REG);
    assert.equal(findConflictingProjectExtension(root), null);
    assert.equal(shouldSkipRegistration({ env: {}, cwd: root }).skip, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detection is not fooled by a directory lacking index.ts", async () => {
  const root = await mkdtemp(join(tmpdir(), "exp-coexist-"));
  try {
    await fs.mkdir(join(root, ".pi", "extensions", "empty-ext"), { recursive: true });
    assert.equal(findConflictingProjectExtension(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a key merely ending in 'name' does not trigger a false positive", async () => {
  const root = await mkdtemp(join(tmpdir(), "exp-coexist-"));
  try {
    await writeProjectExtension(root, "ext", 'const tool_name = { name_label: "expertise_search" };');
    assert.equal(findConflictingProjectExtension(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an index.ts larger than the scan cap is skipped (fails open)", async () => {
  const root = await mkdtemp(join(tmpdir(), "exp-coexist-"));
  try {
    const padding = "// pad\n".repeat(80_000); // ~560 KB, over the 512 KB cap
    await writeProjectExtension(root, "huge-ext", padding + SEARCH_REG);
    assert.equal(findConflictingProjectExtension(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a conflicting extension beyond MAX_SCAN_ENTRIES is not scanned", async () => {
  const root = await mkdtemp(join(tmpdir(), "exp-coexist-"));
  try {
    // Fill the cap with non-conflicting dirs that sort BEFORE the conflicting
    // one ("000..." < "zzz-..."), pushing the real conflict past the limit.
    for (let i = 0; i <= MAX_SCAN_ENTRIES; i++) {
      await writeProjectExtension(root, `ext-${String(i).padStart(4, "0")}`, UNRELATED_REG);
    }
    await writeProjectExtension(root, "zzz-conflict", SEARCH_REG);
    assert.equal(findConflictingProjectExtension(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
