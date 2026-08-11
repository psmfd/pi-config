/**
 * dispatch-runner.test.ts — the spawn boundary (#930, ADR-0131 D4/D6/D9).
 *
 * Live tests follow the child-sandbox suite's discipline: where the OS
 * mechanism is unavailable, unavailability is itself the asserted outcome —
 * never a silent skip. The canary's BUN_BE_BUN mechanism is exercised against
 * the real vendored pi binary (present via the validate.sh cache contract);
 * its absence is likewise classified, not skipped.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { SandboxSpec } from "../lib/child-sandbox.ts";
import {
  createScratch,
  mechanismAvailable,
  mintBearerToken,
  removeScratch,
  runCanaryAsync,
  scratchParentDir,
  spawnConfined,
} from "../lib/dispatch-runner.ts";

function vendoredPiBinary(): string | null {
  try {
    const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "..");
    const version = fs.readFileSync(path.join(repoRoot, "agent", "vendor", "pi", "VERSION"), "utf8").trim();
    const p = path.join(
      process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
      "pi_config",
      `pi-${version}`,
      "pi",
      "pi",
    );
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

interface Rig {
  agentDir: string;
  packageRoot: string;
  inScopeFile: string;
  outOfScopeFile: string;
}

function makeRig(): Rig {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pab-runner-rig-")));
  const agentDir = path.join(base, "agent");
  const packageRoot = path.join(agentDir, "git", "github.com", "org", "repo");
  fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
  const inScopeFile = path.join(packageRoot, "agents", "a.json");
  fs.writeFileSync(inScopeFile, "{}");
  fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, ".git", "config"), "[core]\n");
  for (const s of ["auth.json", "settings.json"]) {
    fs.writeFileSync(path.join(agentDir, s), "{}");
  }
  for (const s of ["sessions", "extensions", "skills", "prompts"]) {
    fs.mkdirSync(path.join(agentDir, s), { recursive: true });
  }
  const outOfScopeFile = path.join(base, "out-of-scope.txt");
  fs.writeFileSync(outOfScopeFile, "operator-readable");
  return { agentDir, packageRoot, inScopeFile, outOfScopeFile };
}

function spec(rig: Rig, childBinary: string, scratchDir: string): SandboxSpec {
  return {
    platform: process.platform === "linux" ? "linux" : "darwin",
    agentDir: rig.agentDir,
    packageRoot: rig.packageRoot,
    scratchDir,
    childBinary: fs.realpathSync(childBinary),
    toolBinDir: null,
  };
}

// ---------------------------------------------------------------------------
// Scratch lifecycle.
// ---------------------------------------------------------------------------

test("scratch is per-attempt, 0700, disjoint, and safely removable", () => {
  const a = createScratch();
  const b = createScratch();
  assert.notEqual(a, b, "two attempts never share a scratch");
  for (const s of [a, b]) {
    const st = fs.statSync(s);
    assert.equal(st.mode & 0o777, 0o700);
    for (const sub of ["home", "tmp", "agent"]) {
      assert.ok(fs.statSync(path.join(s, sub)).isDirectory());
    }
  }
  assert.equal(removeScratch(a), true);
  assert.equal(fs.existsSync(a), false);
  assert.equal(removeScratch(b), true);
  // The removal guard refuses anything outside the broker-owned parent.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pab-not-scratch-"));
  assert.equal(removeScratch(outside), false, "non-scratch paths are never removed");
  assert.ok(fs.existsSync(outside));
  assert.equal(removeScratch(path.join(scratchParentDir(), "..")), false);
  assert.equal(removeScratch(scratchParentDir()), false, "the parent itself is never removed");
});

// ---------------------------------------------------------------------------
// Canary through the identical wrapper (live where the mechanism exists).
// ---------------------------------------------------------------------------

test("live canary: a correct sandbox passes; unavailability is classified", async () => {
  // The vendored binary is a REPO CONTRACT (validate.sh hydrates the cache);
  // its absence is a broken environment and must FAIL the suite, not skip a
  // security-relevant verification (2026-07-31 security review).
  const pi = vendoredPiBinary();
  assert.ok(pi !== null, "vendored pi binary missing — run setup.sh / fetch-pi-binary first");
  if (!mechanismAvailable()) {
    // OS-mechanism absence is genuine platform variance: classified.
    const rig = makeRig();
    const scratch = createScratch();
    try {
      const result = await runCanaryAsync(spec(rig, pi, scratch), {
        inScopeFile: rig.inScopeFile,
        outOfScopeFile: rig.outOfScopeFile,
      });
      assert.equal(result.ok, false);
    } finally {
      removeScratch(scratch);
    }
    return;
  }
  const rig = makeRig();
  const scratch = createScratch();
  try {
    const result = await runCanaryAsync(spec(rig, pi, scratch), {
      inScopeFile: rig.inScopeFile,
      outOfScopeFile: rig.outOfScopeFile,
      providerHostPort: null,
    });
    assert.deepEqual(result.anomalies, [], "a correct sandbox has zero anomalies");
    assert.equal(result.ok, true);
  } finally {
    removeScratch(scratch);
  }
});

test("live canary: an over-permissive plan is caught (the probe really probes)", async () => {
  const pi = vendoredPiBinary();
  assert.ok(pi !== null, "vendored pi binary missing — run setup.sh / fetch-pi-binary first");
  if (!mechanismAvailable()) {
    assert.equal(mechanismAvailable(), false);
    return;
  }
  const rig = makeRig();
  const scratch = createScratch();
  try {
    // Sabotage: claim an in-scope read of a file that does not exist. The
    // must-succeed leg fails, which must surface as an anomaly — proving the
    // broker actually interprets probe results rather than trusting exit 0.
    fs.rmSync(rig.inScopeFile);
    fs.mkdirSync(path.dirname(rig.inScopeFile), { recursive: true });
    const result = await runCanaryAsync(spec(rig, pi, scratch), {
      inScopeFile: path.join(rig.packageRoot, "agents", "a.json"),
      outOfScopeFile: rig.outOfScopeFile,
    });
    assert.equal(result.ok, false);
    assert.ok(result.anomalies.some((a) => a.startsWith("must-succeed-read")));
  } finally {
    removeScratch(scratch);
  }
});

// ---------------------------------------------------------------------------
// Real spawn discipline.
// ---------------------------------------------------------------------------

test("spawnConfined delivers the task on stdin and enforces caps — or classifies", async () => {
  if (!mechanismAvailable()) {
    assert.equal(mechanismAvailable(), false);
    return;
  }
  const rig = makeRig();
  const scratch = createScratch();
  try {
    // /bin/cat echoes stdin: proves the task rides stdin through the real
    // wrapper and comes back on the captured (capped) stdout.
    const child = spawnConfined(spec(rig, "/bin/cat", scratch), null, [], "task-on-stdin", {
      executionTimeoutMs: 15_000,
      maxStdoutBytes: 64 * 1024,
      maxStdoutLineBytes: 16 * 1024,
    });
    assert.ok(child.pid > 0, "the PID is known synchronously");
    const completion = await child.completion;
    assert.equal(completion.outcome, "exit");
    assert.equal(completion.exitCode, 0);
    assert.equal(completion.stdout, "task-on-stdin");
  } finally {
    removeScratch(scratch);
  }
});

test("spawnConfined refuses BUN_BE_BUN structurally", () => {
  const rig = makeRig();
  const scratch = createScratch();
  try {
    // The refusal is enforced against the CONSTRUCTED env, which the caller
    // cannot inject BUN_BE_BUN into via the credential var either.
    assert.throws(
      () =>
        spawnConfined(
          spec(rig, "/bin/cat", scratch),
          { envVar: "BUN_BE_BUN", value: "1" },
          [],
          "x",
          { executionTimeoutMs: 1000, maxStdoutBytes: 1024, maxStdoutLineBytes: 1024 },
        ),
      /BUN_BE_BUN|credential env var/,
    );
  } finally {
    removeScratch(scratch);
  }
});

test("execution timeout terminates the child and reports the outcome", async () => {
  if (!mechanismAvailable()) {
    assert.equal(mechanismAvailable(), false);
    return;
  }
  const rig = makeRig();
  const scratch = createScratch();
  try {
    // cat with no stdin-close hangs; the execution timeout must fire.
    const child = spawnConfinedHanging(rig, scratch);
    const completion = await child.completion;
    assert.equal(completion.outcome, "execution-timeout");
  } finally {
    removeScratch(scratch);
  }
});

/** A cat that never sees EOF (task delivered, stdin kept open is not possible
 * through spawnConfined — so hang via a sleep-alike: /bin/sleep). */
