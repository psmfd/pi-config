/**
 * viewer.ts — pure snapshot rendering for the TUI review flow (#916).
 *
 * Produces plain-text pages; index.ts drives the dialogs. Requirements:
 *   - ANSI escapes, C0/C1 controls, bidi controls, and other non-printable
 *     characters are VISIBLY encoded (never emitted raw to the terminal);
 *   - fields are delineated; byte counts, source hashes, and the proposal
 *     digest are shown;
 *   - pagination never omits content;
 *   - the final confirmation requires retyping the exact qualified identity
 *     and digest (checked by exactMatch, no trimming or case folding).
 */

import type { ReviewSnapshot } from "../../shared/package-agent-review-contract.ts";
import type { EffectiveDefinition } from "../../shared/package-agent-grant-contract.ts";

export const PAGE_LINES = 24;
export const WRAP_COLUMNS = 100;

/** Maximum consecutive combining marks rendered raw before visible encoding
 * kicks in (bounds "Zalgo" stacking without mangling legitimate text). */
const MAX_COMBINING_RUN = 2;

const COMBINING_RE = /\p{M}/u;
const FORMAT_RE = /\p{Cf}/u; // soft hyphen, ALM, word joiner, invisible ops, tags, …

/**
 * Visibly encode every character that could alter terminal rendering or
 * reading order. Escaped as `⟦U+XXXX⟧` so the operator sees exactly what the
 * bytes contain. Printable ASCII and non-hostile Unicode pass through.
 *
 * Coverage: C0/C1 controls and DEL; line/paragraph separators; the entire
 * Unicode Cf (format) category — which includes the soft hyphen, bidi
 * embeddings/overrides/isolates, zero-width characters, word joiner and
 * invisible operators, interlinear annotation, and the invisible Tag block
 * (U+E0000–E007F) — plus BOM, variation selectors (U+FE00–FE0F,
 * U+E0100–E01EF), the combining grapheme joiner, and combining-mark runs
 * beyond MAX_COMBINING_RUN (anti-Zalgo bound; short runs render normally so
 * legitimate composed text is untouched).
 */
export function visibleEncode(text: string): string {
  let out = "";
  let combiningRun = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const isCombining = COMBINING_RE.test(ch);
    // Lone surrogates: `for...of` yields an unpaired surrogate as its own
    // unit. The canonical encoder refuses these outright, but `list` skip
    // reasons come from on-disk names that never reach a digest, so encode
    // them here too — "every hostile character is visibly encoded" must hold
    // on every path, not only digested ones.
    const isLoneSurrogate = cp >= 0xd800 && cp <= 0xdfff;
    const hostile =
      isLoneSurrogate ||
      cp < 0x20 && cp !== 0x0a // C0 (newline handled by pagination)
      || cp === 0x7f
      || (cp >= 0x80 && cp <= 0x9f) // C1 (covers 0x9b CSI)
      || cp === 0x2028 || cp === 0x2029 // line/paragraph separators
      || FORMAT_RE.test(ch) // Unicode Cf: bidi, zero-width, tags, SHY, …
      || cp === 0xfeff // BOM / zero-width no-break space
      || (cp >= 0xfff9 && cp <= 0xfffb) // interlinear annotation
      || (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
      || (cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
      || cp === 0x034f // combining grapheme joiner
      || (isCombining && combiningRun >= MAX_COMBINING_RUN); // Zalgo bound
    combiningRun = isCombining ? combiningRun + 1 : 0;
    if (cp === 0x0a) {
      out += "\n";
    } else if (hostile) {
      out += `⟦U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟧`;
    } else {
      out += ch;
    }
  }
  return out;
}

function wrapLine(line: string): string[] {
  if (line.length <= WRAP_COLUMNS) return [line];
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += WRAP_COLUMNS) {
    parts.push(line.slice(i, i + WRAP_COLUMNS));
  }
  return parts;
}

function section(title: string, lines: string[]): string[] {
  return [`━━ ${title} ━━`, ...lines, ""];
}

function textBlock(label: string, text: string | null, byteLength: number | null): string[] {
  if (text === null) return [`${label}: (absent)`];
  const header = byteLength === null ? `${label}:` : `${label} (${byteLength} bytes):`;
  const encoded = visibleEncode(text);
  const body = encoded.split("\n").flatMap((l) => wrapLine(`  │ ${l}`));
  return [header, ...body];
}

/**
 * Render the complete snapshot into ordered pages. All content is included;
 * no truncation, no sampling.
 */
