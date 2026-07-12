/**
 * expertise-indexer — hardened Form A (`REPORT_FILE:`) reader (#600, ADR-0095).
 *
 * Closes the deferral recorded in `subagent/expertise-wiring.ts`: Form A
 * `EXPERTISE_CANDIDATES` payloads were detected but never opened, pending an
 * O_NOFOLLOW + fstat reader (security-review TOCTOU concern from #599).
 *
 * The path reaching this module has already matched the strict allowlist in
 * `collector.ts` (`^/tmp/subagent-expertise-[a-z0-9-]+-\d+\.candidates\.json$`);
 * this reader re-verifies it (defense in depth) and enforces the #600
 * constraint set on the OPEN FILE DESCRIPTION — never on a re-resolved path,
 * so nothing can be swapped between check and use:
 *
 *   1. `O_NOFOLLOW` open — a symlink at the leaf fails with ELOOP.
 *   2. `fstat(fd)` (the opened inode, not the path): regular file, size ≤
 *      `MAX_FORM_A_BYTES` (512 KB, the #600 collector cap), owned by the
 *      current uid, permissions exactly 0600 (children MUST create their
 *      candidate files with mode 0600 — part of the transport contract).
 *   3. Parent-directory canonicalization: `realpath(dirname)` must equal
 *      `realpath("/tmp")` — comparing canonical-to-canonical keeps this
 *      correct on macOS, where `/tmp` is itself a symlink to `/private/tmp`
 *      (a literal string compare against "/tmp" would reject every valid
 *      file there).
 *   4. Read via the SAME fd.
 *
 * Failures return a structured `{ok: false, reason}` with a stable code —
 * the consumer logs it and drops the payload (fail-open at extraction,
 * fail-closed at ingestion, matching the wiring's existing posture).
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

/** #600 Form A collector cap. */
export const MAX_FORM_A_BYTES = 512 * 1024;

/** Leaf-basename shape (the /tmp anchoring is enforced via realpath, not regex). */
const FORM_A_BASENAME_RE = /^subagent-expertise-[a-z0-9-]+-\d+\.candidates\.json$/;

export type FormAReadResult =
	| { readonly ok: true; readonly rawJson: string }
	| { readonly ok: false; readonly reason: FormAReadFailure; readonly detail?: string };

export type FormAReadFailure =
	| "bad-path-shape"
	| "parent-escape"
	| "open-failed"
	| "not-regular-file"
	| "too-large"
	| "wrong-owner"
	| "wrong-permissions"
	| "read-failed";

/** Read and validate a Form A candidates file per the constraint set above. */
export function readCandidatesFile(reportFile: string): FormAReadResult {
	// Defense-in-depth re-check of the allowlisted shape.
	if (
		!reportFile.startsWith("/tmp/") ||
		reportFile.includes("..") ||
		!FORM_A_BASENAME_RE.test(basename(reportFile))
	) {
		return { ok: false, reason: "bad-path-shape" };
	}

	// Parent canonicalization: canonical-to-canonical compare (macOS /tmp is
	// a symlink; both sides resolve to /private/tmp there).
	let parentReal: string;
	let tmpReal: string;
	try {
		parentReal = realpathSync(dirname(reportFile));
		tmpReal = realpathSync("/tmp");
	} catch (err) {
		return { ok: false, reason: "parent-escape", detail: String(err) };
	}
	if (parentReal !== tmpReal) {
		return { ok: false, reason: "parent-escape" };
	}

	let fd: number;
	try {
		fd = openSync(reportFile, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (err) {
		// ELOOP here = symlink at the leaf — exactly what O_NOFOLLOW exists for.
		return { ok: false, reason: "open-failed", detail: (err as NodeJS.ErrnoException).code ?? "" };
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return { ok: false, reason: "not-regular-file" };
		if (st.size > MAX_FORM_A_BYTES) {
			return { ok: false, reason: "too-large", detail: String(st.size) };
		}
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
			return { ok: false, reason: "wrong-owner" };
		}
		if ((st.mode & 0o777) !== 0o600) {
			return {
				ok: false,
				reason: "wrong-permissions",
				detail: `0${(st.mode & 0o777).toString(8)}`,
			};
		}
		let rawJson: string;
		try {
			rawJson = readFileSync(fd, "utf8");
		} catch (err) {
			return { ok: false, reason: "read-failed", detail: String(err) };
		}
		return { ok: true, rawJson };
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* ignore */
		}
	}
}