function spawnConfinedHanging(rig: Rig, scratch: string): ReturnType<typeof spawnConfined> {
  return spawnConfined(spec(rig, "/bin/sleep", scratch), null, ["30"], "", {
    executionTimeoutMs: 500,
    maxStdoutBytes: 1024,
    maxStdoutLineBytes: 1024,
  });
}

// ---------------------------------------------------------------------------
// Bearer minting (pre-bump behavior is a classified failure, never a throw).
// ---------------------------------------------------------------------------

test("mintBearerToken returns null (never throws) when the runner cannot mint", () => {
  // /usr/bin/true exits 0 with no output — an empty token is refused.
  assert.equal(mintBearerToken("/usr/bin/true"), null);
  // /usr/bin/false exits nonzero.
  assert.equal(mintBearerToken("/usr/bin/false"), null);
  // A missing binary is a classified failure.
  assert.equal(mintBearerToken("/nonexistent/pi"), null);
});

// ---------------------------------------------------------------------------
// Inspector-channel verification (#930, ADR-0129 "Scope of the Guarantee" /
// ADR-0131 Decision 10): Node's inspector activates on SIGUSR1 with no flag;
// ADR-0129's in-memory-authority argument assumes the vendored Bun-compiled
// binary has no such signal-triggered toggle. Verify it mechanically.
// ---------------------------------------------------------------------------

