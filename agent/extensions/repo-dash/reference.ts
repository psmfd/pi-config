/**
 * Reference-into-prompt text construction (ADR-0137, #981).
 *
 * Pure string helpers, deliberately free of any pi or TUI dependency so the
 * behaviour that matters to the operator — what actually lands in the editor —
 * is unit-testable without a terminal.
 */

/** Longest title fragment carried into a reference before ellipsis. */
const TITLE_LIMIT = 80;

/**
 * Invisible format characters (Unicode general category `Cf`).
 *
 * This one property covers every class #989 named, which is why the rule is a
 * category test rather than a hand-kept range list: the bidi overrides and
 * isolates of the Trojan-Source class (U+202A–202E, U+2066–2069, plus the
 * U+061C/200E/200F marks), the zero-width and default-ignorable formats
 * (U+200B, U+00AD, U+2060, U+FEFF, U+180E, U+FFF9–FFFB …), and the whole
 * Unicode Tag block (U+E0001, U+E0020–E007F) used for ASCII smuggling are all
 * exactly `Cf`. An enumeration would restate that set less accurately and go
 * stale on the next Unicode revision.
 *
 * A property escape is not what `no-control-regex` objects to — that rule
 * targets literal control escapes in a character class, which is the form the
 * C0/C1 scan below still deliberately avoids.
 */
const FORMAT = /\p{Cf}/u;

/**
 * Combining marks, capped rather than stripped.
 *
 * Diacritics are ordinary title content in Vietnamese, Devanagari, and much
 * else, so these cannot be removed outright — but an unbounded run stacks
 * vertically out of its cell and wrecks the panel row ("Zalgo"). A per-base
 * run cap keeps legitimate accents and defuses the pathological case.
 */
const MARK = /\p{Mn}|\p{Mc}|\p{Me}/u;
const MAX_MARK_RUN = 4;

/**
 * Zero-width joiners, deliberately preserved.
 *
 * Both are `Cf` and would otherwise be deleted by the rule above. ZWJ composes
 * emoji sequences (family and profession glyphs) and ZWNJ is orthographically
 * required in Persian and the Brahmic scripts. Neither can forge structure nor
 * hide an ASCII payload on its own, so deleting them would break real titles
 * for no gain.
 */
const KEEP_FORMAT = new Set(["\u200C", "\u200D"]);

/**
 * Remove anything that could move the cursor, hide a payload, or reorder text.
 *
 * Written as an explicit code-point scan rather than a regex character class:
 * the class form requires literal control escapes in the source, which is both
 * lint-hostile (`no-control-regex`) and easy to corrupt in transit. This form
 * has no escapes to get wrong and states the intent directly.
 *
 * Controls become spaces because they usually sit between words; format
 * characters are *deleted*, because they are zero-width by definition and a
 * space would open a visible gap where the author intended none — and because
 * deletion lets an all-invisible title collapse to empty, which
 * `formatReference` already degrades to a bare `#<number>`.
 *
 * Not handled here, deliberately: U+2028/U+2029 and U+FEFF need no case of
 * their own because JavaScript's `\s` already matches them, so the collapse
 * below folds them into a single space. Do not "optimize" that regex without
 * re-reading this.
 */
