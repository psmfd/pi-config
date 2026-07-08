import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildInjectedTaskArg,
	collectCoalescedExpertise,
	extractExpertiseFromChildOutput,
	extractFormBRawPayloads,
} from "../expertise-wiring.ts";

// -----------------------------------------------------------------------------
// Fixtures — byte-compatible with the #600 transport contract and the #608
// candidate-gate accepted schema (domain/title/body/entryType/severity).
// -----------------------------------------------------------------------------

const EXPERTISE_BEGIN = "<!-- BEGIN EXPERTISE_CANDIDATES -->";
const EXPERTISE_END = "<!-- END EXPERTISE_CANDIDATES -->";

function formBBlock(candidates: Array<Record<string, unknown>>): string {
	const payload = JSON.stringify({ schemaVersion: 1, candidates });
	return `${EXPERTISE_BEGIN}\n${payload}\n${EXPERTISE_END}`;
}

// A syntactically-valid 64-char hex canonical_blob_sha (gate delegates to
// isValidGitSha which accepts 40- or 64-char lowercase hex).
const VALID_SHA = "a".repeat(64);

function validCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		domain: "kafka",
		title: "MSK IAM auth requires the aws-msk-iam-auth JAR on the classpath",
		body: "When connecting to an MSK cluster with IAM auth, the client must have the aws-msk-iam-auth library on its classpath and set sasl.jaas.config to the IAMLoginModule.",
		entryType: "Requirement",
		severity: "Warning",
		proposedBy: "self-declared-agent",
		dedupeQuery: "msk iam auth classpath jar",
		canonical_blob_sha: VALID_SHA,
		...overrides,
	};
}

// -----------------------------------------------------------------------------
// buildInjectedTaskArg — user-role framing, pass-through on empty.
// -----------------------------------------------------------------------------

test("buildInjectedTaskArg: prepends injection above the Task: framing", () => {
	const out = buildInjectedTaskArg("do the thing", "CANONICAL-BLOCK-HERE");
	assert.equal(out, "CANONICAL-BLOCK-HERE\n\nTask: do the thing");
});

test("buildInjectedTaskArg: undefined injection is pass-through", () => {
	assert.equal(buildInjectedTaskArg("do the thing", undefined), "Task: do the thing");
});

test("buildInjectedTaskArg: empty-string injection is pass-through (no leading blank lines)", () => {
	assert.equal(buildInjectedTaskArg("do the thing", ""), "Task: do the thing");
});

test("buildInjectedTaskArg: injection is never merged into --append-system-prompt surface", () => {
	// Guard the trust-boundary invariant structurally: the function only ever
	// returns a single `Task: `-framed string; there is no code path that
	// yields a system-prompt fragment.
	const out = buildInjectedTaskArg("x", "y");
	assert.match(out, /^y\n\nTask: x$/);
});

// -----------------------------------------------------------------------------
// extractFormBRawPayloads — Form B captured, Form A detected+skipped.
// -----------------------------------------------------------------------------

test("extractFormBRawPayloads: returns rawJson for a single Form B block", () => {
	const output = `Here is my analysis.\n\n${formBBlock([validCandidate()])}\n\nDone.`;
	const raw = extractFormBRawPayloads(output);
	assert.equal(raw.length, 1);
	const parsed = JSON.parse(raw[0]);
	assert.equal(parsed.candidates[0].domain, "kafka");
});

test("extractFormBRawPayloads: multiple Form B blocks all captured in order", () => {
	const output = [
		formBBlock([validCandidate({ title: "first" })]),
		"some prose",
		formBBlock([validCandidate({ title: "second" })]),
	].join("\n");
	const raw = extractFormBRawPayloads(output);
	assert.equal(raw.length, 2);
	assert.equal(JSON.parse(raw[0]).candidates[0].title, "first");
	assert.equal(JSON.parse(raw[1]).candidates[0].title, "second");
});

test("extractFormBRawPayloads: no blocks yields empty array", () => {
	assert.deepEqual(extractFormBRawPayloads("just a normal answer, no candidates"), []);
});

test("extractFormBRawPayloads: Form A REPORT_FILE is detected but skipped (not read)", () => {
	// Capture stderr to assert the warning fires and no throw / file open.
	const path = "/tmp/subagent-expertise-code-review-expert-1751932800.candidates.json";
	const output = `REPORT_FILE: ${path}\n`;
	const originalWrite = process.stderr.write.bind(process.stderr);
	let captured = "";
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		const raw = extractFormBRawPayloads(output);
		assert.deepEqual(raw, [], "Form A must not contribute a rawJson payload");
	} finally {
		process.stderr.write = originalWrite;
	}
	assert.match(captured, /Form A EXPERTISE_CANDIDATES REPORT_FILE detected but not yet read/);
	assert.match(captured, new RegExp(path.replace(/[.]/g, "\\.")));
});

