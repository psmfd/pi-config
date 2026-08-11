/**
 * dispatch-runner.ts — THE spawn boundary of the package-agent broker
 * (#930, ADR-0131 Decision 6).
 *
 * This is the ONLY module in the broker permitted to create OS processes.
 * The static no-spawn scan in `test/discovery.test.ts` allowlists exactly
 * this file for `child_process` and keeps the blanket ban for every other
 * `lib/` file and for `index.ts`. Everything here is MECHANISM: it spawns
 * what `lib/dispatch.ts` (pure orchestration) tells it to, through the
 * ADR-0130 sandbox builders, and reports what happened. It makes no
 * authorization decision and reads no grant.
 *
 * Non-negotiable properties:
 *
 *   - CANARY THROUGH THE IDENTICAL WRAPPER (ADR-0130/0131): the probe runs
 *     the same profile, binds, and env shape as the real spawn. The probe
 *     process is the child binary itself acting as plain bun (`BUN_BE_BUN=1`,
 *     verified live against the vendored binary on 2026-07-31), executing a
 *     broker-authored script materialized into the canary scratch. The real
 *     child's environment NEVER contains `BUN_BE_BUN` — `spawnConfined`
 *     refuses it outright.
 *   - SECRET-IN-ARGV IS CLOSED: on Linux the bwrap argument payload
 *     (carrying `--setenv` values, credential included) is delivered through
 *     an in-memory pipe on fd 3 (`bwrap --args 3 --`); it never touches disk
 *     and never appears in any argv. On macOS the env is passed as the exact
 *     spawn environment (there is no argv equivalent and no /proc).
 *   - SYNC-PID DISCIPLINE (ADR-0131 Decision 9): `spawn()` returns a handle
 *     synchronously; the PID is captured before anything is awaited, so a
 *     timeout can never leave an untracked process. Termination is
 *     best-effort SIGTERM-then-SIGKILL and is never an authorization
 *     guarantee (ADR-0129).
 *   - SCRATCH LIFECYCLE: per-attempt, high-entropy, 0700, under a
 *     broker-owned 0700 parent; the canary and the real child never share a
 *     scratch; removal is the dispatcher's duty and is attempted on every
 *     exit path.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildBwrapArgsFdPayload,
  buildCanaryPlan,
  buildChildEnv,
  buildDarwinProfile,
  validateSandboxSpec,
  type CanaryPlan,
  type ChildCredential,
  type SandboxSpec,
} from "./child-sandbox.ts";

export class DispatchRunnerError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "mechanism-unavailable"
      | "canary-anomaly"
      | "scratch-unavailable"
      | "spawn-failed"
      | "environment-refused",
  ) {
    super(message);
    this.name = "DispatchRunnerError";
  }
}

/** Wall-clock budget for the whole canary run (probe process included). */
export const CANARY_TIMEOUT_MS = 30_000;

/** Grace between SIGTERM and SIGKILL on best-effort termination. */
const TERMINATE_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// Scratch lifecycle.
// ---------------------------------------------------------------------------

/** Broker-owned scratch parent (0700). Never inside the agent dir. */
export function scratchParentDir(): string {
  return path.join(os.tmpdir(), "pi-package-agent-dispatch");
}

/**
 * Create a fresh per-attempt scratch: high-entropy leaf under a broker-owned
 * 0700 parent, itself created 0700 with the `wx`-style O_EXCL semantics of
 * mkdir (an existing path fails — never reused).
 */
export function createScratch(): string {
  const parent = scratchParentDir();
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    // mkdirSync(recursive) does not chmod an existing dir; re-assert.
    fs.chmodSync(parent, 0o700);
  } catch {
    throw new DispatchRunnerError("scratch parent could not be created", "scratch-unavailable");
  }
  const leaf = path.join(parent, randomBytes(16).toString("hex"));
  try {
    fs.mkdirSync(leaf, { mode: 0o700 });
    // The child env points HOME/TMPDIR/PI_CODING_AGENT_DIR into these.
    fs.mkdirSync(path.join(leaf, "home"), { mode: 0o700 });
    fs.mkdirSync(path.join(leaf, "tmp"), { mode: 0o700 });
    fs.mkdirSync(path.join(leaf, "agent"), { mode: 0o700 });
  } catch {
    throw new DispatchRunnerError("scratch could not be created", "scratch-unavailable");
  }
  // CANONICAL path, always: Seatbelt matches canonical vnode paths, and
  // os.tmpdir() is a symlinked tree on macOS (/var -> /private/var). A
  // non-canonical scratch would make every scratch rule silently miss.
  return fs.realpathSync(leaf);
}

