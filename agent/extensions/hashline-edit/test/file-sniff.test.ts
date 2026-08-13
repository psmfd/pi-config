/**
 * Magic-byte sniffer behavior (vendor/file-sniff.ts, patch #3 — replaces the
 * npm `file-type` dependency).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { sniffFileType } from "../vendor/file-sniff";

describe("sniffFileType", () => {
	it("detects the four image types file-kind special-cases", () => {
		assert.equal(sniffFileType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))?.mime, "image/jpeg");
		assert.equal(
			sniffFileType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mime,
			"image/png",
		);
		assert.equal(
			sniffFileType(new TextEncoder().encode("GIF89a-and-more"))?.mime,
			"image/gif",
		);
		const webp = new Uint8Array(16);
		webp.set(new TextEncoder().encode("RIFF"), 0);
		webp.set(new TextEncoder().encode("WEBP"), 8);
		assert.equal(sniffFileType(webp)?.mime, "image/webp");
	});

	it("labels common binary containers", () => {
		assert.equal(sniffFileType(new TextEncoder().encode("%PDF-1.7"))?.mime, "application/pdf");
		assert.equal(sniffFileType(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))?.mime, "application/zip");
		assert.equal(sniffFileType(Uint8Array.from([0x1f, 0x8b, 0x08]))?.mime, "application/gzip");
		assert.equal(sniffFileType(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))?.mime, "application/x-elf");
	});

	it("returns undefined for plain text and short buffers", () => {
		assert.equal(sniffFileType(new TextEncoder().encode("hello world\n")), undefined);
		assert.equal(sniffFileType(new Uint8Array(0)), undefined);
		assert.equal(sniffFileType(Uint8Array.from([0xff])), undefined);
	});
});
