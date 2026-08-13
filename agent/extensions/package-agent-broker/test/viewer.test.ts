/**
 * viewer.test.ts — hostile-content-safe rendering, pagination without
 * omission, and exact-match confirmation (#916).
 *
 * The hostile-character set lives in `fixtures/hostile-content.ts` (shared
 * with the #931 conformance suites) so a guard here and a guard there are
 * written against the same characters.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReviewSnapshot, computeProposalDigest } from "../lib/review-snapshot.ts";
import { exactMatch, renderSnapshotPages, visibleEncode } from "../lib/viewer.ts";
import type { DiscoveredProposal } from "../lib/discovery.ts";
import {
  BEL,
  BOM,
  CSI_C1,
  ESC,
  HOSTILE_PROMPT,
  HOSTILE_WRAPPER,
  LRI,
  LS,
  PDI,
  RLO,
  ZWSP,
} from "./fixtures/hostile-content.ts";

function hostileProposal(): DiscoveredProposal {
  return {
    qualifiedId: "git:github.com/psmfd/pi-work-item-client@v1.0.0#work-item-planner",
    packageIdentity: {
      source: "git:github.com/psmfd/pi-work-item-client@v1.0.0",
      host: "github.com",
      path: "psmfd/pi-work-item-client",
      ref: "v1.0.0",
      observedCommit: "a".repeat(40),
    },
    descriptor: {
      schemaVersion: 1,
      name: "work-item-planner",
      description: "d",
      prompt: HOSTILE_PROMPT,
      tools: ["read"],
      model: null,
      guardProfile: null,
      contextPolicy: null,
      environment: {},
    },
    descriptorText: `{"prompt": ${JSON.stringify(HOSTILE_PROMPT)}}`,
    descriptorEvidence: { relPath: "agents/work-item-planner.json", byteLength: 99, sha256: "b".repeat(64) },
    wrapperText: HOSTILE_WRAPPER,
    wrapperEvidence: { relPath: "agents/work-item-planner.md", byteLength: 44, sha256: "c".repeat(64) },
    installRoot: "/tmp/x",
  };
}

test("visibleEncode neutralizes ANSI, C0/C1, bidi, and zero-width characters", () => {
  const encoded = visibleEncode(`${ESC}[31mred${CSI_C1}X${RLO}${LRI}${ZWSP}${BOM}${BEL}${LS}`);
  for (const raw of [ESC, CSI_C1, RLO, LRI, ZWSP, BOM, BEL, LS]) {
    assert.ok(!encoded.includes(raw), `raw U+${(raw.codePointAt(0) as number).toString(16)} leaked`);
  }
  assert.ok(encoded.includes("⟦U+001B⟧"));
  assert.ok(encoded.includes("⟦U+009B⟧"));
  assert.ok(encoded.includes("⟦U+202E⟧"));
  assert.ok(encoded.includes("⟦U+2066⟧"));
  assert.ok(encoded.includes("⟦U+200B⟧"));
  assert.ok(encoded.includes("⟦U+FEFF⟧"));
  assert.ok(encoded.includes("⟦U+0007⟧"));
  assert.ok(encoded.includes("⟦U+2028⟧"));
  assert.ok(encoded.includes("red"));
});

test("extended invisible/format code points are visibly encoded", () => {
  const cases: Array<[string, string]> = [
    ["\u00ad", "\u27e6U+00AD\u27e7"], // soft hyphen
    ["\u180e", "\u27e6U+180E\u27e7"], // Mongolian vowel separator
    ["\u2060", "\u27e6U+2060\u27e7"], // word joiner
    ["\u2062", "\u27e6U+2062\u27e7"], // invisible times
    ["\ufe0f", "\u27e6U+FE0F\u27e7"], // variation selector-16
    ["\u{e0101}", "\u27e6U+E0101\u27e7"], // variation selector supplement
    ["\u{e0041}", "\u27e6U+E0041\u27e7"], // Unicode Tag block (invisible payload channel)
    ["\u034f", "\u27e6U+034F\u27e7"], // combining grapheme joiner
    ["\u061c", "\u27e6U+061C\u27e7"], // Arabic letter mark
  ];
  for (const [raw, expected] of cases) {
    const encoded = visibleEncode(`a${raw}b`);
    assert.ok(!encoded.includes(raw), `raw ${expected} leaked`);
    assert.ok(encoded.includes(expected), `expected ${expected}, got ${JSON.stringify(encoded)}`);
  }
});

test("combining-mark stacking (Zalgo) is bounded", () => {
  const MARK = "\u0301"; // combining acute accent
  const zalgo = "e" + MARK.repeat(40);
  const encoded = visibleEncode(zalgo);
  const rawMarks = encoded.split(MARK).length - 1;
  assert.ok(rawMarks <= 2, `expected the combining run bounded, saw ${rawMarks} raw marks`);
  assert.ok(encoded.includes("\u27e6U+0301\u27e7"));
  // Legitimate composed text with a short mark run is untouched.
  assert.equal(visibleEncode(`e${MARK}`), `e${MARK}`);
  assert.equal(visibleEncode(`cafe${MARK}`), `cafe${MARK}`);
});

test("newlines survive; ordinary unicode passes through", () => {
  assert.equal(visibleEncode("a\nb"), "a\nb");
  assert.equal(visibleEncode("héllo 世界 😀"), "héllo 世界 😀");
});

test("rendered pages contain no raw hostile characters anywhere", () => {
  const p = hostileProposal();
  const snapshot = buildReviewSnapshot(p, null);
  const pages = renderSnapshotPages(snapshot, computeProposalDigest(snapshot));
  const all = pages.join("\n");
  for (const raw of [ESC, CSI_C1, RLO, LRI, PDI, ZWSP, BOM, BEL, LS]) {
    assert.ok(!all.includes(raw), `raw U+${(raw.codePointAt(0) as number).toString(16)} leaked into the rendering`);
  }
});

test("pagination never omits content", () => {
  const p = hostileProposal();
  // Large prompt to force many pages.
  p.descriptor.prompt = Array.from({ length: 500 }, (_, i) => `prompt line ${i}`).join("\n");
  const snapshot = buildReviewSnapshot(p, null);
  const digest = computeProposalDigest(snapshot);
  const pages = renderSnapshotPages(snapshot, digest);
  assert.ok(pages.length > 5);
  const all = pages.join("\n");
  for (let i = 0; i < 500; i++) {
    assert.ok(all.includes(`prompt line ${i}`), `line ${i} missing from pagination`);
  }
  // Byte counts, hashes, and the digest are displayed.
  assert.ok(all.includes(snapshot.descriptorEvidence.sha256));
  assert.ok(all.includes(String(snapshot.descriptorEvidence.byteLength)));
  assert.ok(all.includes(digest));
  // Page markers are sequential and complete.
  for (let i = 1; i <= pages.length; i++) {
    assert.ok(pages[i - 1].startsWith(`[page ${i}/${pages.length}]`));
  }
});

test("very long single lines are wrapped, not truncated", () => {
  const p = hostileProposal();
  p.descriptor.prompt = "x".repeat(5000);
  const snapshot = buildReviewSnapshot(p, null);
  const pages = renderSnapshotPages(snapshot, computeProposalDigest(snapshot));
  const xCount = pages.join("\n").split("x").length - 1;
  assert.ok(xCount >= 5000, `expected all 5000 x's, saw ${xCount}`);
});

test("the non-authorizing banner is the first content shown", () => {
  const p = hostileProposal();
  const snapshot = buildReviewSnapshot(p, null);
  const pages = renderSnapshotPages(snapshot, computeProposalDigest(snapshot));
  assert.ok(pages[0].includes("NON-AUTHORIZING"));
  assert.ok(pages[0].includes("INERT EVIDENCE ONLY"));
});

test("exactMatch requires byte-exact input", () => {
  assert.equal(exactMatch("abc", "abc"), true);
  assert.equal(exactMatch("abc", " abc"), false);
  assert.equal(exactMatch("abc", "abc "), false);
  assert.equal(exactMatch("abc", "ABC"), false);
  assert.equal(exactMatch("abc", undefined), false);
  assert.equal(exactMatch("abc", ""), false);
});
