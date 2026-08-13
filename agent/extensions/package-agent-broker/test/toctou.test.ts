/**
 * toctou.test.ts — structural conformance for the verify-then-exec window
 * (#931, ADR-0131 Decision 9).
 *
 * The behavioural TOCTOU cases live beside the rigs that can express them:
 *
 *   - display-to-commit (approval)  -> `approve-flow.test.ts`, via the
 *     `beforeInput` seam, guarding index.ts's documented property 2.
 *   - pre-lock-to-in-lock (dispatch) -> `dispatch.test.ts`, via the
 *     `beforeCanaryResolves` seam, guarding the in-lock revalidation.
 *
 * What remains cannot be written as a behavioural test at all. ADR-0131
 * Decision 9 does not claim the verify-then-exec window is CLOSED — it claims
 * it is BOUNDED to one synchronous span:
 *
 *   > the spawn call issued with **no intervening `await`** between the in-lock
 *   > digest match and process creation; PID captured from the synchronous
 *   > spawn return before any wait […] The honest claim […]: the window is
 *   > *bounded* to that synchronous span, not closed.
 *
 * A test cannot observe the absence of an `await`: inserting one widens the
 * window to an arbitrary scheduler gap without changing any output. Every
 * behavioural assertion in this repo would stay green while the property the
 * ADR sells was silently deleted.
 *
 * So these assertions read the source. That is deliberate and is the only
 * form in which the claim is checkable. #931 asks for the residual to be
 * "asserted rather than silently absent" — this file is that assertion.
 *
 * These break on refactors that move the span. That is the point: moving it is
 * exactly the change that must not pass unnoticed. A reviewer who moves the
 * code updates the anchors here and, in doing so, re-reads Decision 9.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");

function readLib(name: string): string {
  return fs.readFileSync(path.join(LIB, name), "utf8");
}

/**
 * The body of the `withAuthorityLock` callback in `dispatch.ts` — the span
 * ADR-0131 Decision 9 bounds. Located by its opening call and closed by brace
 * balance so the extraction cannot silently capture the wrong region.
 */
function authorityLockBody(): string {
  const src = readLib("dispatch.ts");
  const open = src.indexOf("withAuthorityLock(qualifiedId, ");
  assert.notEqual(open, -1, "dispatch.ts must still call withAuthorityLock(qualifiedId, …)");
  const bodyStart = src.indexOf("{", open);
  assert.notEqual(bodyStart, -1, "the lock callback must have a body");

  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error("unbalanced braces while extracting the authority-lock body");
}

test("the authority-lock callback is synchronous (an async callback would widen the window)", () => {
  const src = readLib("dispatch.ts");
  const call = src.slice(src.indexOf("withAuthorityLock(qualifiedId, "), src.indexOf("withAuthorityLock(qualifiedId, ") + 60);
  assert.ok(
    !/withAuthorityLock\(qualifiedId,\s*async/.test(call),
    `the lock callback must not be async — an async callback makes every statement inside it a\n` +
      `potential suspension point, which is precisely the bound ADR-0131 Decision 9 claims.\n` +
      `Saw: ${JSON.stringify(call)}`,
  );
});

test("no await sits between the in-lock digest match and process creation", () => {
  const body = authorityLockBody();

  const match = body.indexOf("computeGrantDigest(freshDefinition) !== grant.digest");
  assert.notEqual(match, -1, "the in-lock digest match must still be inside the authority lock");
  const spawn = body.indexOf("spawnConfined(");
  assert.notEqual(spawn, -1, "the spawn call must still be inside the authority lock");
  assert.ok(match < spawn, "the digest match must precede process creation");

  const span = body.slice(match, spawn);
  const awaits = span.match(/\bawait\b/g) ?? [];
  assert.deepEqual(
    awaits,
    [],
    `ADR-0131 Decision 9 bounds the verify-then-exec window to this synchronous span.\n` +
      `An await here hands control to the scheduler between the digest match and the\n` +
      `mount taking effect, widening a bounded window into an unbounded one — with no\n` +
      `observable change to any output, which is why this is asserted structurally.\n` +
      `Found ${awaits.length} await(s) in the span.`,
  );
});

test("the child PID is captured from the synchronous spawn return, not awaited", () => {
  const body = authorityLockBody();
  const spawnIdx = body.indexOf("spawnConfined(");
  const before = body.slice(Math.max(0, spawnIdx - 80), spawnIdx);
  assert.ok(
    !/\bawait\s*$/.test(before.trimEnd()) && !/=\s*await\s+deps\.runner\.spawnConfined/.test(body),
    "spawnConfined must be called synchronously — awaiting it would place the scheduler " +
      "between process creation and PID capture (ADR-0131 Decision 9).",
  );
});

test("the residual is still path-based, exactly as ADR-0131 Decision 9 records it", () => {
  // Decision 9's OPEN half: "bwrap binds and Seatbelt subpath rules consume
  // paths at spawn time, not the broker's verified file descriptors, so a
  // same-UID actor can swap bytes between the digest match and the mount
  // taking effect."
  //
  // This asserts the residual still has the shape the ADR describes, so a
  // change in EITHER direction surfaces:
  //   - widened  -> the ADR understates the exposure and must be revised;
  //   - closed   -> someone moved to fd-based exec and Decision 9 is stale.
  // Silence in both directions is the failure mode this prevents.
  const sandbox = readLib("child-sandbox.ts");
  assert.ok(
    /packageRoot|installRoot/.test(sandbox),
    "the sandbox spec must still carry a package path (the residual's mechanism)",
  );
  assert.ok(
    !/\bpackageRootFd\b|\bfd:\s*number/.test(sandbox),
    "an fd-based sandbox spec would CLOSE the Decision 9 residual — a real improvement, " +
      "but ADR-0131 Decision 9 would then be stale and must be superseded rather than " +
      "left claiming a window that no longer exists.",
  );
});
