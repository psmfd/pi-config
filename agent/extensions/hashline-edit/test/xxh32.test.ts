/**
 * Reference-vector verification for the first-party xxh32 implementation
 * (vendor/xxh32.ts, patch #2 — replaces the upstream xxhashjs dependency).
 *
 * Vectors are the published xxHash32 test vectors over ASCII inputs; hashes
 * are session-ephemeral so cross-implementation equality with xxhashjs is not
 * required, but algorithm correctness is.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { xxh32 } from "../vendor/xxh32";

describe("xxh32 — reference vectors", () => {
	it("empty string, seed 0", () => {
		assert.equal(xxh32("", 0), 0x02cc5d05);
	});

	it("'abc', seed 0", () => {
		assert.equal(xxh32("abc", 0), 0x32d153ff);
	});

	it("long ASCII input, seed 0 (exercises the 16-byte lane loop)", () => {
		assert.equal(
			xxh32("The quick brown fox jumps over the lazy dog", 0),
			0xe85ea4de,
		);
	});
});

describe("xxh32 — properties", () => {
	it("is deterministic", () => {
		assert.equal(xxh32("hello world"), xxh32("hello world"));
	});

	it("seed changes the hash", () => {
		assert.notEqual(xxh32("hello", 0), xxh32("hello", 1));
	});

	it("returns an unsigned 32-bit integer", () => {
		for (const input of ["", "a", "hello", "éèê", "中文"]) {
			const h = xxh32(input);
			assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `bad hash for ${input}: ${h}`);
		}
	});

	it("hashes UTF-8 bytes (multibyte input differs from its prefix)", () => {
		assert.notEqual(xxh32("café"), xxh32("caf"));
	});
});
