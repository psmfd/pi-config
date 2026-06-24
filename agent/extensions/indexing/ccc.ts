/**
 * indexing/ccc.ts — the `ccc` subprocess boundary.
 *
 * `resolveBinary` and `assertCliInvocation` are pure and unit-tested; the
 * `defaultRunner` (request/response, for search) and `defaultLauncher`
 * (detached fire-and-forget, for the background re-index) are the real
 * spawn-backed implementations injected at the index.ts boundary.
 *
 * No-MCP guard (ADR-0033 / agent/rules/no-mcp-servers.md): cocoindex-code ships TWO
 * entry points — `ccc` (CLI) and `cocoindex-code` (an MCP stdio server) — and a
 * `ccc mcp` subcommand. assertCliInvocation fails closed on either, so the only
 * thing this extension can ever launch is the CLI search/index/status path.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { CommandResult, DetachedProcess, RunOptions } from "./types.ts";

/** Resolve the `ccc` binary: CCC_BIN_PATH, else PIPX_BIN_DIR/ccc, else ~/.local/bin/ccc. */
export function resolveBinary(env: NodeJS.ProcessEnv): string {
  const explicit = env.CCC_BIN_PATH?.trim();
  if (explicit) return explicit;
  const pipxBin = env.PIPX_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
  return join(pipxBin, "ccc");
}

/**
 * Fail closed unless this is a CLI invocation of `ccc`. Rejects the
 * `cocoindex-code` MCP entry point and the `ccc mcp` subcommand.
 */
export function assertCliInvocation(binary: string, args: ReadonlyArray<string>): void {
  if (basename(binary) !== "ccc") {
    throw new Error(
      `indexing: refusing to spawn '${basename(binary)}' — only the 'ccc' CLI is permitted (no-MCP policy)`,
    );
  }
  if (args[0] === "mcp") {
    throw new Error("indexing: refusing 'ccc mcp' — MCP server mode is prohibited (no-MCP policy)");
  }
}

/** Environment that suppresses Rich ANSI/spinners and CocoIndex telemetry. */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    TERM: "dumb",
    NO_COLOR: "1",
    COCOINDEX_DISABLE_USAGE_TRACKING: "1",
  };
}

/** Real search runner: spawn `ccc`, capture output, honor timeout + abort signal. */
export const defaultRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions,
): Promise<CommandResult> => {
  assertCliInvocation(command, args);
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: childEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout: bufStr(out), stderr: bufStr(err), spawnError: "ccc search timed out" });
    }, options.timeoutMs);

    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish({ code: null, stdout: bufStr(out), stderr: bufStr(err), spawnError: "ccc search aborted" });
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      const hint =
        e.code === "ENOENT"
          ? `ccc not found at '${command}' — install with: pipx install 'cocoindex-code[full]' (or set CCC_BIN_PATH)`
          : e.message;
      finish({ code: null, stdout: bufStr(out), stderr: bufStr(err), spawnError: hint });
    });
    child.on("close", (code) => finish({ code, stdout: bufStr(out), stderr: bufStr(err) }));
  });
};

/** Real detached launcher for the background re-index (fire-and-forget). */
export const defaultLauncher = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): DetachedProcess => {
  assertCliInvocation(command, args);
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: childEnv(options.env),
    stdio: "ignore",
    detached: true,
  });
  return {
    pid: child.pid ?? null,
    onExit(callback: () => void): void {
      child.on("close", callback);
      child.on("error", callback);
    },
  };
};

function bufStr(parts: Buffer[]): string {
  return Buffer.concat(parts).toString("utf8");
}
