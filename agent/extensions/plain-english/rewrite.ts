/**
 * plain-english/rewrite.ts — the pure rewrite pipeline.
 *
 * Mechanical masking: YAML frontmatter and fenced code blocks are cut out of
 * the document BEFORE the model call and reinserted verbatim afterwards.
 * Placeholder lines (`<!-- PE-BLOCK-n -->`) mark their positions; the model
 * never sees protected content. A reply that drops, duplicates, reorders into
 * duplication, or edits a placeholder is discarded and the original content
 * is used unchanged (fail-open). This is deliberately stronger than the
 * upstream claudish-to-english plugin, which protects code blocks by prompt
 * instruction only (ADR-0142).
 *
 * No pi runtime imports — `complete()` is injected (auto-router's CompleteFn
 * seam, ADR-0031/0084) so the whole pipeline unit-tests without a network
 * call or extension-deps hydration.
 */

export const PLACEHOLDER = (i: number): string => `<!-- PE-BLOCK-${i} -->`;
const PLACEHOLDER_RE = /<!-- PE-BLOCK-(\d+) -->/g;

/**
 * The rewrite instruction. Adapted from gvzdv/claudish-to-english (MIT,
 * © 2026 Mike Gvozdev) with two additions: the anti-pattern vocabulary from
 * docs-expert `references/style.md` §Claudish / LLM-Prose Anti-Patterns, and
 * an explicit claim-strength preservation clause matching that file's
 * Rewrite Contract.
 */
export const SYSTEM_PROMPT = [
  "You rewrite Markdown prose into plain English.",
  "Remove LLM-prose anti-patterns: hedging stacks, filler transitions, jargon stacking,",
  "marketing adjectives, nominalizations, over-qualification, symmetry padding,",
  "structure for structure's sake, and summary restating.",
  "Keep every fact, name, number, link, and file path.",
  "Preserve claim strength exactly: must/should/may and any stated condition or exception stay as written.",
  "Keep all Markdown structure - headings, lists, tables, and links.",
  "Lines of the form <!-- PE-BLOCK-n --> are placeholders for protected content:",
  "reproduce each one exactly once, in its place, byte for byte.",
  "Use short sentences and everyday words.",
  "Output ONLY the rewritten Markdown, with no preamble, labels, or commentary.",
].join(" ");

export interface MaskedDocument {
  /** Document text with protected segments replaced by placeholder lines. */
  readonly masked: string;
  /** The protected segments, verbatim, indexed by placeholder number. */
  readonly blocks: readonly string[];
}

/**
 * Extract YAML frontmatter and fenced code blocks (``` / ~~~, up to three
 * leading spaces, longer closing fences accepted per CommonMark). An unclosed
 * fence protects through end-of-document. Line-based; CRLF documents keep
 * their line endings inside protected blocks.
 */
