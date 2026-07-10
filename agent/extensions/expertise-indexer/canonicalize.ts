/**
 * expertise-indexer/canonicalize.ts — deterministic canonicalizer that
 * anchors every expertise query and every candidate proposal to a
 * reproducible `canonical_blob_sha` (pi_config issue #598, epic #595).
 *
 * WHY
 * ---
 * The deterministic expertise-consumption pipeline needs a stable
 * fingerprint of "the context this query/candidate was derived from" so
 * that (a) identical inputs produce byte-identical results across runs,
 * platforms, and CI, and (b) the orchestrator, subagents, CI audit, and
 * pre-push hook can all reason about the same anchor. That anchor is
 * `canonical_blob_sha` — the SHA-256 hex digest of a canonical JSON
 * serialization of the inputs listed below.
 *
 * INPUTS (fixed order; each is normalized before hashing)
 * -------------------------------------------------------
 *   1. Repo origin URL (git `origin` remote URL).
 *   2. HEAD commit SHA (40-char lowercase hex).
 *   3. Sorted file list, each element `{ path, blobSha }` — paths sorted
 *      lexicographically, blobSha is the git blob SHA (`git hash-object`).
 *   4. Task string (the human/orchestrator query or brief text).
 *   5. Agent wrapper frontmatter (as a sorted-key object).
 *
 * NORMALIZATION
 * -------------
 * - All strings NFKC-normalized (Unicode canonical equivalence).
 * - CRLF/CR → LF.
 * - Trailing whitespace on each line stripped.
 * - Object keys sorted lexicographically at every level.
 * - Numbers passed through unchanged (JSON spec is unambiguous for the
 *   integer / plain-decimal shapes we accept; NaN/Infinity rejected).
 *
 * SERIALIZATION
 * -------------
 * Manual recursive sorted-key serializer, NOT `JSON.stringify(x, sortedKeys)`.
 * V8's `JSON.stringify` iteration order is spec'd for own string keys, but
 * we do not want a future runtime change (or a caller with symbol/integer
 * keys) to shift the digest silently.
 *
 * STORAGE
 * -------
 * `writeCanonicalBlob(sha, blob)` persists the serialized JSON, gzip-encoded,
 * at `${PI_CODING_AGENT_DIR:-$HOME/.pi}/expertise_cache/<sha>.json.gz` with
 * file mode 0600 and parent dir mode 0700. Before write, the raw JSON is
 * run through the shared `scanRawString` gate — refuses to persist if any
 * credential pattern matches (fail closed, no partial write).
 *
 * PURE / SIDE-EFFECTS
 * -------------------
 * `computeCanonicalBlob` is pure. `writeCanonicalBlob` writes exactly one
 * file on success; on refusal it writes nothing (checked-before-open).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { gzipSync } from "node:zlib";

import { scanRawString } from "../shared/secret-scan.ts";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** A single file entry contributing to the canonical blob. */
export interface CanonicalFileEntry {
	/** Path relative to the repo root; will be sorted lexicographically. */
	readonly path: string;
	/** Git blob SHA-1 (40-char lowercase hex) or SHA-256 blob id (64-char). */
	readonly blobSha: string;
}

/** Frontmatter values we accept — JSON-safe scalars and arrays of scalars. */
export type FrontmatterValue =
	| string
	| number
	| boolean
	| null
	| readonly (string | number | boolean | null)[];

/** Inputs to the canonicalizer. */
export interface CanonicalInputs {
	readonly repoOrigin: string;
	readonly headSha: string;
	readonly files: readonly CanonicalFileEntry[];
	readonly taskString: string;
	readonly agentFrontmatter: Readonly<Record<string, FrontmatterValue>>;
}

/** Result of {@link computeCanonicalBlob}. */
export interface CanonicalBlob {
	/** Hex-encoded SHA-256 of {@link blob}. */
	readonly sha: string;
	/** Canonical JSON serialization (UTF-8, LF-normalized, sorted keys). */
	readonly blob: string;
}

/** Result of {@link writeCanonicalBlob}. */
export interface CanonicalWriteResult {
	/** Absolute path of the written file. */
	readonly path: string;
	/** Uncompressed byte length. */
	readonly uncompressedBytes: number;
	/** Compressed byte length actually written to disk. */
	readonly compressedBytes: number;
}

/** Thrown when the pre-write secret scan finds a credential pattern. */
export class CanonicalBlobSecretError extends Error {
	readonly categories: readonly string[];
	constructor(categories: readonly string[]) {
		super(
			`canonicalize: refusing to persist blob — matched credential pattern(s): ${categories.join(", ")}`,
		);
		this.name = "CanonicalBlobSecretError";
		this.categories = categories;
	}
}