export function renderSnapshotPages(snapshot: ReviewSnapshot, proposalDigest: string): string[] {
  const lines: string[] = [];

  lines.push(
    ...section("Package-agent review — NON-AUTHORIZING draft", [
      "Recording this review creates INERT EVIDENCE ONLY.",
      "It cannot activate an agent; #917 requires a fresh approval with",
      "complete provenance before any active grant can exist.",
    ]),
  );

  lines.push(
    ...section("Identity", [
      `Qualified id:    ${visibleEncode(snapshot.qualifiedId)}`,
      `Agent name:      ${visibleEncode(snapshot.agentName)}`,
      `Proposed alias:  ${snapshot.proposedAlias === null ? "(none)" : visibleEncode(snapshot.proposedAlias)}`,
      `Package source:  ${visibleEncode(snapshot.packageIdentity.source)}`,
      `Pinned ref:      ${visibleEncode(snapshot.packageIdentity.ref)}`,
      `Observed commit: ${snapshot.packageIdentity.observedCommit ?? "(unreadable — evidence only)"}`,
    ]),
  );

  lines.push(
    ...section("Source evidence", [
      `Descriptor: ${visibleEncode(snapshot.descriptorEvidence.relPath)}`,
      `  bytes:  ${snapshot.descriptorEvidence.byteLength}`,
      `  sha256: ${snapshot.descriptorEvidence.sha256}`,
      ...(snapshot.wrapperEvidence
        ? [
            `Wrapper: ${visibleEncode(snapshot.wrapperEvidence.relPath)}`,
            `  bytes:  ${snapshot.wrapperEvidence.byteLength}`,
            `  sha256: ${snapshot.wrapperEvidence.sha256}`,
          ]
        : ["Wrapper: (absent)"]),
    ]),
  );

  lines.push(
    ...section("Requested policy", [
      `Tools (${snapshot.requestedTools.length}): ${snapshot.requestedTools.map(visibleEncode).join(", ")}`,
      `Model policy:   ${snapshot.modelPolicy === null ? "(none)" : visibleEncode(snapshot.modelPolicy)}`,
      `Guard policy:   ${snapshot.guardPolicy === null ? "(none)" : visibleEncode(snapshot.guardPolicy)}`,
      `Context policy: ${snapshot.contextPolicy === null ? "(none)" : visibleEncode(snapshot.contextPolicy)}`,
      ...Object.entries(snapshot.environmentPolicy).map(
        ([k, v]) => `Env ${visibleEncode(k)} = ${visibleEncode(v)}`,
      ),
    ]),
  );

  lines.push(
    ...section("Unresolved provenance (kept unresolved by design)", [
      ...snapshot.unresolvedProvenance.map((f) => `  - ${f}`),
      "These fields keep this record non-authorizing (ADR-0128).",
    ]),
  );

  lines.push(...section("Complete prompt", textBlock("Prompt", snapshot.promptText, null)));
  lines.push(
    ...section(
      "Exact descriptor bytes",
      textBlock("Descriptor", snapshot.descriptorText, snapshot.descriptorEvidence.byteLength),
    ),
  );
  if (snapshot.wrapperText !== null && snapshot.wrapperEvidence !== null) {
    lines.push(
      ...section(
        "Exact wrapper bytes",
        textBlock("Wrapper", snapshot.wrapperText, snapshot.wrapperEvidence.byteLength),
      ),
    );
  }

  lines.push(
    ...section("Proposal digest", [
      `sha256: ${proposalDigest}`,
      "Confirmation requires retyping the qualified id and this digest.",
    ]),
  );

  const wrapped = lines.flatMap(wrapLine);
  const pages: string[] = [];
  for (let i = 0; i < wrapped.length; i += PAGE_LINES) {
    pages.push(wrapped.slice(i, i + PAGE_LINES).join("\n"));
  }
  const total = pages.length;
  return pages.map((p, i) => `[page ${i + 1}/${total}]\n${p}`);
}

/**
 * Render the complete reconstructed effective definition for the #928
 * approval flow.
 *
 * `priorReviewNote` is DISPLAY CONTEXT ONLY — at most a line saying the
 * operator reviewed this identity before. It is rendered under a heading that
 * says so, and it shortens nothing: every page, both retypes, and the
 * display-to-commit recheck run identically whether or not a draft exists.
 */
/** One asset-tree entry as displayed in the approval pages (#930, D1). */
export interface DisplayAssetEntry {
  relPath: string;
  kind: "file" | "symlink";
  detail: string;
}