export function maskDocument(content: string): MaskedDocument {
  const lines = content.split(/(?<=\n)/); // keep terminators attached
  const blocks: string[] = [];
  const out: string[] = [];
  let i = 0;

  const stash = (segment: string[]): void => {
    const idx = blocks.length;
    blocks.push(segment.join(""));
    const last = segment[segment.length - 1] ?? "";
    out.push(PLACEHOLDER(idx) + (last.endsWith("\n") ? "\n" : ""));
  };

  // Frontmatter: first line exactly `---` closed by a later `---` line.
  if (lines.length > 0 && /^---\r?\n?$/.test(lines[0])) {
    let end = -1;
    for (let j = 1; j < lines.length; j += 1) {
      if (/^---\r?\n?$/.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end !== -1) {
      stash(lines.slice(0, end + 1));
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const open = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (!open) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const fence = open[1];
    const closeRe = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*\r?\n?$`);
    let end = lines.length - 1; // unclosed fence → protect the rest
    for (let j = i + 1; j < lines.length; j += 1) {
      if (closeRe.test(lines[j])) {
        end = j;
        break;
      }
    }
    stash(lines.slice(i, end + 1));
    i = end + 1;
  }

  return { masked: out.join(""), blocks };
}

/** Non-whitespace character count of the masked text, placeholders excluded. */
export function proseChars(masked: string): number {
  return masked.replace(PLACEHOLDER_RE, "").replace(/\s+/g, "").length;
}

/**
 * Reinsert protected blocks into the model's reply. Returns null unless every
 * placeholder appears exactly once and no unknown placeholder was invented —
 * anything else means the model touched what it was told not to.
 */
export function unmaskDocument(rewritten: string, blocks: readonly string[]): string | null {
  const seen = new Map<number, number>();
  for (const m of rewritten.matchAll(PLACEHOLDER_RE)) {
    const idx = Number(m[1]);
    seen.set(idx, (seen.get(idx) ?? 0) + 1);
  }
  if (seen.size !== blocks.length) return null;
  for (let i = 0; i < blocks.length; i += 1) {
    if (seen.get(i) !== 1) return null;
  }
  return rewritten.replace(PLACEHOLDER_RE, (_all, n: string) => {
    // Placeholder carries its own trailing newline in the masked text; the
    // block text already ends how the original ended, so strip nothing here —
    // the replacement swaps the comment line's text portion only.
    const block = blocks[Number(n)];
    return block.endsWith("\n") ? block.slice(0, -1) : block;
  });
}

/** The subset of pi-ai `complete()` this pipeline depends on (injectable for tests). */
export type CompleteFn = (
  model: unknown,
  context: {
    systemPrompt?: string;
    messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>;
  },
  options: { apiKey: string; headers?: Record<string, string> | undefined; signal?: AbortSignal | undefined },
) => Promise<{ stopReason?: string; content: ReadonlyArray<{ type: string; text?: string }> }>;

export type RewriteFailure =
  | "too-large"
  | "too-small"
  | "no-credential"
  | "provider-error"
  | "truncated"
  | "empty"
  | "mask-mismatch";

export type RewriteResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: RewriteFailure };

export interface RewriteDeps {
  readonly completeFn: CompleteFn;
  readonly model: unknown;
  readonly apiKey: string;
  readonly headers?: Record<string, string> | undefined;
  readonly timeoutMs: number;
  readonly minChars: number;
  readonly maxChars: number;
  readonly signal?: AbortSignal | undefined;
}

/** One entry in the model fallback chain (resolved by the caller via the registry). */
export interface ModelCandidate {
  readonly model: unknown;
  readonly apiKey: string;
  readonly headers?: Record<string, string> | undefined;
  /** For once-per-session operator notices, e.g. "omlx/coding-workhorse". */
  readonly label: string;
}

/** Document-property failures — retrying another provider cannot change them. */
const NO_RETRY: ReadonlySet<RewriteFailure> = new Set<RewriteFailure>(["too-small", "too-large"]);

/**
 * Try each candidate in order until one produces a verified rewrite
 * (auto-router's candidate-trial pattern, ADR-0031). Provider-level failures
 * — no credential, provider error, timeout, truncation, empty reply,
 * placeholder mismatch — advance the chain; document-property failures stop
 * it. An empty chain or full exhaustion returns the LAST failure so the
 * caller's fail-open path (write the original, notify once) still holds.
 * Worst-case latency is candidates.length × timeoutMs, bounded by the
 * config-side chain cap.
 */
export async function rewriteWithFallback(
  content: string,
  candidates: readonly ModelCandidate[],
  base: Omit<RewriteDeps, "model" | "apiKey" | "headers">,
): Promise<RewriteResult> {
  let last: RewriteResult = { ok: false, reason: "no-credential" };
  for (const c of candidates) {
    last = await rewriteDocument(content, {
      ...base,
      model: c.model,
      apiKey: c.apiKey,
      headers: c.headers,
    });
    if (last.ok || NO_RETRY.has(last.reason)) return last;
  }
  return last;
}

/**
 * Rewrite one document. Every failure returns `{ok: false}` — the caller
 * writes the ORIGINAL content unchanged. Nothing here throws.
 */
export async function rewriteDocument(content: string, deps: RewriteDeps): Promise<RewriteResult> {
  const { masked, blocks } = maskDocument(content);
  const size = proseChars(masked);
  if (size < deps.minChars) return { ok: false, reason: "too-small" };
  if (masked.length > deps.maxChars) return { ok: false, reason: "too-large" };
  if (!deps.apiKey) return { ok: false, reason: "no-credential" };

  // A ref'd timer, not AbortSignal.timeout(): the latter's internal timer is
  // unref'd, so it neither keeps a draining event loop alive (which broke the
  // test suite under node:test in CI) nor guarantees anything if the provider
  // ignores the signal. The Promise.race below enforces the deadline even
  // against a completeFn that never settles — this hook sits on the write
  // path and must never hang a turn. Late settlement of the losing promise is
  // absorbed by the race (both branches have handlers attached).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, controller.signal])
    : controller.signal;

  let response: Awaited<ReturnType<CompleteFn>>;
  try {
    response = await Promise.race([
      deps.completeFn(
        deps.model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            { role: "user", content: [{ type: "text", text: masked }], timestamp: Date.now() },
          ],
        },
        { apiKey: deps.apiKey, headers: deps.headers, signal },
      ),
      new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error("plain-english: rewrite deadline reached"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch {
    return { ok: false, reason: "provider-error" };
  } finally {
    clearTimeout(timer);
  }

  // A completion cut off by the output-token cap is a half-rewritten document;
  // never use it (upstream's "never write a partial rewrite over real content").
  const stop = response.stopReason ?? "";
  if (stop === "aborted") return { ok: false, reason: "provider-error" };
  if (stop === "length" || stop === "max_tokens" || stop === "maxTokens") {
    return { ok: false, reason: "truncated" };
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (text.length === 0) return { ok: false, reason: "empty" };

  const restored = unmaskDocument(text.endsWith("\n") ? text : `${text}\n`, blocks);
  if (restored === null) return { ok: false, reason: "mask-mismatch" };
  return { ok: true, content: restored };
}
