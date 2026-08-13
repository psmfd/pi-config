/**
 * Minimal magic-byte file-type sniffer.
 *
 * First-party replacement for the upstream `file-type` dependency (patch #3
 * in PATCH_MANIFEST.json): pi loads extensions through jiti with
 * `tryNative: false`, so third-party npm packages cannot be imported at
 * runtime (ADR-0099).
 *
 * Behavior delta vs. upstream, deliberate and documented: `file-type`
 * recognises hundreds of formats; this sniffer detects only the four image
 * types src/file-kind.ts special-cases (jpeg/png/gif/webp) plus a few common
 * binary container signatures for a nicer description. Every other binary
 * file is still caught by file-kind's null-byte heuristic and reported as
 * "null bytes detected" instead of a precise MIME type — the routing
 * decision (text vs image vs binary) is unchanged.
 */

export interface SniffedFileType {
	mime: string;
}

function startsWith(buffer: Uint8Array, bytes: number[], offset = 0): boolean {
	if (buffer.length < offset + bytes.length) return false;
	for (let i = 0; i < bytes.length; i++) {
		if (buffer[offset + i] !== bytes[i]) return false;
	}
	return true;
}

export function sniffFileType(buffer: Uint8Array): SniffedFileType | undefined {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg" };
	if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return { mime: "image/png" };
	}
	if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif" };
	if (
		startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
		startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
	) {
		return { mime: "image/webp" };
	}
	if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return { mime: "application/pdf" };
	if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])) {
		return { mime: "application/zip" };
	}
	if (startsWith(buffer, [0x1f, 0x8b])) return { mime: "application/gzip" };
	if (startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46])) return { mime: "application/x-elf" };
	return undefined;
}
