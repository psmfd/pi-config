/**
 * Typed ESM wrapper over the vendored jsdiff 8.0.2 UMD bundle (patch #1 —
 * replaces the npm `diff` dependency; see PATCH_MANIFEST.json).
 *
 * The UMD wrapper pattern defeats Node's CJS named-export lexer, so named
 * imports from diff.js fail under an ESM loader. Default-import interop
 * (`module.exports` object) works under both tsx (tests) and jiti (pi
 * runtime); this wrapper re-exports the three consumed functions with types
 * from diff.d.ts.
 */

import jsdiff from "./diff.cjs";

export type { ChangeObject, StructuredPatch, StructuredPatchHunk } from "./diff.cjs";

export const diffLines = jsdiff.diffLines.bind(jsdiff);
export const structuredPatch = jsdiff.structuredPatch.bind(jsdiff);
export const applyPatch = jsdiff.applyPatch.bind(jsdiff);
