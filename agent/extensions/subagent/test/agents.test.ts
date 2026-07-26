/**
 * agents.ts discovery tests (#793): wrapper frontmatter is operator-authored
 * YAML, so wrong-typed values must degrade per-file, never crash the whole
 * discovery pass. Uses a temp $HOME (os.homedir() reads $HOME at call time)
 * so no test touches the operator's live ~/.pi.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { discoverAgents } from "../agents.ts";

function withTempHome(fn: (agentsDir: string) => void): void {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-agents-"));
	const prev = process.env.HOME;
	process.env.HOME = home;
	const agentsDir = path.join(home, ".pi", "agent", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	try {
		fn(agentsDir);
	} finally {
		process.env.HOME = prev;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function write(dir: string, name: string, frontmatter: string): void {
	fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\nbody\n`);
}

test("wrong-typed tools frontmatter degrades to no tools list, not a crash", () => {
	withTempHome((dir) => {
		write(dir, "bool-tools.md", "name: bool-tools\ndescription: d\ntools: true");
		write(dir, "list-tools.md", "name: list-tools\ndescription: d\ntools: [read, grep]");
		write(dir, "good.md", "name: good\ndescription: d\ntools: read, grep");
		const { agents } = discoverAgents(process.cwd(), "user");
		const byName = new Map(agents.map((a) => [a.name, a]));
		// YAML-boolean and YAML-list values are not the documented
		// comma-separated string form — the wrapper survives with no
		// tools restriction rather than crashing discovery.
		assert.equal(byName.get("bool-tools")?.tools, undefined);
		assert.equal(byName.get("list-tools")?.tools, undefined);
		assert.deepEqual(byName.get("good")?.tools, ["read", "grep"]);
	});
});

test("wrong-typed guard-profile degrades to no profile, not a crash", () => {
	withTempHome((dir) => {
		write(dir, "bool-profile.md", "name: bool-profile\ndescription: d\nguard-profile: true");
		write(dir, "good-profile.md", "name: good-profile\ndescription: d\nguard-profile: report-only");
		const { agents } = discoverAgents(process.cwd(), "user");
		const byName = new Map(agents.map((a) => [a.name, a]));
		assert.equal(byName.get("bool-profile")?.guardProfile, undefined);
		assert.equal(byName.get("good-profile")?.guardProfile, "report-only");
	});
});

test("context-files parses exact values only; typos land on the suppressed default", () => {
	withTempHome((dir) => {
		write(dir, "cf-absent.md", "name: cf-absent\ndescription: d");
		write(dir, "cf-inherit.md", "name: cf-inherit\ndescription: d\ncontext-files: inherit");
		write(dir, "cf-none.md", "name: cf-none\ndescription: d\ncontext-files: none");
		write(dir, "cf-typo.md", "name: cf-typo\ndescription: d\ncontext-files: inherti");
		write(dir, "cf-bool.md", "name: cf-bool\ndescription: d\ncontext-files: true");
		const { agents } = discoverAgents(process.cwd(), "user");
		const byName = new Map(agents.map((a) => [a.name, a]));
		// LOCAL PATCH #18 (pi_config #889, ADR-0124): absent and unrecognized
		// values are indistinguishable from `none` downstream — the spawn path
		// treats anything but the literal "inherit" as suppress.
		assert.equal(byName.get("cf-absent")?.contextFiles, undefined);
		assert.equal(byName.get("cf-inherit")?.contextFiles, "inherit");
		assert.equal(byName.get("cf-none")?.contextFiles, "none");
		assert.equal(byName.get("cf-typo")?.contextFiles, undefined);
		assert.equal(byName.get("cf-bool")?.contextFiles, undefined);
	});
});

test("one malformed wrapper never aborts discovery for the rest of the catalog", () => {
	withTempHome((dir) => {
		// Unparseable YAML frontmatter.
		fs.writeFileSync(path.join(dir, "broken.md"), "---\nname: [unclosed\n---\nbody\n");
		write(dir, "survivor.md", "name: survivor\ndescription: d");
		const { agents } = discoverAgents(process.cwd(), "user");
		assert.ok(
			agents.some((a) => a.name === "survivor"),
			"survivor must be discovered despite the broken sibling",
		);
	});
});
