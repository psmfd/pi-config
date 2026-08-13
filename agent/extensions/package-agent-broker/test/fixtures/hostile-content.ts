/**
 * test/fixtures/hostile-content.ts — the canonical hostile-character set for
 * the package-agent broker suites (#916 origin, consolidated for #931).
 *
 * Package-supplied strings (descriptor prompts, wrapper bodies, file names)
 * are attacker-controlled: a package author chooses every byte the operator
 * sees on the approval screen. These constants are the characters that make a
 * rendered line lie about its own content — terminal control, bidi reordering,
 * and zero-width insertion — plus the composites that combine them.
 *
 * Every character is written as a `\u` escape so this file stays visibly
 * inspectable: a reviewer reading the source sees `\u202e`, not an invisible
 * byte that reorders the line they are reviewing.
 *
 * #931 requires the conformance suites to reuse this set rather than
 * re-invent it. Re-invention is the real risk: a suite that quietly drops
 * bidi, or tests `\u001b` alone, reports the same green as one that covers
 * the class, while guarding strictly less.
 *
 * Not exhaustive by construction — it is the set the broker's guards are
 * written against. Adding a character here without a matching assertion adds
 * no coverage; add both or neither.
 *
 * Deliberately NOT migrated: single inline escapes used as one-off literals
 * inside test data (`input-router.test.ts`, `descriptor.test.ts`). Importing a
 * name to stand in for one `\u0007` inside a string costs readability and buys
 * nothing — those are values under test, not a shared vocabulary.
 */

// --- Terminal control ------------------------------------------------------

/** C0 escape — introduces ANSI sequences (cursor moves, screen clears, SGR). */
export const ESC = "\u001b";
/** C1 control sequence introducer — the single-byte equivalent of `ESC [`. */
export const CSI_C1 = "\u009b";
/** C0 bell — audible/visual terminal signal, invisible in the rendered line. */
export const BEL = "\u0007";

// --- Bidi reordering -------------------------------------------------------

/** Right-to-left override — reverses subsequent display order. */
export const RLO = "\u202e";
/** Left-to-right isolate — opens an isolated run. */
export const LRI = "\u2066";
/** Pop directional isolate — closes the innermost isolate. */
export const PDI = "\u2069";

// --- Zero-width and line-structure -----------------------------------------

/** Zero-width space — splits a token without visible width. */
export const ZWSP = "\u200b";
/** Zero-width no-break space / BOM — invisible, survives naive trimming. */
export const BOM = "\ufeff";
/** Line separator — a line break many renderers honour but `\n` splits miss. */
export const LS = "\u2028";

// --- Composites ------------------------------------------------------------

/**
 * A prompt that tries to clear the screen, reorder its own text, and hide a
 * token — the shape a hostile descriptor uses to make the approval screen
 * show something other than what will be granted.
 */
export const HOSTILE_PROMPT = `Ignore prior text.${ESC}[2J${ESC}[H${RLO}HIDDEN${LRI}x${PDI} done${ZWSP}.`;

/**
 * A wrapper body carrying the characters `HOSTILE_PROMPT` does not: the C1
 * introducer, a bell, a non-`\n` line break, and a BOM.
 */
export const HOSTILE_WRAPPER = `wrapper with ${CSI_C1}31m C1 CSI, ${BEL} bell, ${LS} line-sep, and ${BOM} BOM`;

/**
 * Every character above, for assertions that must hold across the whole class
 * (e.g. "no raw hostile character survives into an audit record"). Table-driven
 * callers get a name in the failure message instead of an invisible byte.
 */
export const HOSTILE_CHARACTERS: ReadonlyArray<{ readonly name: string; readonly char: string }> = [
  { name: "ESC", char: ESC },
  { name: "CSI_C1", char: CSI_C1 },
  { name: "BEL", char: BEL },
  { name: "RLO", char: RLO },
  { name: "LRI", char: LRI },
  { name: "PDI", char: PDI },
  { name: "ZWSP", char: ZWSP },
  { name: "BOM", char: BOM },
  { name: "LS", char: LS },
];