/** Best-effort scratch removal; failure is reported, never thrown. */
export function removeScratch(scratchDir: string): boolean {
  let parent: string;
  try {
    // Compare in canonical space: createScratch returns canonical paths.
    parent = fs.realpathSync(scratchParentDir());
  } catch {
    return false;
  }
  const rel = path.relative(parent, scratchDir);
  // Refuse to remove anything that is not a direct child of the broker-owned
  // parent — a bug here must not become an arbitrary recursive delete.
  if (rel === "" || rel.includes(path.sep) || rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wrapper argv assembly (shared by canary and real spawn — "identical
// wrapper" is enforced by construction: both call this one function).
// ---------------------------------------------------------------------------

interface WrapperInvocation {
  /** argv[0] and the rest, ready for spawn(). */
  command: string;
  args: string[];
  /** Env for the spawn call itself. */
  spawnEnv: Record<string, string>;
  /** NUL payload to write on fd 3, or null (darwin). */
  fdPayload: string | null;
  /**
   * Working directory for the spawn. bwrap chdirs itself (`--chdir`);
   * sandbox-exec inherits the caller's cwd, and a cwd outside the profile's
   * read set makes the child abort at startup — so it is pinned to the
   * package root on both platforms.
   */
  cwd: string;
}

function buildWrapperInvocation(
  spec: SandboxSpec,
  childEnv: Record<string, string>,
  childArgv: readonly string[],
): WrapperInvocation {
  validateSandboxSpec(spec);
  if (spec.platform === "linux") {
    const payload = buildBwrapArgsFdPayload(spec, childEnv);
    return {
      command: "bwrap",
      // The ONLY visible bwrap arguments: the fd number and the child argv.
      // Every --setenv value (credential included) rides the fd payload.
      args: ["--args", "3", "--", spec.childBinary, ...childArgv],
      // bwrap --clearenv rebuilds the child env from the payload; the wrapper
      // process env is irrelevant but kept empty for hygiene.
      spawnEnv: {},
      fdPayload: payload,
      cwd: spec.packageRoot,
    };
  }
  // darwin: sandbox-exec applies the Seatbelt profile; the environment is
  // scoped by passing EXACTLY the allowlist map as the spawn env (ADR-0130).
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", buildDarwinProfile(spec), spec.childBinary, ...childArgv],
    spawnEnv: childEnv,
    fdPayload: null,
    cwd: spec.packageRoot,
  };
}

/** Empirical mechanism-availability probe (never version/tool sniffing). */
export function mechanismAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "darwin") {
    const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      timeout: 10_000,
    });
    return probe.error === undefined && probe.status === 0;
  }
  if (platform === "linux") {
    const probe = spawnSync("bwrap", ["--dev-bind", "/", "/", "--", "/bin/true"], { timeout: 10_000 });
    return probe.error === undefined && probe.status === 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canary execution.
// ---------------------------------------------------------------------------

/**
 * The broker-authored probe source. Runs INSIDE the sandbox as plain bun.
 * Reads its plan from argv[2] (a JSON file inside the canary scratch),
 * attempts every leg, and prints one JSON line. Its output is CANARY
 * EVIDENCE ONLY — a lying probe can only refuse dispatch or leave the
 * kernel-enforced sandbox exactly as strong as it is; it can never widen
 * anything (the broker treats any deviation from the expected shape as an
 * anomaly and refuses).
 */
const PROBE_SOURCE = `
const plan = JSON.parse(await Bun.file(process.argv[2]).text());
const out = { failedReads: [], succeededReads: [], failedWrites: [], succeededWrites: [], tls: null };
for (const p of plan.mustFailReads) {
  try { await Bun.file(p).text(); out.failedReads.push({ p, unexpected: true }); }
  catch { out.failedReads.push({ p, unexpected: false }); }
}
for (const p of plan.mustSucceedReads) {
  try { await Bun.file(p).text(); out.succeededReads.push({ p, ok: true }); }
  catch { out.succeededReads.push({ p, ok: false }); }
}
for (const p of plan.mustFailWrites) {
  try { await Bun.write(p, "x"); out.failedWrites.push({ p, unexpected: true }); }
  catch { out.failedWrites.push({ p, unexpected: false }); }
}
for (const p of plan.mustSucceedWrites) {
  try { await Bun.write(p, "x"); out.succeededWrites.push({ p, ok: true }); }
  catch { out.succeededWrites.push({ p, ok: false }); }
}
if (plan.mustReachTcp !== null) {
  const [hostname, portText] = plan.mustReachTcp.split(":");
  out.tls = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, why: "timeout" }), 15000);
    Bun.connect({
      hostname,
      port: Number(portText),
      tls: true,
      socket: {
        open(s) { clearTimeout(timer); resolve({ ok: true }); s.end(); },
        data() {},
        error(_s, err) { clearTimeout(timer); resolve({ ok: false, why: String(err && err.code || "error") }); },
        connectError(_s, err) { clearTimeout(timer); resolve({ ok: false, why: String(err && err.code || "connect-error") }); },
      },
    }).catch((err) => { clearTimeout(timer); resolve({ ok: false, why: String(err && err.code || "reject") }); });
  });
}
console.log(JSON.stringify(out));
`;

export interface CanaryResult {
  ok: boolean;
  /** Bounded, safe-to-display anomaly labels (never raw probe output). */
  anomalies: string[];
}

interface ProbeReport {
  failedReads: Array<{ p: string; unexpected: boolean }>;
  succeededReads: Array<{ p: string; ok: boolean }>;
  failedWrites: Array<{ p: string; unexpected: boolean }>;
  succeededWrites: Array<{ p: string; ok: boolean }>;
  tls: { ok: boolean; why?: string } | null;
}

function planLegCounts(plan: CanaryPlan): {
  failedReads: number;
  succeededReads: number;
  failedWrites: number;
  succeededWrites: number;
} {
  return {
    failedReads: plan.mustFailReads.length,
    succeededReads: plan.mustSucceedReads.length,
    failedWrites: plan.mustFailWrites.length,
    succeededWrites: plan.mustSucceedWrites.length,
  };
}

/**
 * Run the full ADR-0130 canary plan through the identical wrapper.
 *
 * `canarySpec` must use a THROWAWAY scratch (never the real child's): the
 * plan's must-succeed write leg writes into it, and canary artifacts must not
 * leak into the tree the real child sees. Async because the Linux fd-3
 * payload rides a real pipe.
 */
export function runCanaryAsync(
  canarySpec: SandboxSpec,
  probes: { inScopeFile: string; outOfScopeFile: string; providerHostPort?: string | null },
): Promise<CanaryResult> {
  if (!mechanismAvailable(canarySpec.platform === "darwin" ? "darwin" : "linux")) {
    return Promise.resolve({ ok: false, anomalies: ["mechanism-unavailable"] });
  }
  const plan = buildCanaryPlan(canarySpec, probes);
  const probePath = path.join(canarySpec.scratchDir, "canary-probe.ts");
  const planPath = path.join(canarySpec.scratchDir, "canary-plan.json");
  try {
    fs.writeFileSync(probePath, PROBE_SOURCE, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
  } catch {
    return Promise.resolve({ ok: false, anomalies: ["canary-materialization-failed"] });
  }
  const childEnv = buildChildEnv(canarySpec, null);
  const env = { ...childEnv, BUN_BE_BUN: "1" };
  const invocation = buildWrapperInvocation(canarySpec, env, [probePath, planPath]);

  return new Promise<CanaryResult>((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.spawnEnv,
      cwd: invocation.cwd,
      stdio: invocation.fdPayload !== null ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (r: CanaryResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      terminate(child.pid ?? null, () => undefined);
      settle({ ok: false, anomalies: ["canary-timeout"] });
    }, CANARY_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      settle({ ok: false, anomalies: ["canary-spawn-error"] });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 1024 * 1024) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
    });
    if (invocation.fdPayload !== null) {
      const fd3 = child.stdio[3] as NodeJS.WritableStream | null;
      fd3?.write(invocation.fdPayload);
      fd3?.end();
    }
    child.on("close", (code) => {
      clearTimeout(timer);
      settle(interpretProbe(undefined, code, stdout, stderr, plan));
    });
  });
}

