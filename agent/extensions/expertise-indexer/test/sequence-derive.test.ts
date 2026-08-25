/**
 * sequence-derive tests — deterministic trigger + derivation (#1055, ADR-0148).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCanonicalBlob } from "../canonicalize.ts";
import { buildCanonicalQuery } from "../collector.ts";
import {
	deriveQueryInputs,
	deriveSequenceCanonicalInputs,
	deriveSequenceTaskString,
	isResearchShapedSequence,
	projectSearchResults,
	RESEARCH_SEQUENCE_MIN,
	REVIEW_ONLY_AGENTS,
	type SequenceTask,
} from "../sequence-derive.ts";

const t = (agent: string, task = "investigate the thing"): SequenceTask => ({ agent, task });

test("sequence below the minimum never triggers", () => {
	assert.equal(isResearchShapedSequence([]), false);
	assert.equal(isResearchShapedSequence([t("ansible-expert")]), false);
	assert.equal(isResearchShapedSequence([t("ansible-expert"), t("docker-expert")]), false);
});

test("three divergent serial agents trigger", () => {
	assert.equal(
		isResearchShapedSequence([t("ansible-expert"), t("docker-expert"), t("shell-expert")]),
		true,
	);
});

test("review-only sequence never triggers", () => {
	assert.equal(
		isResearchShapedSequence([
			t("code-review-expert"),
			t("security-review-expert"),
			t("linter"),
		]),
		false,
	);
	assert.equal(
		isResearchShapedSequence([
			t("code-review-expert"),
			t("security-review-expert"),
			t("checkmarx-expert"),
			t("linter"),
		]),
		false,
	);
});

test("one non-review agent makes the sequence research-shaped", () => {
	assert.equal(
		isResearchShapedSequence([
			t("code-review-expert"),
			t("security-review-expert"),
			t("docs-expert"),
		]),
		true,
	);
});

test("the review set and serial research floor are fixed policy", () => {
	assert.deepEqual(
		[...REVIEW_ONLY_AGENTS].sort(),
		["checkmarx-expert", "code-review-expert", "linter", "security-review-expert"],
	);
	assert.equal(RESEARCH_SEQUENCE_MIN, 3);
});

test("query inputs use sorted agents and the first serial prompt", () => {
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
	const sequence = [
		t("shell-expert", "Harden the pre-push HOOK!"),
		t("ansible-expert", "x"),
		t("docker-expert", "y"),
	];
	const q1 = buildCanonicalQuery(deriveQueryInputs(sequence));
	const q2 = buildCanonicalQuery(deriveQueryInputs(sequence));
	assert.equal(q1, q2);
	assert.match(q1, /^ansible-expert docker-expert shell-expert research harden/);
});

test("sequence task string preserves caller order", () => {
	assert.equal(
		deriveSequenceTaskString([t("b-agent", "two"), t("a-agent", "one")]),
		"b-agent: two\na-agent: one",
	);
});

test("sequence canonical inputs have empty files and deterministic sha", () => {
	const args = {
		repoOrigin: "git@github.com:psmfd/pi-config.git",
		headSha: "a".repeat(40),
		sequence: [t("ansible-expert"), t("docker-expert"), t("shell-expert")],
	};
	const inputs = deriveSequenceCanonicalInputs(args);
	assert.deepEqual(inputs.files, []);
	assert.deepEqual(inputs.agentFrontmatter, {});
	const sha1 = computeCanonicalBlob(inputs).sha;
	const sha2 = computeCanonicalBlob(deriveSequenceCanonicalInputs(args)).sha;
	assert.equal(sha1, sha2);
	assert.match(sha1, /^[0-9a-f]{64}$/);
});

test("blob sha changes when the serial prompt list changes", () => {
	const base = {
		repoOrigin: "origin",
		headSha: "b".repeat(40),
		sequence: [t("ansible-expert", "one"), t("docker-expert", "two"), t("shell-expert", "three")],
	};
	const other = { ...base, sequence: [...base.sequence.slice(0, 2), t("shell-expert", "different")] };
	assert.notEqual(
		computeCanonicalBlob(deriveSequenceCanonicalInputs(base)).sha,
		computeCanonicalBlob(deriveSequenceCanonicalInputs(other)).sha,
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

test("projects v2.0 hygiene wrappers on domain/source/sourceVersion/tags", () => {
	// agent-expertise-api v2.0 wraps the sibling free-text fields too. domain is a
	// required field: extracting it with the primitive-only helper would return null
	// and silently drop every row. This asserts the whole row survives and every
	// wrapped field is unwrapped to its inner value.
	const wrap = (value: string) => ({ contentClass: "user-supplied-free-text", value });
	const rows = projectSearchResults(
		JSON.stringify({
			results: [
				{
					id: "e-1",
					domain: wrap("ansible"),
					title: wrap("Handler semantics"),
					body: wrap("Handlers fire once per play."),
					entryType: "Caveat",
					severity: "Warning",
					source: wrap("pi-session"),
					sourceVersion: wrap("2"),
					tags: [wrap("handlers"), wrap("play")],
				},
			],
		}),
	);
	assert.equal(rows.length, 1, "a v2.0 wrapped row must survive, not be dropped");
	assert.equal(rows[0].domain, "ansible");
	assert.equal(rows[0].source, "pi-session");
	assert.equal(rows[0].sourceVersion, "2");
	assert.deepEqual(rows[0].tags, ["handlers", "play"]);
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
