/**
 * fanout-derive tests — deterministic trigger + derivation (#613, ADR-0095).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCanonicalBlob } from "../canonicalize.ts";
import { buildCanonicalQuery } from "../collector.ts";
import {
	deriveFanoutCanonicalInputs,
	deriveFanoutTaskString,
	deriveQueryInputs,
	isResearchShapedFanout,
	projectSearchResults,
	RESEARCH_FANOUT_MIN,
	REVIEW_ONLY_AGENTS,
	type FanoutTask,
} from "../fanout-derive.ts";

const t = (agent: string, task = "investigate the thing"): FanoutTask => ({ agent, task });

// --- isResearchShapedFanout -------------------------------------------------

test("fanout below the minimum never triggers", () => {
	assert.equal(isResearchShapedFanout([]), false);
	assert.equal(isResearchShapedFanout([t("ansible-expert")]), false);
	assert.equal(isResearchShapedFanout([t("ansible-expert"), t("docker-expert")]), false);
});

test("three divergent agents trigger", () => {
	assert.equal(
		isResearchShapedFanout([t("ansible-expert"), t("docker-expert"), t("shell-expert")]),
		true,
	);
});

test("review-only fanout never triggers (multi-reviewer command shape)", () => {
	assert.equal(
		isResearchShapedFanout([
			t("code-review-expert"),
			t("security-review-expert"),
			t("linter"),
		]),
		false,
	);
	// The four-way review composition stays a review.
	assert.equal(
		isResearchShapedFanout([
			t("code-review-expert"),
			t("security-review-expert"),
			t("checkmarx-expert"),
			t("linter"),
		]),
		false,
	);
});

test("one non-review agent flips a review trio into research", () => {
	assert.equal(
		isResearchShapedFanout([
			t("code-review-expert"),
			t("security-review-expert"),
			t("docs-expert"),
		]),
		true,
	);
});

test("the review set is the closed policy set", () => {
	assert.deepEqual(
		[...REVIEW_ONLY_AGENTS].sort(),
		["checkmarx-expert", "code-review-expert", "linter", "security-review-expert"],
	);
	assert.equal(RESEARCH_FANOUT_MIN, 3);
});

// --- deriveQueryInputs ------------------------------------------------------

test("query inputs: sorted de-duplicated agents, research taskType, first task", () => {
	const inputs = deriveQueryInputs([
		t("shell-expert", "harden the pre-push hook"),
		t("ansible-expert", "second task"),
		t("shell-expert", "third task"),
	]);
	assert.equal(inputs.domain, "ansible-expert shell-expert");
	assert.equal(inputs.taskType, "research");
	assert.equal(inputs.goalOrSymptom, "harden the pre-push hook");
});

test("query inputs feed buildCanonicalQuery deterministically", () => {
	const tasks = [
		t("shell-expert", "Harden the pre-push HOOK!"),
		t("ansible-expert", "x"),
		t("docker-expert", "y"),
	];
	const q1 = buildCanonicalQuery(deriveQueryInputs(tasks));
	const q2 = buildCanonicalQuery(deriveQueryInputs(tasks));
	assert.equal(q1, q2);
	assert.match(q1, /^ansible-expert docker-expert shell-expert research harden/);
});

// --- canonical blob inputs ---------------------------------------------------

test("fanout task string preserves caller order", () => {
	assert.equal(
		deriveFanoutTaskString([t("b-agent", "two"), t("a-agent", "one")]),
		"b-agent: two\na-agent: one",
	);
});

test("fanout canonical inputs: empty files, deterministic sha", () => {
	const args = {
		repoOrigin: "git@github.com:psmfd/pi-config.git",
		headSha: "a".repeat(40),
		tasks: [t("ansible-expert"), t("docker-expert"), t("shell-expert")],
	};
	const inputs = deriveFanoutCanonicalInputs(args);
	assert.deepEqual(inputs.files, []);
	assert.deepEqual(inputs.agentFrontmatter, {});
	const sha1 = computeCanonicalBlob(inputs).sha;
	const sha2 = computeCanonicalBlob(deriveFanoutCanonicalInputs(args)).sha;
	assert.equal(sha1, sha2);
	assert.match(sha1, /^[0-9a-f]{64}$/);
});

test("blob sha changes when the task list changes", () => {
	const base = {
		repoOrigin: "origin",
		headSha: "b".repeat(40),
		tasks: [t("ansible-expert", "one"), t("docker-expert", "two"), t("shell-expert", "three")],
	};
	const other = { ...base, tasks: [...base.tasks.slice(0, 2), t("shell-expert", "different")] };
	assert.notEqual(
		computeCanonicalBlob(deriveFanoutCanonicalInputs(base)).sha,
		computeCanonicalBlob(deriveFanoutCanonicalInputs(other)).sha,
	);
});

// --- projectSearchResults -----------------------------------------------------

const validRow = {
	id: "e-1",
	domain: "ansible",
	title: "Handler semantics",
	body: "Handlers fire once per play.",
	entryType: "Caveat",
	severity: "Warning",
};

test("projects the semantic-endpoint envelope", () => {
	const rows = projectSearchResults(JSON.stringify({ results: [validRow] }));
	assert.equal(rows.length, 1);
	assert.equal(rows[0].id, "e-1");
	assert.equal(rows[0].severity, "Warning");
});

test("accepts a bare array; keeps optional fields; filters junk tags", () => {
	const rows = projectSearchResults(
		JSON.stringify([
			{ ...validRow, source: "pi-session", sourceVersion: "1", tags: ["a", 2, null, {}] },
		]),
	);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].source, "pi-session");
	assert.deepEqual(rows[0].tags, ["a", "2"]);
});

test("projects upstream response-hygiene free-text wrappers", () => {
	const rows = projectSearchResults(
		JSON.stringify({
			results: [
				{
					...validRow,
					title: { contentClass: "user-supplied-free-text", value: "wrapped title" },
					body: { contentClass: "user-supplied-free-text", value: "wrapped body" },
				},
			],
		}),
	);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].title, "wrapped title");
	assert.equal(rows[0].body, "wrapped body");
});

test("drops rows missing required fields; coerces primitives", () => {
	const rows = projectSearchResults(
		JSON.stringify({
			results: [
				{ ...validRow, id: 7 }, // coerced
				{ ...validRow, body: undefined }, // dropped
				{ ...validRow, title: { nested: true } }, // no hygiene value: dropped
				"not-an-object", // dropped
			],
		}),
	);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].id, "7");
});

test("malformed JSON and non-envelope shapes degrade to empty", () => {
	assert.deepEqual(projectSearchResults("not json"), []);
	assert.deepEqual(projectSearchResults(JSON.stringify({ items: [validRow] })), []);
	assert.deepEqual(projectSearchResults(JSON.stringify(null)), []);
});
