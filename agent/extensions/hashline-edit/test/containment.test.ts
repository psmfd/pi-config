/**
 * Workspace containment (src/containment.ts, patch #5 — pi_config addition,
 * not present upstream). Covers the boundary check, the .git refusal, the
 * symlink-escape case, and both operator override env vars.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMutationAllowed } from "../src/containment";

const OVERRIDE_VARS = ["PI_HASHLINE_ALLOW_OUTSIDE_CWD", "PI_HASHLINE_ALLOW_GIT_WRITES"] as const;

function withoutOverrides(): void {
	for (const name of OVERRIDE_VARS) {
		delete process.env[name];
	}
}

describe("assertMutationAllowed", () => {
	afterEach(withoutOverrides);

	it("allows a target inside the workspace", () => {
		withoutOverrides();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hl-contain-")));
		try {
			assert.doesNotThrow(() => assertMutationAllowed(join(cwd, "src", "a.ts"), cwd, "src/a.ts"));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("refuses a target outside the workspace", () => {
		withoutOverrides();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hl-contain-")));
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "hl-outside-")));
		try {
			assert.throws(
				() => assertMutationAllowed(join(outside, "b.ts"), cwd, "../outside/b.ts"),
				/E_CONTAINMENT/,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses a symlink-escaped target (resolved path outside cwd)", () => {
		withoutOverrides();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hl-contain-")));
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "hl-outside-")));
		try {
			writeFileSync(join(outside, "real.ts"), "content\n");
			symlinkSync(outside, join(cwd, "link"));
			// The edit path resolves symlinks before this check, so the resolved
			// target is the outside path even though the display path is inside.
			assert.throws(
				() => assertMutationAllowed(join(outside, "real.ts"), cwd, "link/real.ts"),
				/E_CONTAINMENT/,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses .git internals even inside the workspace", () => {
		withoutOverrides();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hl-contain-")));
		try {
			mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
			assert.throws(
				() => assertMutationAllowed(join(cwd, ".git", "hooks", "pre-commit"), cwd, ".git/hooks/pre-commit"),
				/E_CONTAINMENT.*\.git/,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("PI_HASHLINE_ALLOW_OUTSIDE_CWD=1 permits outside-cwd targets but not .git", () => {
		withoutOverrides();
		process.env.PI_HASHLINE_ALLOW_OUTSIDE_CWD = "1";
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hl-contain-")));
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "hl-outside-")));
		try {
			assert.doesNotThrow(() => assertMutationAllowed(join(outside, "b.ts"), cwd, "b.ts"));
			assert.throws(
				() => assertMutationAllowed(join(outside, ".git", "config"), cwd, "config"),
				/E_CONTAINMENT/,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("PI_HASHLINE_ALLOW_GIT_WRITES=1 permits .git targets inside the workspace", () => {
		withoutOverrides();
		process.env.PI_HASHLINE_ALLOW_GIT_WRITES = "1";
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hl-contain-")));
		try {
			mkdirSync(join(cwd, ".git"), { recursive: true });
			assert.doesNotThrow(() =>
				assertMutationAllowed(join(cwd, ".git", "config"), cwd, ".git/config"),
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
