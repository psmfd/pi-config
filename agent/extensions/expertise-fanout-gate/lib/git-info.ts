/**
 * expertise-fanout-gate — repo-state probe for the canonical blob (ADR-0095).
 *
 * The fanout blob anchors repo origin + HEAD; both come from bounded `git`
 * subprocess calls against the session cwd. Executor is injectable (same
 * pattern as gh-identity-guard) so tests never spawn a real git.
 *
 * Fail-soft: any probe failure (git missing, not a repo, timeout) yields
 * `null` — the caller skips injection for this fanout (fail-open posture,
 * `agent/rules/expertise-canonical-fanout.md` § Exemptions).
 */

import { spawn } from "node:child_process";

import { isValidGitSha } from "../../expertise-indexer/canonicalize.ts";

export interface GitInfo {
	/** `remote.origin.url` as configured; empty string when absent. */
	readonly origin: string;
	/** HEAD commit sha (40- or 64-hex). */
	readonly headSha: string;
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
}

export type GitExecutor = (args: readonly string[], cwd: string) => Promise<ExecResult>;

const GIT_TIMEOUT_MS = 3000;

export const defaultGitExecutor: GitExecutor = (args, cwd) =>
	new Promise((resolve) => {
		let settled = false;
		const done = (exitCode: number, stdout: string) => {
			if (settled) return;
			settled = true;
			resolve({ exitCode, stdout });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			done(1, "");
			return;
		}
		let stdout = "";
		child.stdout?.on("data", (d) => {
			stdout += String(d);
		});
		child.on("error", () => done(1, ""));
		child.on("close", (code) => done(code ?? 1, stdout));
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			done(1, "");
		}, GIT_TIMEOUT_MS);
		timer.unref?.();
	});

/** Probe origin URL + HEAD sha; `null` when either is unavailable. */
export async function probeGitInfo(
	cwd: string,
	exec: GitExecutor = defaultGitExecutor,
): Promise<GitInfo | null> {
	const head = await exec(["rev-parse", "HEAD"], cwd);
	if (head.exitCode !== 0) return null;
	const headSha = head.stdout.trim();
	if (!isValidGitSha(headSha)) return null;

	// A missing origin is legal (fresh local repo) — the blob field is then "".
	const origin = await exec(["config", "--get", "remote.origin.url"], cwd);
	return {
		origin: origin.exitCode === 0 ? origin.stdout.trim() : "",
		headSha,
	};
}