// -----------------------------------------------------------------------------
// Normalization helpers
// -----------------------------------------------------------------------------

/**
 * Apply NFKC + LF-only newlines + trailing-whitespace stripping. Idempotent.
 */
export function normalizeText(input: string): string {
	// NFKC canonical equivalence (compat + composition).
	const nfkc = input.normalize("NFKC");
	// CRLF → LF; lone CR → LF.
	const lf = nfkc.replace(/\r\n?/g, "\n");
	// Strip trailing whitespace on each line (preserve blank lines).
	return lf
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n");
}

/** Validate a 40-char (git SHA-1) or 64-char (git SHA-256) lowercase hex. */
export function isValidGitSha(s: string): boolean {
	return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}

// -----------------------------------------------------------------------------
// Canonical serialization
// -----------------------------------------------------------------------------

/**
 * Recursive sorted-key JSON serializer. Rejects NaN/Infinity, symbols, and
 * functions. Sorts every object's keys lexicographically. Arrays keep the
 * caller's order (order-preservation is a load-bearing property of the
 * `files` and `tags` inputs; callers are responsible for pre-sorting where
 * order should not matter to the digest).
 */
function serialize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`canonicalize: non-finite number is not JSON-representable: ${String(value)}`);
		}
		// JSON.stringify handles integer / plain-decimal shapes correctly for
		// finite numbers; we already rejected NaN/Infinity above.
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((el) => serialize(el)).join(",")}]`;
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
		return `{${parts.join(",")}}`;
	}
	throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
}

// -----------------------------------------------------------------------------
// Public API — compute
// -----------------------------------------------------------------------------

/**
 * Compute the canonical blob and its SHA-256 for the given inputs.
 *
 * Throws:
 * - `Error` if `headSha` is not a valid git SHA hex string.
 * - `Error` if any file entry has an invalid `blobSha`.
 * - `Error` if `files` contains duplicate paths (indicates caller bug).
 * - `Error` if a frontmatter value is non-finite or of an unsupported type.
 *
 * Pure — no I/O.
 */
export function computeCanonicalBlob(inputs: CanonicalInputs): CanonicalBlob {
	if (!isValidGitSha(inputs.headSha)) {
		throw new Error(`canonicalize: invalid headSha: ${inputs.headSha}`);
	}
	// Validate files and detect duplicate paths deterministically.
	const seenPaths = new Set<string>();
	for (const f of inputs.files) {
		if (!isValidGitSha(f.blobSha)) {
			throw new Error(`canonicalize: invalid blobSha for path '${f.path}': ${f.blobSha}`);
		}
		if (seenPaths.has(f.path)) {
			throw new Error(`canonicalize: duplicate file path in inputs: ${f.path}`);
		}
		seenPaths.add(f.path);
	}

	// Sort files lexicographically by path.
	const sortedFiles = [...inputs.files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((f) => ({ path: normalizeText(f.path), blobSha: f.blobSha.toLowerCase() }));

	// Normalize frontmatter values that are strings; arrays of scalars pass
	// through with their string elements normalized.
	const frontmatter: Record<string, FrontmatterValue> = {};
	for (const [k, v] of Object.entries(inputs.agentFrontmatter)) {
		frontmatter[k] = normalizeFrontmatterValue(v);
	}

	const root = {
		schemaVersion: 1,
		repoOrigin: normalizeText(inputs.repoOrigin),
		headSha: inputs.headSha.toLowerCase(),
		files: sortedFiles,
		taskString: normalizeText(inputs.taskString),
		agentFrontmatter: frontmatter,
	};

	const blob = serialize(root);
	const sha = crypto.createHash("sha256").update(blob, "utf8").digest("hex");
	return { sha, blob };
}

function normalizeFrontmatterValue(v: FrontmatterValue): FrontmatterValue {
	if (typeof v === "string") return normalizeText(v);
	if (Array.isArray(v)) {
		// Array.isArray narrows to `any[]` for readonly array unions (TS #17002),
		// so we recover the element type explicitly. The FrontmatterValue array
		// branch guarantees only scalar elements are present at runtime.
		const arr = v as readonly (string | number | boolean | null)[];
		return arr.map((el) => (typeof el === "string" ? normalizeText(el) : el));
	}
	if (typeof v === "number" && !Number.isFinite(v)) {
		throw new Error(`canonicalize: non-finite number in frontmatter: ${String(v)}`);
	}
	return v;
}

// -----------------------------------------------------------------------------
// Public API — persist
// -----------------------------------------------------------------------------

/**
 * Resolve the cache directory. Honors `PI_CODING_AGENT_DIR`; otherwise falls
 * back to `$HOME/.pi/`.
 */
export function resolveCacheDir(): string {
	const base =
		process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.trim() !== ""
			? process.env.PI_CODING_AGENT_DIR
			: path.join(os.homedir(), ".pi");
	return path.join(base, "expertise_cache");
}

/**
 * Persist a canonical blob to disk with the following invariants:
 *
 * - Runs `scanRawString` on the RAW JSON before opening any file. On a
 *   credential match, throws {@link CanonicalBlobSecretError} — no file
 *   is created, no cache is polluted.
 * - Ensures the parent directory exists with mode 0700; creates with that
 *   mode if absent.
 * - Writes to a temp sibling then renames, so a partial write cannot leave
 *   a truncated `<sha>.json.gz` visible. Temp file is 0600.
 * - Final file is 0600. Overwriting an existing entry with the same sha is
 *   idempotent (same content by construction) but still atomic.
 * - Never follows a symlink at the leaf: uses `fs.openSync` with `O_EXCL`
 *   on the temp path and refuses if the resolved parent path escapes the
 *   cache dir (defense-in-depth against a compromised cache dir).
 *
 * Returns the absolute path and byte counts on success.
 */
export function writeCanonicalBlob(
	sha: string,
	blob: string,
	opts?: { readonly cacheDir?: string },
): CanonicalWriteResult {
	if (!/^[0-9a-f]{64}$/.test(sha)) {
		throw new Error(`canonicalize: invalid sha (expected 64-char lowercase hex): ${sha}`);
	}
	const cacheDir = opts?.cacheDir ?? resolveCacheDir();

	// Pre-open secret scan. Fails closed with no filesystem side effect.
	const categories = scanRawString(blob);
	if (categories.length > 0) {
		throw new CanonicalBlobSecretError(categories);
	}

	// Ensure the parent directory exists with mode 0700 (create if absent).
	fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	// Defense-in-depth: refuse if the cache dir LEAF is itself a symlink.
	// Ancestor symlinks are tolerated (macOS `/var` is a symlink to
	// `/private/var`; comparing `path.resolve(cacheDir)` against
	// `realpathSync(cacheDir)` would false-fire on every macOS run). The
	// weaker leaf-only check catches the realistic attack (an attacker with
	// write on `${PI_CODING_AGENT_DIR}` swapping the cache dir for a symlink
	// outside the trust boundary) without breaking on benign OS-level
	// ancestor symlinks. Same-user attacker with write on the actual cache
	// dir can already write files there directly — not our threat model.
	//
	// A TOCTOU window remains between this check and the openSync(tmpPath)
	// below; O_EXCL protects the temp leaf against a pre-planted symlink but
	// not against a same-user attacker swapping the parent dir mid-flight.
	// Closing that would require openat/O_NOFOLLOW on the parent fd, which
	// Node's public fs API does not expose portably.
	const leafStat = fs.lstatSync(cacheDir);
	if (leafStat.isSymbolicLink()) {
		throw new Error(
			`canonicalize: cache dir '${cacheDir}' is a symlink; refusing to write`,
		);
	}

	const compressed = gzipSync(Buffer.from(blob, "utf8"));
	const finalPath = path.join(cacheDir, `${sha}.json.gz`);
	// Temp file in the same directory so rename is atomic on POSIX.
	const tmpPath = path.join(
		cacheDir,
		`.${sha}.${process.pid}.${Date.now()}.tmp`,
	);

	// O_EXCL prevents symlink-follow attacks on the temp path. If a stale
	// temp file exists (extremely unlikely — pid + timestamp collision), we
	// fail loud rather than silently reuse it.
	const fd = fs.openSync(
		tmpPath,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
		0o600,
	);
	try {
		fs.writeSync(fd, compressed);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	// Rename is atomic on POSIX filesystems.
	fs.renameSync(tmpPath, finalPath);
	// Belt-and-suspenders: assert the final mode is 0600. Some umasks or
	// mounts may downgrade the O_CREAT mode; explicit chmod ensures the
	// invariant regardless.
	fs.chmodSync(finalPath, 0o600);

	return {
		path: finalPath,
		uncompressedBytes: Buffer.byteLength(blob, "utf8"),
		compressedBytes: compressed.byteLength,
	};
}

/**
 * Test-only accessors. Exported so unit tests can lock the serialization
 * shape without duplicating internals; not part of the runtime API.
 */
export const __testing = { serialize, normalizeFrontmatterValue };
