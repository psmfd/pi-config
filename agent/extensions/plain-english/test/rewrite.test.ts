/** Tests for plain-english/rewrite.ts — masking round-trip and the fail-open pipeline. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  maskDocument,
  PLACEHOLDER,
  proseChars,
  rewriteDocument,
  rewriteWithFallback,
  SYSTEM_PROMPT,
  unmaskDocument,
  type CompleteFn,
  type ModelCandidate,
  type RewriteDeps,
} from "../rewrite.ts";

const DOC = [
  "---",
  "title: sample",
  "---",
  "",
  "# Heading",
  "",
  "It is worth noting that this paragraph is generally speaking quite hedged.",
  "",
  "```bash",
  'echo "do not touch"',
  "```",
  "",
  "Closing prose.",
  "",
].join("\n");

function deps(overrides: Partial<RewriteDeps> = {}): RewriteDeps {
  const echo: CompleteFn = async (_m, ctx) => ({
    stopReason: "stop",
    content: [{ type: "text", text: ctx.messages[0].content[0].text }],
  });
  return {
    completeFn: echo,
    model: { id: "fake" },
    apiKey: "key",
    timeoutMs: 5_000,
    minChars: 10,
    maxChars: 60_000,
    ...overrides,
  };
}

test("maskDocument: frontmatter and fences become placeholders", () => {
  const { masked, blocks } = maskDocument(DOC);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].startsWith("---\ntitle: sample"));
  assert.ok(blocks[1].includes('echo "do not touch"'));
  assert.ok(masked.includes(PLACEHOLDER(0)));
  assert.ok(masked.includes(PLACEHOLDER(1)));
  assert.ok(!masked.includes("do not touch"));
  assert.ok(masked.includes("# Heading"));
});

test("maskDocument: unclosed fence protects to end of document", () => {
  const { masked, blocks } = maskDocument("intro\n```\ncode forever\nmore code\n");
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes("code forever"));
  assert.ok(!masked.includes("code forever"));
});

test("maskDocument: tilde fences and longer closers", () => {
  const { blocks } = maskDocument("~~~text\nblock\n~~~~\nafter\n");
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes("block"));
});

test("mask → unmask round-trip restores the original document", () => {
  const { masked, blocks } = maskDocument(DOC);
  assert.equal(unmaskDocument(masked, blocks), DOC);
});

test("unmaskDocument: dropped, duplicated, or invented placeholders → null", () => {
  const { masked, blocks } = maskDocument(DOC);
  assert.equal(unmaskDocument(masked.replace(PLACEHOLDER(1), ""), blocks), null);
  assert.equal(unmaskDocument(`${masked}\n${PLACEHOLDER(1)}`, blocks), null);
  assert.equal(unmaskDocument(`${masked}\n${PLACEHOLDER(9)}`, blocks), null);
});

test("proseChars: placeholders and whitespace excluded", () => {
  const { masked } = maskDocument(DOC);
  const n = proseChars(masked);
  assert.ok(n > 0);
  assert.ok(!Number.isNaN(n));
  assert.equal(proseChars(`${PLACEHOLDER(0)}\n  \n`), 0);
});

test("rewriteDocument: success path rewrites prose, restores blocks", async () => {
  const fn: CompleteFn = async (_m, ctx) => ({
    stopReason: "stop",
    content: [
      {
        type: "text",
        text: ctx.messages[0].content[0].text.replace(
          "It is worth noting that this paragraph is generally speaking quite hedged.",
          "This paragraph is hedged.",
        ),
      },
    ],
  });
  const res = await rewriteDocument(DOC, deps({ completeFn: fn }));
  assert.ok(res.ok);
  if (res.ok) {
    assert.ok(res.content.includes("This paragraph is hedged."));
    assert.ok(res.content.includes('echo "do not touch"'));
    assert.ok(res.content.includes("title: sample"));
    assert.ok(!res.content.includes("PE-BLOCK"));
  }
});

test("rewriteDocument: system prompt reaches the model", async () => {
  let seenSystem = "";
  const fn: CompleteFn = async (_m, ctx) => {
    seenSystem = ctx.systemPrompt ?? "";
    return { stopReason: "stop", content: [{ type: "text", text: ctx.messages[0].content[0].text }] };
  };
  await rewriteDocument(DOC, deps({ completeFn: fn }));
  assert.equal(seenSystem, SYSTEM_PROMPT);
});

test("rewriteDocument: fail-open reasons", async () => {
  const throwing: CompleteFn = async () => {
    throw new Error("network down");
  };
  assert.deepEqual(await rewriteDocument(DOC, deps({ completeFn: throwing })), {
    ok: false,
    reason: "provider-error",
  });

  const truncated: CompleteFn = async () => ({
    stopReason: "length",
    content: [{ type: "text", text: "partial" }],
  });
  assert.deepEqual(await rewriteDocument(DOC, deps({ completeFn: truncated })), {
    ok: false,
    reason: "truncated",
  });

  const empty: CompleteFn = async () => ({ stopReason: "stop", content: [] });
  assert.deepEqual(await rewriteDocument(DOC, deps({ completeFn: empty })), {
    ok: false,
    reason: "empty",
  });

  const mangling: CompleteFn = async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: "rewrote everything, placeholders gone" }],
  });
  assert.deepEqual(await rewriteDocument(DOC, deps({ completeFn: mangling })), {
    ok: false,
    reason: "mask-mismatch",
  });

  assert.deepEqual(await rewriteDocument(DOC, deps({ apiKey: "" })), {
    ok: false,
    reason: "no-credential",
  });
  assert.deepEqual(await rewriteDocument("tiny\n", deps()), { ok: false, reason: "too-small" });
  assert.deepEqual(await rewriteDocument(DOC, deps({ maxChars: 50 })), {
    ok: false,
    reason: "too-large",
  });
});

test("rewriteWithFallback: provider failure advances to the next candidate", async () => {
  const calls: string[] = [];
  const flaky: CompleteFn = async (model, ctx) => {
    const label = (model as { id: string }).id;
    calls.push(label);
    if (label === "primary") throw new Error("connection refused");
    return { stopReason: "stop", content: [{ type: "text", text: ctx.messages[0].content[0].text }] };
  };
  const candidates: ModelCandidate[] = [
    { model: { id: "primary" }, apiKey: "k1", label: "omlx/primary" },
    { model: { id: "backup" }, apiKey: "k2", label: "cloud/backup" },
  ];
  const res = await rewriteWithFallback(DOC, candidates, {
    completeFn: flaky,
    timeoutMs: 5_000,
    minChars: 10,
    maxChars: 60_000,
  });
  assert.ok(res.ok);
  assert.deepEqual(calls, ["primary", "backup"]);
});

test("rewriteWithFallback: document-property failures do not retry", async () => {
  const calls: string[] = [];
  const counting: CompleteFn = async (model, ctx) => {
    calls.push((model as { id: string }).id);
    return { stopReason: "stop", content: [{ type: "text", text: ctx.messages[0].content[0].text }] };
  };
  const candidates: ModelCandidate[] = [
    { model: { id: "a" }, apiKey: "k", label: "a/a" },
    { model: { id: "b" }, apiKey: "k", label: "b/b" },
  ];
  const res = await rewriteWithFallback("tiny\n", candidates, {
    completeFn: counting,
    timeoutMs: 5_000,
    minChars: 200,
    maxChars: 60_000,
  });
  assert.deepEqual(res, { ok: false, reason: "too-small" });
  assert.deepEqual(calls, []); // size gate fires before any model call
});

test("rewriteWithFallback: exhausted chain returns the last failure; empty chain → no-credential", async () => {
  const throwing: CompleteFn = async () => {
    throw new Error("down");
  };
  const base = { completeFn: throwing, timeoutMs: 5_000, minChars: 10, maxChars: 60_000 };
  const candidates: ModelCandidate[] = [
    { model: { id: "a" }, apiKey: "k", label: "a/a" },
    { model: { id: "b" }, apiKey: "k", label: "b/b" },
  ];
  assert.deepEqual(await rewriteWithFallback(DOC, candidates, base), {
    ok: false,
    reason: "provider-error",
  });
  assert.deepEqual(await rewriteWithFallback(DOC, [], base), {
    ok: false,
    reason: "no-credential",
  });
});

test("rewriteDocument: deadline fails open even when the provider ignores the signal", async () => {
  // Never settles and never looks at opts.signal — the worst-case provider.
  // The internal ref'd timer + Promise.race must still unblock the call.
  const hang: CompleteFn = () => new Promise(() => {});
  const res = await rewriteDocument(DOC, deps({ completeFn: hang, timeoutMs: 200 }));
  assert.deepEqual(res, { ok: false, reason: "provider-error" });
});

test("rewriteDocument: caller abort fails open immediately", async () => {
  const hang: CompleteFn = () => new Promise(() => {});
  const res = await rewriteDocument(
    DOC,
    deps({ completeFn: hang, timeoutMs: 30_000, signal: AbortSignal.abort() }),
  );
  assert.deepEqual(res, { ok: false, reason: "provider-error" });
});