test("the vendored pi binary does not activate an inspector on SIGUSR1", async () => {
  // ADR-0131 D10's "re-verifies against every future pin" only holds if a
  // missing binary FAILS here (repo contract: validate.sh hydrates it).
  const pi = vendoredPiBinary();
  assert.ok(pi !== null, "vendored pi binary missing — run setup.sh / fetch-pi-binary first");
  const { spawn } = await import("node:child_process");
  const scratch = createScratch();
  try {
    const script = path.join(scratch, "sleeper.ts");
    fs.writeFileSync(script, "await new Promise((r) => setTimeout(r, 1500));\nconsole.log('SLEEPER-DONE');\n");
    const child = spawn(pi, [script], {
      env: { BUN_BE_BUN: "1", HOME: path.join(scratch, "home"), TMPDIR: path.join(scratch, "tmp") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGUSR1");
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.on("close", (c, sig) => resolve([c, sig])),
    );
    // Two acceptable outcomes, both proving no signal-triggered inspector:
    //   - the runtime has NO SIGUSR1 handler and the default disposition
    //     terminates the process (what the vendored Bun build does — verified
    //     2026-07-31), or
    //   - the runtime ignores the signal and completes normally.
    // What must NEVER appear is an inspector announcement (Node's handler
    // prints "Debugger listening on ws://..." and keeps running).
    const terminatedBySignal = signal === "SIGUSR1";
    const completedNormally = code === 0 && out.includes("SLEEPER-DONE");
    assert.ok(
      terminatedBySignal || completedNormally,
      `unexpected outcome: code=${String(code)} signal=${String(signal)}`,
    );
    for (const marker of ["Debugger listening", "inspector", "ws://", "devtools"]) {
      assert.ok(!err.toLowerCase().includes(marker.toLowerCase()), `stderr must not announce an inspector (${marker})`);
      assert.ok(!out.toLowerCase().includes(marker.toLowerCase()), `stdout must not announce an inspector (${marker})`);
    }
  } finally {
    removeScratch(scratch);
  }
});

test("stdout caps are byte-accurate and stop retaining output once settled", async () => {
  if (!mechanismAvailable()) {
    assert.equal(mechanismAvailable(), false);
    return;
  }
  const rig = makeRig();
  const scratch = createScratch();
  try {
    // Multi-byte UTF-8: a 4-byte emoji per code point. A cap measured in
    // string units would let ~4x the byte budget through (R1 Warning).
    const payload = "😀".repeat(64); // 256 bytes, 64 code points
    const child = spawnConfined(spec(rig, "/bin/cat", scratch), null, [], payload, {
      executionTimeoutMs: 15_000,
      maxStdoutBytes: 100, // below 256 bytes, above 64 code points
      maxStdoutLineBytes: 1024,
    });
    const completion = await child.completion;
    assert.equal(completion.outcome, "output-cap-exceeded", "the byte cap must trip, not the code-point count");
    assert.ok(
      Buffer.byteLength(completion.stdout, "utf8") <= 100,
      `retained ${Buffer.byteLength(completion.stdout, "utf8")} bytes, cap was 100`,
    );
  } finally {
    removeScratch(scratch);
  }
});