/** Bound + sanitize a stderr snippet for an anomaly label (diagnostics only). */
function safeSnippet(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out += c >= 0x20 && c <= 0x7e ? ch : " ";
    if (out.length >= 160) break;
  }
  return out.trim();
}

function interpretProbe(
  spawnError: Error | undefined,
  status: number | null,
  stdout: string,
  stderr: string,
  plan: CanaryPlan,
): CanaryResult {
  if (spawnError !== undefined) return { ok: false, anomalies: ["canary-spawn-error"] };
  if (status !== 0) {
    return { ok: false, anomalies: [`canary-exit-${String(status)}: ${safeSnippet(stderr)}`] };
  }
  let report: ProbeReport;
  try {
    const line = stdout.trim().split("\n").pop() ?? "";
    report = JSON.parse(line) as ProbeReport;
  } catch {
    return { ok: false, anomalies: ["canary-output-unparseable"] };
  }
  const anomalies: string[] = [];
  const counts = planLegCounts(plan);
  if (
    !Array.isArray(report.failedReads) ||
    report.failedReads.length !== counts.failedReads ||
    !Array.isArray(report.succeededReads) ||
    report.succeededReads.length !== counts.succeededReads ||
    !Array.isArray(report.failedWrites) ||
    report.failedWrites.length !== counts.failedWrites ||
    !Array.isArray(report.succeededWrites) ||
    report.succeededWrites.length !== counts.succeededWrites
  ) {
    return { ok: false, anomalies: ["canary-report-shape-mismatch"] };
  }
  report.failedReads.forEach((r, i) => {
    if (r.unexpected) anomalies.push(`must-fail-read-${i}-succeeded`);
  });
  report.succeededReads.forEach((r, i) => {
    if (!r.ok) anomalies.push(`must-succeed-read-${i}-failed`);
  });
  report.failedWrites.forEach((r, i) => {
    if (r.unexpected) anomalies.push(`must-fail-write-${i}-succeeded`);
  });
  report.succeededWrites.forEach((r, i) => {
    if (!r.ok) anomalies.push(`must-succeed-write-${i}-failed`);
  });
  if (plan.mustReachTcp !== null) {
    if (report.tls === null || report.tls.ok !== true) anomalies.push("tls-handshake-failed");
  }
  return { ok: anomalies.length === 0, anomalies };
}

