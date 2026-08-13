/**
 * Canonical xxHash32 over the UTF-8 bytes of a string.
 *
 * First-party replacement for the upstream `xxhashjs` dependency (patch #2 in
 * PATCH_MANIFEST.json): pi loads extensions through jiti with
 * `tryNative: false`, so third-party npm packages cannot be imported at
 * runtime (ADR-0099). Hashes are session-ephemeral (minted at `read`,
 * validated at `edit` in the same process), so cross-implementation
 * bit-equality with xxhashjs is not load-bearing — but this implements the
 * reference xxHash32 algorithm exactly, verified against the published test
 * vectors in test/xxh32.test.ts.
 */

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

function rotl32(value: number, count: number): number {
	return ((value << count) | (value >>> (32 - count))) >>> 0;
}

function mul32(a: number, b: number): number {
	// 32-bit modular multiply without BigInt: split into 16-bit halves.
	const aHi = a >>> 16;
	const aLo = a & 0xffff;
	return (((aHi * b) << 16) + aLo * b) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset]! |
			(bytes[offset + 1]! << 8) |
			(bytes[offset + 2]! << 16) |
			(bytes[offset + 3]! << 24)) >>>
		0
	);
}

const encoder = new TextEncoder();

export function xxh32(input: string, seed = 0): number {
	const data = encoder.encode(input);
	const len = data.length;
	let offset = 0;
	let h32: number;

	if (len >= 16) {
		let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
		let v2 = (seed + PRIME32_2) >>> 0;
		let v3 = seed >>> 0;
		let v4 = (seed - PRIME32_1) >>> 0;
		const limit = len - 16;
		while (offset <= limit) {
			v1 = mul32(rotl32((v1 + mul32(readU32LE(data, offset), PRIME32_2)) >>> 0, 13), PRIME32_1);
			v2 = mul32(rotl32((v2 + mul32(readU32LE(data, offset + 4), PRIME32_2)) >>> 0, 13), PRIME32_1);
			v3 = mul32(rotl32((v3 + mul32(readU32LE(data, offset + 8), PRIME32_2)) >>> 0, 13), PRIME32_1);
			v4 = mul32(rotl32((v4 + mul32(readU32LE(data, offset + 12), PRIME32_2)) >>> 0, 13), PRIME32_1);
			offset += 16;
		}
		h32 = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
	} else {
		h32 = (seed + PRIME32_5) >>> 0;
	}

	h32 = (h32 + len) >>> 0;

	while (offset + 4 <= len) {
		h32 = mul32(rotl32((h32 + mul32(readU32LE(data, offset), PRIME32_3)) >>> 0, 17), PRIME32_4);
		offset += 4;
	}

	while (offset < len) {
		h32 = mul32(rotl32((h32 + mul32(data[offset]!, PRIME32_5)) >>> 0, 11), PRIME32_1);
		offset += 1;
	}

	h32 = mul32(h32 ^ (h32 >>> 15), PRIME32_2);
	h32 = mul32(h32 ^ (h32 >>> 13), PRIME32_3);
	h32 = (h32 ^ (h32 >>> 16)) >>> 0;

	return h32;
}