export function stripUnsafe(value: string): string {
  let out = "";
  let markRun = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += " ";
      markRun = 0;
      continue;
    }
    // Deleted outright, and without resetting the run counter: an invisible
    // character between two marks must not buy the attacker a fresh cap.
    if (FORMAT.test(ch) && !KEEP_FORMAT.has(ch)) continue;
    if (MARK.test(ch)) {
      if (markRun >= MAX_MARK_RUN) continue;
      markRun += 1;
      out += ch;
      continue;
    }
    markRun = 0;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Collapse a GitHub title to a single bounded line.
 *
 * GitHub titles are untrusted, operator-visible content: they may contain
 * newlines, control characters, ANSI escapes, bidi overrides, or invisible
 * payloads. A reference is written straight into the editor buffer — which the
 * operator usually submits verbatim — so anything that could move the cursor,
 * forge additional prompt lines, reorder what is rendered, or smuggle text past
 * the operator's eye into the model's input is removed here rather than
 * trusted. This is the same untrusted-content posture ADR-0123 applies to the
 * model-facing readers, carried to the operator-facing path.
 *
 * Bounding happens after stripping, and on code points rather than UTF-16 code
 * units. Both orderings matter. Stripping first spends the budget on visible
 * content instead of invisible payload, and guarantees no half of a bidi pair
 * survives into the slice to leak direction state into the rest of the buffer.
 * Counting code points keeps `.slice` from severing a surrogate pair and
 * emitting a lone surrogate (#989).
 *
 * Two residual risks are accepted rather than coded around, because neither is
 * fixable by a stripper:
 *
 * - The surrounding quotes in `formatReference` are presentation, not a
 *   boundary. `"` is legitimate title content and is not removed, so a title
 *   containing one breaks the visual quoting. Nothing parses this string, so
 *   this is cosmetic — equivalent to any untrusted text the operator pastes.
 * - Strong-RTL script content still drives the terminal's implicit bidi
 *   algorithm without any override character present. Stripping that would
 *   break every legitimate RTL title.
 *
 * Homoglyph and confusable detection is deliberately NOT performed, and NFKC
 * normalization is deliberately NOT applied. NFKC does not address confusables
 * at all — Cyrillic and Latin lookalikes have no compatibility decomposition
 * relating them — while being lossy in ways that corrupt legitimate titles
 * (fullwidth punctuation, ligatures, superscripts). It would trade real damage
 * for no mitigation. Genuine anti-spoofing is UTS-39 mixed-script detection
 * with an explicit restriction level: a separate feature with its own policy
 * decision, not something to fold silently into a display sanitizer.
 */
export function sanitizeTitle(title: string): string {
  const flattened = stripUnsafe(title);
  const points = Array.from(flattened);
  if (points.length <= TITLE_LIMIT) return flattened;
  const kept = points.slice(0, TITLE_LIMIT - 1);
  // A cut landing mid-cluster would otherwise hang the base character's accents
  // onto the ellipsis.
  while (kept.length > 0 && MARK.test(kept[kept.length - 1] ?? "")) kept.pop();
  return `${kept.join("").trimEnd()}…`;
}

/**
 * Build the reference text for an item.
 *
 * `#<number>` is unambiguous within a repository — GitHub shares one numbering
 * space across issues and pull requests — so the same shape serves both panels.
 * The title rides along so the model gets usable context without a tool call.
 */
export function formatReference(number: number, title: string): string {
  const clean = sanitizeTitle(title);
  return clean.length > 0 ? `#${number} "${clean}"` : `#${number}`;
}

/**
 * Build the reference text for a workflow run (#987).
 *
 * Keyed on the run **id**, never `run_number`, for two independent reasons:
 *
 * 1. `run_number` is scoped per workflow, not per repository — each workflow
 *    keeps its own counter, so two runs of different workflows collide on the
 *    same number as a matter of course. `#N` would be ambiguous even before
 *    considering that it also collides with the issue/PR numbering space.
 * 2. It is the wrong key downstream. `github-read`'s Actions `run` operation
 *    builds `actions/runs/{id}`, so a reference carrying `run_number` would
 *    send a follow-up lookup to a different run or a 404 — a silent
 *    correctness bug rather than a cosmetic one.
 *
 * The `run <id>` handle deliberately mirrors the shape of `#<number>` rather
 * than emitting a URL: it stays short, it reads as a handle, and the title
 * rides along for context exactly as it does for issues and pull requests.
 */
export function formatRunReference(id: number, displayTitle: string): string {
  const clean = sanitizeTitle(displayTitle);
  return clean.length > 0 ? `run ${id} "${clean}"` : `run ${id}`;
}

/**
 * Append a reference to the editor's current contents.
 *
 * `ctx.ui.setEditorText` replaces the whole buffer, so callers must read the
 * current text and hand it here rather than assuming an empty editor —
 * otherwise summoning a panel mid-sentence would silently discard what the
 * operator had already typed.
 */
export function appendReference(current: string, reference: string): string {
  if (current.length === 0) return reference;
  return /\s$/.test(current) ? `${current}${reference}` : `${current} ${reference}`;
}