// ---------------------------------------------------------------------------
// Credential minting.
// ---------------------------------------------------------------------------

/**
 * Mint the short-lived bearer for the child (`pi auth print-bearer-token`,
 * pi >= 0.83.0 — ADR-0130/0131 Decision 5). Runs the broker's own runner
 * binary with the broker's own environment (it needs the operator's
 * auth.json, which the CHILD never sees). The token is captured from stdout
 * into memory only: it never rides an argv, a file, an audit record, or an
 * error message. Returns null on any failure — the dispatcher refuses
 * (bearer-only; there is no API-key fallback branch).
 */
export function mintBearerToken(runnerPath: string): { envVar: string; value: string } | null {
  const result = spawnSync(runnerPath, ["auth", "print-bearer-token"], {
    timeout: 30_000,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const token = (result.stdout ?? "").trim();
  if (token.length === 0 || token.length > 8192 || /[\x00-\x1f]/.test(token)) return null;
  return { envVar: "ANTHROPIC_AUTH_TOKEN", value: token };
}

// ---------------------------------------------------------------------------
// Real child spawn.
// ---------------------------------------------------------------------------

export interface SpawnedChild {
  pid: number;
  /**
   * Resolves with the terminal outcome. `stdout` is capped; exceeding a cap
   * terminates the child (`outcome: "output-cap-exceeded"`).
   */
  completion: Promise<ChildCompletion>;
  /** Best-effort terminate (SIGTERM, then SIGKILL after a grace). */
  terminate(): void;
}

export interface ChildCompletion {
  outcome: "exit" | "execution-timeout" | "output-cap-exceeded" | "stream-error";
  exitCode: number | null;
  /** Capped, raw child stdout (JSON event lines). UNTRUSTED content. */
  stdout: string;
}

export interface SpawnLimits {
  executionTimeoutMs: number;
  maxStdoutBytes: number;
  maxStdoutLineBytes: number;
}

function terminate(pid: number | null, onDone: () => void): void {
  if (pid === null) {
    onDone();
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    onDone();
    return;
  }
  const killTimer = setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    onDone();
  }, TERMINATE_GRACE_MS);
  killTimer.unref?.();
}

