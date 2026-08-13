/**
 * Core hashline behavior after the pi_config dependency patches — ports of
 * upstream test cases (test/core/hashline.hash.test.ts and
 * test/core/hashline.apply.test.ts at the pinned tag) from vitest to
 * node:test, exercising the vendored engine through vendor/xxh32.ts.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	applyHashlineEdits,
	computeHashFromContext,
	computeLineHash,
	type HashlineEdit,
} from "../src/hashline";

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

function makeTag(fileContent: string, line: number) {
	const fileLines = fileContent.split("\n");
	return { line, hash: computeLineHash(fileLines, line - 1) };
}

describe("computeLineHash — context hashing", () => {
	it("returns a 2-char string from the NIBBLE_STR alphabet", () => {
		const hash = computeLineHash(["prev", "hello", "next"], 1);
		assert.equal(hash.length, 2);
		assert.match(hash, new RegExp(`^[${NIBBLE_STR}]{2}$`));
	});

	it("editing line N changes hashes of exactly N-1, N, N+1", () => {
		const original = ["a", "b", "c", "d", "e", "f", "g"];
		const modified = ["a", "b", "CHANGED", "d", "e", "f", "g"];
		const before = original.map((_, i) => computeLineHash(original, i));
		const after = modified.map((_, i) => computeLineHash(modified, i));
		assert.notEqual(after[1], before[1]);
		assert.notEqual(after[2], before[2]);
		assert.notEqual(after[3], before[3]);
		assert.equal(after[0], before[0]);
		assert.equal(after[4], before[4]);
		assert.equal(after[5], before[5]);
		assert.equal(after[6], before[6]);
	});

	it("two identical '}' lines with different neighbors get different hashes", () => {
		const lines = ["if (a) {", "}", "if (b) {", "}"];
		assert.notEqual(computeLineHash(lines, 1), computeLineHash(lines, 3));
	});

	it("boundary lines hash stably with empty-string neighbors", () => {
		const lines = ["first", "second", "third"];
		assert.equal(computeLineHash(lines, 0), computeHashFromContext("", "first", "second"));
		assert.equal(computeLineHash(lines, 2), computeHashFromContext("second", "third", ""));
	});
});

describe("applyHashlineEdits — basic operations", () => {
	it("returns content unchanged for empty edits", () => {
		const result = applyHashlineEdits("hello\nworld", []);
		assert.equal(result.content, "hello\nworld");
		assert.equal(result.firstChangedLine, undefined);
	});

	it("replaces a single line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(content, 2), lines: ["BBB"] },
		];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.content, "aaa\nBBB\nccc");
		assert.equal(result.firstChangedLine, 2);
	});

	it("replaces a range of lines", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(content, 2),
				end: makeTag(content, 3),
				lines: ["BBB", "CCC"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.content, "aaa\nBBB\nCCC\nddd");
	});

	it("deletes a range of lines (empty lines array)", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(content, 2), end: makeTag(content, 3), lines: [] },
		];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.content, "aaa\nddd");
	});

	it("appends after a line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "append", pos: makeTag(content, 2), lines: ["inserted"] },
		];
		const result = applyHashlineEdits(content, edits);
		assert.equal(result.content, "aaa\nbbb\ninserted\nccc");
	});

	it("appends to EOF when no pos given", () => {
		const result = applyHashlineEdits("aaa\nbbb", [{ op: "append", lines: ["ccc"] }]);
		assert.equal(result.content, "aaa\nbbb\nccc");
	});

	it("rejects a stale anchor hash", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: { line: 2, hash: "ZZ" }, lines: ["BBB"] },
		];
		assert.throws(
			() => applyHashlineEdits(content, edits),
			(error: unknown) => error instanceof Error,
		);
	});
});