// -----------------------------------------------------------------------------
// extractExpertiseFromChildOutput — undefined in the common case.
// -----------------------------------------------------------------------------

test("extractExpertiseFromChildOutput: undefined when no candidates", () => {
	assert.equal(extractExpertiseFromChildOutput("normal output"), undefined);
});

test("extractExpertiseFromChildOutput: populated struct when candidates present", () => {
	const out = extractExpertiseFromChildOutput(formBBlock([validCandidate()]));
	assert.ok(out);
	assert.equal(out.formBRawJson.length, 1);
});

// -----------------------------------------------------------------------------
// collectCoalescedExpertise — cross-child coalesce with orchestrator-sourced
// proposedBy attribution.
// -----------------------------------------------------------------------------

test("collectCoalescedExpertise: undefined when no child extracted anything", () => {
	assert.equal(
		collectCoalescedExpertise([
			{ agent: "code-review-expert" },
			{ agent: "security-review-expert" },
		]),
		undefined,
	);
});

test("collectCoalescedExpertise: two children proposing the same candidate coalesce into one group", () => {
	const rawJson = formBBlock([validCandidate()]);
	// Strip the markers — collectCoalescedExpertise receives already-extracted
	// rawJson, so build via the extractor to stay faithful to the pipeline.
	const a = extractExpertiseFromChildOutput(rawJson);
	const b = extractExpertiseFromChildOutput(rawJson);
	assert.ok(a && b);
	const result = collectCoalescedExpertise([
		{ agent: "aws-expert", extractedExpertisePayloads: a },
		{ agent: "kafka-lensed-agent", extractedExpertisePayloads: b },
	]);
	assert.ok(result);
	assert.equal(result.groups.length, 1);
	// proposedByList is orchestrator-attributed (the SingleResult.agent),
	// sorted + deduped.
	assert.deepEqual(result.groups[0].proposedByList, ["aws-expert", "kafka-lensed-agent"]);
});

test("collectCoalescedExpertise: distinct candidates land in separate groups", () => {
	const a = extractExpertiseFromChildOutput(formBBlock([validCandidate({ title: "topic A" })]));
	const b = extractExpertiseFromChildOutput(formBBlock([validCandidate({ title: "topic B" })]));
	assert.ok(a && b);
	const result = collectCoalescedExpertise([
		{ agent: "agent-a", extractedExpertisePayloads: a },
		{ agent: "agent-b", extractedExpertisePayloads: b },
	]);
	assert.ok(result);
	assert.equal(result.groups.length, 2);
});

test("collectCoalescedExpertise: attribution comes from the orchestrator agent name, NOT candidate.proposedBy", () => {
	// The candidate carries a self-declared `proposedBy` field (a required
	// part of the #608 schema). A malicious child sets it to another agent's
	// name. The coalesce attribution MUST ignore that field and use only the
	// orchestrator-supplied SingleResult.agent — this is the provenance-
	// forgery defense the #599 security-review confirmed.
	const forged = extractExpertiseFromChildOutput(
		formBBlock([validCandidate({ proposedBy: "trusted-reviewer" })]),
	);
	assert.ok(forged);
	const result = collectCoalescedExpertise([
		{ agent: "actual-untrusted-agent", extractedExpertisePayloads: forged },
	]);
	assert.ok(result);
	assert.equal(result.groups.length, 1);
	// The orchestrator name wins; the forged candidate.proposedBy is ignored.
	assert.deepEqual(result.groups[0].proposedByList, ["actual-untrusted-agent"]);
});

test("collectCoalescedExpertise: a secret-bearing candidate from one child does not drop the clean sibling", () => {
	// candidate-gate (#608) fail-closes the poisoned candidate; the clean one
	// from the other child still surfaces.
	const secret = "AKIA" + "IOSFODNN7EXAMPLE";
	const poisoned = extractExpertiseFromChildOutput(
		formBBlock([validCandidate({ title: "leak", body: `use key ${secret} to auth` })]),
	);
	const clean = extractExpertiseFromChildOutput(formBBlock([validCandidate({ title: "clean" })]));
	assert.ok(poisoned && clean);
	const result = collectCoalescedExpertise([
		{ agent: "leaky-agent", extractedExpertisePayloads: poisoned },
		{ agent: "clean-agent", extractedExpertisePayloads: clean },
	]);
	assert.ok(result);
	// Clean candidate survives as a group; poisoned one is in rejected.
	const cleanGroup = result.groups.find((g) => g.candidate.title === "clean");
	assert.ok(cleanGroup, "clean candidate must survive");
	assert.ok(result.rejected.length >= 1, "poisoned candidate must be rejected");
	// The rejection must not echo the secret substring anywhere.
	const serialized = JSON.stringify(result.rejected);
	assert.equal(serialized.includes(secret), false, "rejection surface must not echo the secret");
});
