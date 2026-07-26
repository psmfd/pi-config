/**
 * prefill-meter record builders — pure unit tests (no pi runtime, no I/O).
 *
 * The load-bearing assertion: composing a synthetic system prompt with the
 * SAME templates the builder subtracts (context section, append join, pi's own
 * exported formatSkillsForPrompt) must make the derived baseBytes come out at
 * exactly the base part — proving the segment math is exact, not approximate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

import {
	buildSpawnRecord,
	buildUsageRecord,
	renderAppendSection,
	renderContextSection,
	toJsonl,
} from "../record.ts";

const CTX = { ts: "2026-07-26T00:00:00.000Z", label: "probe-3", pid: 4242, depth: 1 };

function makeSkill(name: string, disabled: boolean): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		disableModelInvocation: disabled,
	} as unknown as Skill;
}

test("segment math is exact for a fully populated prompt", () => {
	const base = "You are pi.\n\nTools: read, bash.\nCurrent working directory: /tmp/x";
	const append = "## Role\nYou are the linter wrapper.";
	const contextFiles = [
		{ path: "/repo/AGENTS.md", content: "orchestrate all the things" },
		{ path: "/repo/CLAUDE.md", content: "project instructions — naïve UTF-8 ✓" },
	];
	const skills = [makeSkill("visible-skill", false), makeSkill("hidden-skill", true)];

	const systemPrompt =
		base +
		renderAppendSection(append) +
		renderContextSection(contextFiles) +
		formatSkillsForPrompt(skills);

	const rec = buildSpawnRecord(
		{ prompt: "Task: lint it", systemPrompt, systemPromptOptions: { appendSystemPrompt: append, contextFiles, skills } as never },
		CTX,
	);

	assert.equal(rec.kind, "spawn");
	assert.equal(rec.label, "probe-3");
	assert.equal(rec.depth, 1);
	assert.equal(rec.promptBytes, Buffer.byteLength("Task: lint it", "utf8"));
	assert.equal(rec.systemPromptBytes, Buffer.byteLength(systemPrompt, "utf8"));
	// The exactness proof: subtraction recovers the base part to the byte.
	assert.equal(rec.baseBytes, Buffer.byteLength(base, "utf8"));
	assert.equal(rec.appendBytes, Buffer.byteLength(append, "utf8"));
	assert.equal(rec.appendSectionBytes, rec.appendBytes + 2); // the "\n\n" join
	assert.equal(rec.contextFiles.length, 2);
	// Multi-byte content is counted in BYTES, not code units.
	assert.equal(
		rec.contextFiles[1].bytes,
		Buffer.byteLength(contextFiles[1].content, "utf8"),
	);
	assert.ok(rec.contextFiles[1].bytes > contextFiles[1].content.length);
	assert.equal(rec.skillsTotal, 2);
	assert.equal(rec.skillsVisible, 1);
	assert.equal(
		rec.skillsSectionBytes,
		Buffer.byteLength(formatSkillsForPrompt(skills), "utf8"),
	);
	assert.equal(rec.driftSuspect, undefined);
	// Content never lands in the record.
	const line = toJsonl(rec);
	assert.ok(!line.includes("orchestrate all the things"));
	assert.ok(!line.includes(append));
});

test("empty segments record as zero and sha is null without a wrapper body", () => {
	const rec = buildSpawnRecord(
		{ prompt: "hi", systemPrompt: "base only", systemPromptOptions: {} as never },
		CTX,
	);
	assert.equal(rec.appendBytes, 0);
	assert.equal(rec.appendSectionBytes, 0);
	assert.equal(rec.contextSectionBytes, 0);
	assert.deepEqual(rec.contextFiles, []);
	assert.equal(rec.skillsSectionBytes, 0);
	assert.equal(rec.baseBytes, Buffer.byteLength("base only", "utf8"));
	assert.equal(rec.appendSha256, null);
});

test("all-hidden skills render zero bytes (pi's own filter applies)", () => {
	const skills = [makeSkill("a", true), makeSkill("b", true)];
	const rec = buildSpawnRecord(
		{ prompt: "x", systemPrompt: "base", systemPromptOptions: { skills } as never },
		CTX,
	);
	assert.equal(rec.skillsTotal, 2);
	assert.equal(rec.skillsVisible, 0);
	assert.equal(rec.skillsSectionBytes, 0);
});

test("wrapper-body sha256 is the standard digest", () => {
	const rec = buildSpawnRecord(
		{
			prompt: "x",
			systemPrompt: `base${renderAppendSection("abc")}`,
			systemPromptOptions: { appendSystemPrompt: "abc" } as never,
		},
		CTX,
	);
	assert.equal(
		rec.appendSha256,
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
});

test("template drift that shrinks the real block sets driftSuspect", () => {
	// systemPrompt is shorter than the rendered sections claim it should be.
	const rec = buildSpawnRecord(
		{
			prompt: "x",
			systemPrompt: "tiny",
			systemPromptOptions: {
				appendSystemPrompt: "a much longer wrapper body than the prompt itself",
			} as never,
		},
		CTX,
	);
	assert.ok(rec.baseBytes < 0);
	assert.equal(rec.driftSuspect, true);
});

test("renderContextSection matches pi's template literals", () => {
	assert.equal(renderContextSection([]), "");
	const one = renderContextSection([{ path: "/p/AGENTS.md", content: "C" }]);
	assert.equal(
		one,
		"\n\n<project_context>\n\n" +
			"Project-specific instructions and guidelines:\n\n" +
			'<project_instructions path="/p/AGENTS.md">\nC\n</project_instructions>\n\n' +
			"</project_context>\n",
	);
});

test("buildUsageRecord: assistant with usage → record; otherwise null", () => {
	assert.equal(buildUsageRecord(undefined, CTX), null);
	assert.equal(buildUsageRecord({ role: "user" }, CTX), null);
	assert.equal(buildUsageRecord({ role: "assistant" }, CTX), null);

	const rec = buildUsageRecord(
		{
			role: "assistant",
			model: "omlx/workhorse",
			usage: { input: 11000, cacheRead: 500, output: 42 },
		},
		CTX,
		"omlx",
	);
	assert.ok(rec);
	assert.equal(rec.kind, "first_usage");
	assert.equal(rec.model, "omlx/workhorse");
	assert.equal(rec.provider, "omlx"); // fallback: message carried no provider
	assert.equal(rec.input, 11000);
	assert.equal(rec.cacheRead, 500);
	assert.equal(rec.cacheWrite, 0); // absent field defaults to 0
	assert.equal(rec.output, 42);
});
