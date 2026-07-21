/**
 * expertise-indexer — pure helpers for the expertise-audit runner (#601,
 * ADR-0095). Extracted from `audit-cli.ts` so the trust-boundary logic (arg
 * parsing, changed-set derivation, the telemetry anchor cross-check) is unit-
 * testable without spawning the CLI or a real `git` process (#817). `audit-cli.ts`
 * imports these and adds only the process wiring (env, I/O, exit codes).
 *
 * `git` is injectable so `changedEntries` can be driven from fixtures; the
 * default executor spawns the real `git` in the current checkout.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { isValidGitSha, type CanonicalFileEntry } from "./canonicalize.ts";
import { buildCanonicalQuery } from "./collector.ts";

export interface Args {
	baseSha: string;
	headSha: string;
	outDir: string;
	telemetryDir?: string;
}

/** Result of a single `git` invocation. */
export interface GitResult {
	ok: boolean;
	stdout: string;
}

/** Injectable `git` executor (tests supply a fixture; prod spawns real git). */
export type GitExec = (args: string[]) => GitResult;

export const defaultGit: GitExec = (args) => {
	const r = spawnSync("git", args, { encoding: "utf8" });
	return { ok: r.status === 0, stdout: r.stdout ?? "" };
};

/** Parse the CLI argv (pairs). Returns null on any malformed/partial input. */
export function parseArgs(argv: string[]): Args | null {
	const out: Partial<Args> = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (value === undefined) return null;
		if (key === "--base-sha") out.baseSha = value;
		else if (key === "--head-sha") out.headSha = value;
		else if (key === "--out-dir") out.outDir = value;
		else if (key === "--telemetry-dir") out.telemetryDir = value;
		else return null;
	}
	if (!out.baseSha || !out.headSha || !out.outDir) return null;
	return out as Args;
}

/** Changed-set file entries with blob shas, from the checkout's own git state. */
export function changedEntries(
	baseSha: string,
	headSha: string,
	exec: GitExec = defaultGit,
): CanonicalFileEntry[] | null {
	const diff = exec([
		"diff",
		"--name-only",
		"--diff-filter=ACMR",
		`${baseSha}..${headSha}`,
		"--",
		"agent/extensions/",
		"agent/agents/",
		"agent/skills/",
		"agent/rules/",
	]);
	if (!diff.ok) return null;
	const paths = diff.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	const entries: CanonicalFileEntry[] = [];
	for (const path of paths.sort()) {
		const rev = exec(["rev-parse", `${headSha}:${path}`]);
		if (!rev.ok) continue; // deleted-at-head shapes are excluded by the filter; be tolerant
		const blobSha = rev.stdout.trim();
		if (!isValidGitSha(blobSha)) continue;
		entries.push({ path, blobSha });
	}
	return entries;
}

/** Deterministic audit query from the changed set (mirrors fanout-derive's style). */
export function auditQuery(entries: readonly CanonicalFileEntry[]): string {
	const areas = [
		...new Set(
			entries
				.map((e) => e.path.split("/").slice(0, 2).join("/"))
				.filter((s) => s.length > 0),
		),
	].sort();
	const names = [...new Set(entries.map((e) => basename(e.path)))].sort();
	return buildCanonicalQuery({
		domain: areas.join(" "),
		taskType: "audit",
		goalOrSymptom: names.join(" "),
	});
}

/** Telemetry-log consistency audit (the first-party artifact from ADR-0095). */
export function auditTelemetry(dir: string): { ok: boolean; lines: number; problems: string[] } {
	const problems: string[] = [];
	let lines = 0;
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
	} catch {
		return { ok: true, lines: 0, problems: [] }; // absent dir = nothing to audit
	}
	const SHA64 = /^[0-9a-f]{64}$/;
	const EVENTS = new Set([
		"inject",
		"skip",
		"error",
		"approve",
		"reject",
		"queue",
		"create-allow",
		"create-block",
	]);
	for (const f of files) {
		const injectShas = new Set<string>();
		const content = readFileSync(join(dir, f), "utf8");
		for (const [n, raw] of content.split("\n").entries()) {
			if (raw.trim().length === 0) continue;
			lines += 1;
			let row: Record<string, unknown>;
			try {
				row = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				problems.push(`${f}:${n + 1}: not valid JSON`);
				continue;
			}
			if (typeof row.event !== "string" || !EVENTS.has(row.event)) {
				problems.push(`${f}:${n + 1}: unknown event '${String(row.event)}'`);
				continue;
			}
			if (
				row.canonicalBlobSha !== undefined &&
				(typeof row.canonicalBlobSha !== "string" || !SHA64.test(row.canonicalBlobSha))
			) {
				problems.push(`${f}:${n + 1}: malformed canonicalBlobSha`);
			}
			if (row.event === "inject" && typeof row.canonicalBlobSha === "string") {
				injectShas.add(row.canonicalBlobSha);
			}
			// ADR-0095 cross-check: every surfaced candidate must anchor to a
			// canonical block THIS gate injected in the same telemetry file.
			if (
				(row.event === "approve" || row.event === "reject" || row.event === "queue") &&
				row.candidateBlobSha !== undefined
			) {
				const sha = typeof row.candidateBlobSha === "string" ? row.candidateBlobSha : "";
				if (!SHA64.test(sha)) {
					problems.push(`${f}:${n + 1}: malformed candidateBlobSha`);
				} else if (!injectShas.has(sha)) {
					problems.push(
						`${f}:${n + 1}: candidateBlobSha has no matching earlier inject row (forged or displaced anchor)`,
					);
				}
			}
		}
	}
	return { ok: problems.length === 0, lines, problems };
}
