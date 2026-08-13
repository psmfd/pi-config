import { spawn } from "node:child_process";

import { redactSecretsInText } from "./github-read-formatting.ts";
import type { GhRunResult } from "./github-read-types.ts";

const STDOUT_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
// GitHub login grammar is bounded to 39 characters before matching.
// eslint-disable-next-line security/detect-unsafe-regex -- fixed upper bound, no attacker-sized repetition
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.GH_HOST = "github.com";
  env.GH_PROMPT_DISABLED = "1";
  env.GH_PAGER = "cat";
  env.PAGER = "cat";
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  return env;
}

function authSource(env: NodeJS.ProcessEnv): GhRunResult["authSource"] {
  if (env.GH_TOKEN) return "GH_TOKEN";
  if (env.GITHUB_TOKEN) return "GITHUB_TOKEN";
  return "gh-config";
}

export function sanitizeDiagnostic(value: string): string {
  return redactSecretsInText(value.replace(ANSI_RE, ""))
    .trim()
    .split("\n")
    .slice(-5)
    .join(" | ");
}

export async function runGh(
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<GhRunResult> {
  if (args.length === 0 || args.some((arg) => arg.includes("\u0000"))) {
    throw new Error("github-read refused an invalid gh argument vector");
  }
  const env = childEnvironment(sourceEnv);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let abortError: Error | undefined;
    const controller = new AbortController();
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => {
      abortError = new Error("github-read command cancelled");
      controller.abort();
      finishReject(abortError);
    };
    const child = spawn("gh", [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
      signal: controller.signal,
    });
    const timer = setTimeout(() => {
      abortError = new Error(`github-read command timed out after ${timeoutMs}ms`);
      controller.abort();
      finishReject(abortError);
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buf.byteLength;
      if (stdoutBytes > STDOUT_LIMIT) {
        abortError = new Error(`github-read stdout exceeded ${STDOUT_LIMIT} bytes`);
        controller.abort();
        finishReject(abortError);
        return;
      }
      stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buf.byteLength;
      if (stderrBytes <= STDERR_LIMIT) stderr += buf.toString("utf8");
      if (stderrBytes > STDERR_LIMIT) {
        abortError = new Error(`github-read stderr exceeded ${STDERR_LIMIT} bytes`);
        controller.abort();
        finishReject(abortError);
      }
    });
    child.on("error", (error) => {
      if (controller.signal.aborted) {
        if (!settled) finishReject(abortError ?? new Error("github-read command aborted"));
        return;
      }
      finishReject(new Error(`github-read could not execute gh: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        stdoutBytes,
        stderrBytes,
        authSource: authSource(env),
      });
    });
  });
}

export async function probeGithubIdentity(
  signal?: AbortSignal,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ login: string; authSource: GhRunResult["authSource"] }> {
  const result = await runGh(["api", "--hostname", "github.com", "/user", "--jq", ".login"], signal, 10_000, sourceEnv);
  if (result.exitCode !== 0) {
    throw new Error(`github-read identity probe failed: ${sanitizeDiagnostic(result.stderr) || `gh exited ${result.exitCode}`}`);
  }
  const login = result.stdout.trim();
  if (!LOGIN_RE.test(login)) throw new Error("github-read identity probe returned an invalid login");
  return { login, authSource: result.authSource };
}
