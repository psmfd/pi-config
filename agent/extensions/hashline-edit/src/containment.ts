/**
 * Workspace containment for the hashline edit path (pi_config patch #5 —
 * not present upstream; see PATCH_MANIFEST.json and ADR-0135).
 *
 * A custom `registerTool` implementation inherits none of core pi's tool
 * behavior, so this extension states its own mutation boundary explicitly:
 *
 * - The symlink-resolved mutation target must stay inside the (realpath'd)
 *   session cwd. `resolveMutationTargetPath` has already chased symlinks, so
 *   a workspace-relative path that resolves through a symlink to an outside
 *   location is caught here (e.g. `~/.pi` symlinking to a repo).
 * - Writes into any `.git/` directory are refused: `.git/hooks/*`,
 *   `.git/config`, and object internals are a persistence/backdoor surface,
 *   not editable source (pi_config #977 tracks the same posture for the
 *   general guard layer).
 *
 * Overrides (enumerated per agent/extensions/README.md conventions; each is
 * scoped to the exact check it names):
 * - PI_HASHLINE_ALLOW_OUTSIDE_CWD=1 — permit mutation targets outside the
 *   session cwd (core pi's `edit` allows this; the restriction is this
 *   extension's fail-closed default).
 * - PI_HASHLINE_ALLOW_GIT_WRITES=1 — permit writes under `.git/`.
 *
 * Read paths are deliberately NOT restricted — parity with core `read`.
 */

import { realpathSync } from "fs";
import { resolve, sep } from "path";

function envFlag(name: string): boolean {
	const value = process.env[name];
	return value === "1" || value === "true";
}

function realCwd(cwd: string): string {
	try {
		return realpathSync(resolve(cwd));
	} catch {
		return resolve(cwd);
	}
}

function isWithin(target: string, root: string): boolean {
	const normalizedRoot = root.endsWith(sep) ? root : root + sep;
	return target === root || target.startsWith(normalizedRoot);
}

function hasGitSegment(target: string): boolean {
	return target.split(sep).includes(".git");
}

/**
 * Throws when `mutationTargetPath` (already symlink-resolved) falls outside
 * the containment policy. `displayPath` is the path as the model supplied it,
 * used for error messages.
 */
export function assertMutationAllowed(
	mutationTargetPath: string,
	cwd: string,
	displayPath: string,
): void {
	if (hasGitSegment(mutationTargetPath) && !envFlag("PI_HASHLINE_ALLOW_GIT_WRITES")) {
		throw new Error(
			`[E_CONTAINMENT] Refusing to edit ${displayPath}: the resolved target is inside a .git directory. Repository internals are not editable through the edit tool. (Operator override: PI_HASHLINE_ALLOW_GIT_WRITES=1.)`,
		);
	}

	if (envFlag("PI_HASHLINE_ALLOW_OUTSIDE_CWD")) {
		return;
	}

	const root = realCwd(cwd);
	if (!isWithin(mutationTargetPath, root)) {
		throw new Error(
			`[E_CONTAINMENT] Refusing to edit ${displayPath}: the resolved target (${mutationTargetPath}) is outside the session workspace (${root}). If the file is reached through a symlink, edit it at its real location from a session rooted there. (Operator override: PI_HASHLINE_ALLOW_OUTSIDE_CWD=1.)`,
		);
	}
}
