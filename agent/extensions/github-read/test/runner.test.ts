import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { probeGithubIdentity, runGh, sanitizeDiagnostic } from "../runner.ts";

async function fakeGh(body: string): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "github-read-gh-"));
  const path = join(dir, "gh");
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o700);
  return { PATH: dir, HOME: dir, GH_TOKEN: "test-token-not-output" };
}

test("runner executes an argv vector without a shell", async () => {
  const env = await fakeGh("printf '%s\\n' \"$@\"");
  const out = await runGh(["issue", "list", "value;touch /tmp/nope"], undefined, 1000, env);
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /value;touch \/tmp\/nope/);
  assert.equal(out.authSource, "GH_TOKEN");
});

test("identity probe validates a login", async () => {
  const env = await fakeGh("printf 'TheSemicolon\\n'");
  const out = await probeGithubIdentity(undefined, env);
  assert.equal(out.login, "TheSemicolon");
  assert.equal(out.authSource, "GH_TOKEN");
});

test("identity probe rejects malformed output", async () => {
  const env = await fakeGh("printf 'not a login!\\n'");
  await assert.rejects(probeGithubIdentity(undefined, env), /invalid login/);
});

test("runner times out and fails closed", async () => {
  const env = await fakeGh("while :; do :; done");
  await assert.rejects(runGh(["api", "/user"], undefined, 20, env), /timed out/);
});

test("runner refuses NUL arguments before spawn", async () => {
  await assert.rejects(runGh(["bad\u0000arg"]), /invalid gh argument/);
});

test("diagnostics redact token-shaped stderr", () => {
  const diagnostic = sanitizeDiagnostic("failed with github_pat_abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz");
  assert.doesNotMatch(diagnostic, /github_pat_|ghp_/);
  assert.match(diagnostic, /REDACTED/);
});