export function renderGrantPages(
  def: EffectiveDefinition,
  grantDigest: string,
  priorReviewNote: string | null,
  assetEntries: readonly DisplayAssetEntry[] | null = null,
): string[] {
  const lines: string[] = [];

  lines.push(
    ...section("Package-agent approval — CREATES ACTIVE AUTHORITY", [
      "Approving this creates a runtime-scoped active grant: this agent",
      "becomes dispatchable in THIS pi process until it expires, is revoked,",
      "or the process exits. Authority is held in memory only and is never",
      "written to disk (ADR-0129).",
      `Expires: ${new Date(def.expiresAtMs).toISOString()} (absolute, from approval)`,
      def.clockSuspendInclusive
        ? "Expiry clock: verified suspend-inclusive."
        : "Expiry clock: NOT yet verified suspend-inclusive — dispatch must refuse this grant until #929 lands.",
    ]),
  );

  if (priorReviewNote !== null) {
    lines.push(
      ...section("Prior review (context only — satisfies nothing)", [
        visibleEncode(priorReviewNote),
        "A review draft is permanently non-authorizing. It has not shortened,",
        "pre-filled, or satisfied any part of this approval.",
      ]),
    );
  }

  if (assetEntries !== null) {
    // The grant digest binds the FULL package tree the sandboxed child can
    // read (ADR-0131 D1) — so the operator sees every bound entry, not only
    // a hash (2026-07-31 security review: displayed review must cover the
    // digest's bound scope).
    lines.push(
      ...section(`Asset tree bound into the grant (${assetEntries.length} entries)`, [
        "Every entry below is readable by the dispatched child and bound by",
        "the grant digest; changing any of them invalidates the grant.",
        ...assetEntries.map(
          (e) => `${e.kind === "symlink" ? "link" : "file"} ${visibleEncode(e.relPath)} ${visibleEncode(e.detail)}`,
        ),
      ]),
    );
  }

  lines.push(
    ...section("Identity", [
      `Qualified id:   ${visibleEncode(def.qualifiedId)}`,
      `Agent name:     ${visibleEncode(def.agentName)}`,
      `Local alias:    ${def.alias === null ? "(none)" : visibleEncode(def.alias)}`,
      `Package source: ${visibleEncode(def.packageIdentity.source)}`,
      `Pinned ref:     ${visibleEncode(def.packageIdentity.ref)}`,
      `Resolved commit: ${def.resolvedCommit}`,
      `Asset tree digest: ${def.assetTreeDigest}`,
    ]),
  );

  lines.push(
    ...section("Resolved provenance (all six #916 gaps closed)", [
      `Runner path:    ${visibleEncode(def.runner.path)}`,
      `Runner bytes:   ${def.runner.byteLength}`,
      `Runner sha256:  ${def.runner.sha256}`,
      `Argv template:  ${def.argvPolicy.template.map(visibleEncode).join(" ")}`,
      `Isolation:      ${def.argvPolicy.isolation.join(" ")}`,
      `Extension closure: ${def.extensionClosure.mode} (${def.extensionClosure.entries.length} entries)`,
      `Module closure:    ${def.moduleClosure.mode} (${def.moduleClosure.entries.length} entries)`,
      `Event handlers:    ${def.eventHandlerSet.mode} (${def.eventHandlerSet.handlers.length} handlers)`,
      ...def.effectiveTools.map(
        (t) => `Tool ${visibleEncode(t.name)} — ${t.provenance}, impl ${t.implementationDigest}`,
      ),
    ]),
  );

  lines.push(
    ...section("Policy", [
      `Model policy:   ${def.modelPolicy === null ? "(none)" : visibleEncode(def.modelPolicy)}`,
      `Guard policy:   ${def.guardPolicy === null ? "(none)" : visibleEncode(def.guardPolicy)}`,
      `Context policy: ${def.contextPolicy === null ? "(none)" : visibleEncode(def.contextPolicy)}`,
      ...Object.entries(def.environmentPolicy).map(
        ([k, v]) => `Env ${visibleEncode(k)} = ${visibleEncode(v)}`,
      ),
    ]),
  );

  lines.push(
    ...section("Approval instance", [
      `Runtime instance: ${def.approval.runtimeInstanceId}`,
      `Approval sequence: ${def.approval.sequence}`,
      `Nonce: ${def.nonce}`,
    ]),
  );

  lines.push(...section("Complete prompt", textBlock("Prompt", def.promptText, null)));
  lines.push(
    ...section(
      "Exact descriptor bytes",
      textBlock("Descriptor", def.descriptorText, def.descriptorEvidence.byteLength),
    ),
  );
  if (def.wrapperText !== null && def.wrapperEvidence !== null) {
    lines.push(
      ...section(
        "Exact wrapper bytes",
        textBlock("Wrapper", def.wrapperText, def.wrapperEvidence.byteLength),
      ),
    );
  }

  lines.push(
    ...section("Grant digest", [
      `sha256: ${grantDigest}`,
      "Confirmation requires retyping the qualified id and this digest.",
    ]),
  );

  const wrapped = lines.flatMap(wrapLine);
  const pages: string[] = [];
  for (let i = 0; i < wrapped.length; i += PAGE_LINES) {
    pages.push(wrapped.slice(i, i + PAGE_LINES).join("\n"));
  }
  const total = pages.length;
  return pages.map((p, i) => `[page ${i + 1}/${total}]\n${p}`);
}

/** Exact string match: no trimming, no case folding, no normalization. */
export function exactMatch(expected: string, typed: string | undefined): boolean {
  return typeof typed === "string" && typed === expected;
}
