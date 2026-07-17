/**
 * expertise-indexer — CI/pre-push expertise-audit runner (#601, ADR-0095).
 *
 * NOT an extension entry point (deliberately not named `index.ts` — pi
 * auto-discovers every extension directory's `index.ts`); a CLI invoked by
 * `scripts/expertise-audit.sh` via the repo's pinned tsx pattern.
 *
 * What a green result PROVES (state this honestly — see the #601 re-scope):
 * "the changed-set blob was computed from THIS checkout's git state, one
 * read-only search ran against the configured expertise API, the artifacts are
 * well-formed, and any supplied telemetry log is internally consistent."
 * It does NOT prove a real fanout or a real human approval occurred —
 * `canonical_blob_sha` is computable by anyone with repo read access.
 * Inputs for recomputation come from `git` in the working checkout, never
 * from values embedded in artifacts.
 *
 * Exit codes (consumed by the wrapper):
 *   0 — audit ran green (possibly with WARN lines, e.g. a 429)
 *   1 — audit failure (401/403, telemetry inconsistency, artifact write)
 *   2 — environment/usage failure
 *   3 — skip (API unreachable / no key) — wrapper prints SKIP, exits 0
 *
 * Secret handling: the local API key or upstream bearer token is read from
 * process env plus fixed operator-owned files and used only inside the shared
 * HTTP stack — it never appears in argv, output
 * lines, or artifacts.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
	buildClientConfig,
	loadEnvLocal,
	loadUpstreamSecrets,
	type ClientConfig,
} from "../shared/expertise-api-config.ts";
import { checkReady } from "../shared/expertise-api-health.ts";
import { searchExpertise } from "../shared/expertise-api-search.ts";
import { scanRawString } from "../shared/secret-scan.ts";
import { computeCanonicalBlob, isValidGitSha, type CanonicalFileEntry } from "./canonicalize.ts";
import { buildCanonicalQuery } from "./collector.ts";

interface Args {
	baseSha: string;
	headSha: string;
	outDir: string;
	telemetryDir?: string;
}

function parseArgs(argv: string[]): Args | null {
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

function git(args: string[]): { ok: boolean; stdout: string } {
	const r = spawnSync("git", args, { encoding: "utf8" });
	return { ok: r.status === 0, stdout: r.stdout ?? "" };
}

/** Changed-set file entries with blob shas, from the checkout's own git state. */
function changedEntries(baseSha: string, headSha: string): CanonicalFileEntry[] | null {
	const diff = git([
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
		const rev = git(["rev-parse", `${headSha}:${path}`]);
		if (!rev.ok) continue; // deleted-at-head shapes are excluded by the filter; be tolerant
		const blobSha = rev.stdout.trim();
		if (!isValidGitSha(blobSha)) continue;
		entries.push({ path, blobSha });
	}
	return entries;
}

/** Deterministic audit query from the changed set (mirrors fanout-derive's style). */
function auditQuery(entries: readonly CanonicalFileEntry[]): string {
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
function auditTelemetry(dir: string): { ok: boolean; lines: number; problems: string[] } {
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

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args === null) {
		process.stderr.write(
			"usage: audit-cli --base-sha <sha> --head-sha <sha> --out-dir <dir> [--telemetry-dir <dir>]\n",
		);
		return 2;
	}
	if (!isValidGitSha(args.baseSha) || !isValidGitSha(args.headSha)) {
		process.stderr.write("audit-cli: base/head sha must be full git shas\n");
		return 2;
	}

	// --- 1. Changed-set blob from the checkout's own git state -------------
	const origin = git(["config", "--get", "remote.origin.url"]);
	const entries = changedEntries(args.baseSha, args.headSha);
	if (entries === null) {
		process.stderr.write("audit-cli: git diff failed (is the base sha fetched?)\n");
		return 2;
	}
	const blob = computeCanonicalBlob({
		repoOrigin: origin.ok ? origin.stdout.trim() : "",
		headSha: args.headSha,
		files: entries,
		taskString: `expertise-audit ${args.baseSha}..${args.headSha}`,
		agentFrontmatter: {},
	});
	process.stdout.write(`canonical_blob_sha=${blob.sha}\n`);

	// --- 2. Telemetry consistency (when a dir was supplied) ----------------
	if (args.telemetryDir !== undefined) {
		const t = auditTelemetry(args.telemetryDir);
		for (const p of t.problems) process.stderr.write(`TELEMETRY ${p}\n`);
		process.stdout.write(`telemetry_lines=${t.lines} telemetry_problems=${t.problems.length}\n`);
		if (!t.ok) return 1;
	}

	// --- 3. One read-only search ------------------------------------------
	const envLocalPath = fileURLToPath(new URL("../expertise-client/.env.local", import.meta.url));
	const fileEnv = loadEnvLocal(envLocalPath);
	const cfg = buildClientConfig(
		process.env,
		fileEnv,
		loadUpstreamSecrets(process.env),
	);
	if (!cfg.ok) {
		process.stdout.write(`SKIP audit: ${cfg.reason.split("\n")[0]}\n`);
		return 3;
	}
	const config: ClientConfig = cfg.config;
	const ready = await checkReady(config);
	if (!ready.ready) {
		// Unreachable = skip; an AUTH failure must fail loud, not skip.
		if (/401|403/.test(ready.reason)) {
			process.stderr.write(`audit-cli: auth failure on /health/ready: ${ready.reason}\n`);
			return 1;
		}
		process.stdout.write(`SKIP audit: API not ready (${ready.reason.split("\n")[0]})\n`);
		return 3;
	}

	const query = auditQuery(entries);
	if (query === "") {
		process.stdout.write("SKIP audit: empty canonical query (no governed changes)\n");
		return 3;
	}
	const search = await searchExpertise(config, { query, limit: 5 });
	if (!search.ok) {
		if (search.rateLimited) {
			process.stdout.write(`WARN audit: search rate-limited (429); audit result advisory\n`);
		} else if (/HTTP 401|HTTP 403/.test(search.reason)) {
			process.stderr.write(`audit-cli: auth failure on search: ${search.reason}\n`);
			return 1;
		} else {
			process.stdout.write(`WARN audit: search failed (${search.reason.split("\n")[0]})\n`);
		}
	}

	// --- 4. Artifacts -------------------------------------------------------
	try {
		writeFileSync(join(args.outDir, `expertise-blob-${blob.sha}.json.gz`), gzipSync(blob.blob));
		writeFileSync(
			join(args.outDir, `expertise-audit-${blob.sha}.json`),
			JSON.stringify(
				{
					canonical_blob_sha: blob.sha,
					baseSha: args.baseSha,
					headSha: args.headSha,
					query,
					fileCount: entries.length,
					// Defense-in-depth: the corpus is secret-scanned at ingestion and
					// create time, but this artifact is a 14-day CI upload — redact
					// rather than trust upstream scans (post-arc review finding).
					search: search.ok
						? {
								ok: true,
								status: search.status,
								truncated: search.truncated,
								body:
									scanRawString(search.text).length > 0
										? `[redacted:${scanRawString(search.text).join(",")}]`
										: search.text,
							}
						: { ok: false, reason: search.reason },
					proves:
						"artifact well-formed + internally consistent against this checkout; NOT proof a fanout or human approval occurred",
				},
				null,
				2,
			),
		);
	} catch (err) {
		process.stderr.write(`audit-cli: artifact write failed: ${String(err)}\n`);
		return 1;
	}
	process.stdout.write(`OK audit: query="${query}" files=${entries.length}\n`);
	return 0;
}

process.exitCode = await main();