/**
 * Spawn the real confined child. SYNCHRONOUS process creation: the returned
 * handle carries a live PID before anything is awaited. Throws (never spawns)
 * if the environment contains `BUN_BE_BUN` — the canary-only escape hatch
 * must be structurally impossible on the real path.
 *
 * `task` is written to the child's stdin and NEVER placed in argv
 * (ADR-0131 Decision 7: child argv is world-readable on default Linux).
 */
export function spawnConfined(
  spec: SandboxSpec,
  credential: ChildCredential | null,
  childArgv: readonly string[],
  task: string,
  limits: SpawnLimits,
): SpawnedChild {
  const childEnv = buildChildEnv(spec, credential);
  if ("BUN_BE_BUN" in childEnv) {
    throw new DispatchRunnerError("BUN_BE_BUN must never reach a real child", "environment-refused");
  }
  const invocation = buildWrapperInvocation(spec, childEnv, childArgv);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(invocation.command, invocation.args, {
      env: invocation.spawnEnv,
      cwd: invocation.cwd,
      stdio: invocation.fdPayload !== null ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new DispatchRunnerError(
      err instanceof Error ? err.message : "spawn failed",
      "spawn-failed",
    );
  }
  if (child.pid === undefined) {
    throw new DispatchRunnerError("spawn returned no pid", "spawn-failed");
  }
  const pid = child.pid;

  if (invocation.fdPayload !== null) {
    const fd3 = child.stdio[3] as NodeJS.WritableStream | null;
    fd3?.write(invocation.fdPayload);
    fd3?.end();
  }
  child.stdin?.write(task);
  child.stdin?.end();

  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let currentLineBytes = 0;
  let settled = false;
  let resolveCompletion: (c: ChildCompletion) => void = () => undefined;
  const completion = new Promise<ChildCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  const settle = (outcome: ChildCompletion["outcome"], exitCode: number | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(execTimer);
    resolveCompletion({ outcome, exitCode, stdout: Buffer.concat(stdoutChunks).toString("utf8") });
  };
  const execTimer = setTimeout(() => {
    terminate(pid, () => undefined);
    settle("execution-timeout", null);
  }, limits.executionTimeoutMs);
  execTimer.unref?.();

  child.on("error", () => {
    settle("stream-error", null);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    // Per-line and total caps measured in ACTUAL BYTES (not string units —
    // multi-byte UTF-8 must not stretch the bound), checked BEFORE the chunk
    // is retained, with nothing appended after settle: the child may keep
    // emitting during the SIGTERM grace window, and none of it may grow
    // broker memory (2026-07-31 security review). Exceeding a cap is a
    // terminal outcome, not a truncation.
    if (settled) return;
    if (stdoutBytes + chunk.length > limits.maxStdoutBytes) {
      terminate(pid, () => undefined);
      settle("output-cap-exceeded", null);
      return;
    }
    for (const byte of chunk) {
      currentLineBytes = byte === 0x0a ? 0 : currentLineBytes + 1;
      if (currentLineBytes > limits.maxStdoutLineBytes) {
        terminate(pid, () => undefined);
        settle("output-cap-exceeded", null);
        return;
      }
    }
    stdoutChunks.push(chunk);
    stdoutBytes += chunk.length;
  });
  child.on("close", (code) => {
    settle("exit", code);
  });

  return {
    pid,
    completion,
    terminate: () => terminate(pid, () => undefined),
  };
}
