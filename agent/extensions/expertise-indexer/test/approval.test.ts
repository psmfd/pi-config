/**
 * approval.ts tests — the ADR-0095 approval-hash binding (#605).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	approvalFieldsFromCandidate,
	approvalFieldsFromCreateInput,
	computeApprovalHash,
	serializeApprovalFields,
	type ApprovalFields,
} from "../approval.ts";
import type { ProjectedCandidate } from "../candidate-gate.ts";

const BASE: ApprovalFields = {
	domain: "ansible",
	title: "Handler semantics",
	body: "Handlers fire once per play.",
	entryType: "Caveat",
	severity: "Warning",
};

test("serialization is byte-locked: fixed key order, optional keys only when present", () => {
	assert.equal(
		serializeApprovalFields(BASE),
		'{"body":"Handlers fire once per play.","domain":"ansible","entryType":"Caveat","severity":"Warning","title":"Handler semantics"}',
	);
	assert.equal(
		serializeApprovalFields({ ...BASE, source: "pi-session", tags: ["b", "a"], sourceVersion: "1" }),
		'{"body":"Handlers fire once per play.","domain":"ansible","entryType":"Caveat","severity":"Warning","source":"pi-session","sourceVersion":"1","tags":["b","a"],"title":"Handler semantics"}',
	);
});

test("hash is deterministic and sensitive to every hashed field", () => {
	const h = computeApprovalHash(BASE);
	assert.equal(h, computeApprovalHash({ ...BASE }));
	assert.match(h, /^[0-9a-f]{64}$/);
	for (const variant of [
		{ ...BASE, domain: "kafka" },
		{ ...BASE, title: "x" },
		{ ...BASE, body: `${BASE.body} ` },
		{ ...BASE, entryType: "Pattern" },
		{ ...BASE, severity: "Critical" },
		{ ...BASE, source: "pi-session" },
		{ ...BASE, tags: ["a"] },
		{ ...BASE, sourceVersion: "2" },
	]) {
		assert.notEqual(computeApprovalHash(variant), h);
	}
});

test("tag ORDER is part of the approved content", () => {
	assert.notEqual(
		computeApprovalHash({ ...BASE, tags: ["a", "b"] }),
		computeApprovalHash({ ...BASE, tags: ["b", "a"] }),
	);
});

test("candidate projection excludes review-only fields (justification, dedupeQuery, sha, proposedBy)", () => {
	const candidate: ProjectedCandidate = {
		...BASE,
		entryType: "Caveat",
		severity: "Warning",
		justification: "worth persisting because …",
		proposedBy: "ansible-expert",
		dedupeQuery: "ansible handler semantics",
		canonical_blob_sha: "a".repeat(64),
	};
	const fields = approvalFieldsFromCandidate(candidate);
	assert.deepEqual(fields, BASE);
	// The hash from the candidate matches a create call carrying exactly the
	// create-relevant subset — the load-bearing round trip.
	assert.equal(
		computeApprovalHash(fields),
		computeApprovalHash(approvalFieldsFromCreateInput({ ...BASE })!),
	);
});

test("create-input narrowing accepts the create shape and rejects violations", () => {
	assert.deepEqual(approvalFieldsFromCreateInput({ ...BASE }), BASE);
	assert.deepEqual(
		approvalFieldsFromCreateInput({ ...BASE, tags: ["x"], source: "s" }),
		{ ...BASE, tags: ["x"], source: "s" },
	);
	for (const bad of [
		{ ...BASE, domain: 7 },
		{ ...BASE, body: undefined },
		{ ...BASE, tags: "not-an-array" },
		{ ...BASE, tags: ["ok", 3] },
		{ ...BASE, source: {} },
		{ ...BASE, sourceVersion: 1 },
	]) {
		assert.equal(approvalFieldsFromCreateInput(bad as Record<string, unknown>), null);
	}
});

test("unknown extra keys are ignored by the narrowing (the tool schema owns rejection)", () => {
	const fields = approvalFieldsFromCreateInput({ ...BASE, approved: true, extra: "x" });
	assert.deepEqual(fields, BASE);
});
