/**
 * threeWayMerge behavior through the vendored jsdiff bundle
 * (vendor/jsdiff/diff.js, patch #1 — replaces the npm `diff` dependency).
 * Ports the observable contract documented in src/merge.ts.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { threeWayMerge } from "../src/merge";

describe("threeWayMerge", () => {
	it("short-circuits when base === current", () => {
		assert.equal(threeWayMerge("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n"), "a\nB\nc\n");
	});

	it("replays a change onto a current with distant unrelated edits", () => {
		const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
		const baseEdited = base.replace("two", "TWO");
		const current = base.replace("ten", "TEN");
		const merged = threeWayMerge(base, baseEdited, current);
		assert.equal(merged, "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
	});

	it("returns null when the patch context no longer applies (fuzzFactor 0)", () => {
		const base = "one\ntwo\nthree\n";
		const baseEdited = "one\nTWO\nthree\n";
		const current = "completely\ndifferent\ncontent\n";
		assert.equal(threeWayMerge(base, baseEdited, current), null);
	});

	it("returns null when the merge result is identical to current", () => {
		const base = "one\ntwo\nthree\n";
		const baseEdited = "one\nTWO\nthree\n";
		const current = "one\nTWO\nthree\n";
		assert.equal(threeWayMerge(base, baseEdited, current), null);
	});
});
