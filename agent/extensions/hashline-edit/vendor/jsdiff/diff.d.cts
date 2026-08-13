/**
 * Type declarations for the vendored jsdiff 8.0.2 UMD bundle
 * (vendor/jsdiff/diff.cjs, BSD-3-Clause — see LICENSE and CHECKSUMS).
 *
 * The UMD wrapper defeats Node's CJS named-export lexer, so the bundle is
 * consumed via default-import interop (`module.exports` object) through the
 * typed ESM wrapper in index.ts — never imported with named imports directly.
 * Only the functions this extension actually consumes are declared.
 */

export interface ChangeObject {
	value: string;
	added?: boolean;
	removed?: boolean;
	count?: number;
}

export interface StructuredPatchHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

export interface StructuredPatch {
	oldFileName: string;
	newFileName: string;
	oldHeader: string;
	newHeader: string;
	hunks: StructuredPatchHunk[];
}

declare const jsdiff: {
	diffLines(oldStr: string, newStr: string): ChangeObject[];
	structuredPatch(
		oldFileName: string,
		newFileName: string,
		oldStr: string,
		newStr: string,
		oldHeader?: string,
		newHeader?: string,
		options?: { context?: number },
	): StructuredPatch;
	applyPatch(
		source: string,
		patch: string | StructuredPatch | StructuredPatch[],
		options?: { fuzzFactor?: number },
	): string | false;
};

export default jsdiff;
