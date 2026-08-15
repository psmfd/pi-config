import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveRunOutcome,
  describeRunOutcome,
  glyphForRunOutcome,
  isFailedOutcome,
  type RunOutcome,
} from "../run-status.ts";

test("deriveRunOutcome: a completed run reports its conclusion, not its status", () => {
  // The whole point of #987's warning: `completed` alone says nothing about
  // success. Mapping conclusion onto a `state` field would lose this.
  assert.equal(deriveRunOutcome("completed", "success"), "success");
  assert.equal(deriveRunOutcome("completed", "failure"), "failure");
  assert.equal(deriveRunOutcome("completed", "timed_out"), "timed_out");
  assert.equal(deriveRunOutcome("completed", "cancelled"), "cancelled");
  assert.equal(deriveRunOutcome("completed", "skipped"), "skipped");
  assert.equal(deriveRunOutcome("completed", "action_required"), "action_required");
  assert.equal(deriveRunOutcome("completed", "neutral"), "neutral");
  assert.equal(deriveRunOutcome("completed", "stale"), "stale");
});

test("deriveRunOutcome: a completed run with no conclusion is unknown, never success", () => {
  // Failing open here would render a green marker for a run whose result the
  // API has not reported.
  assert.equal(deriveRunOutcome("completed", null), "unknown");
});

test("deriveRunOutcome: an unrecognized conclusion degrades to unknown", () => {
  // GitHub has added conclusions before (`startup_failure`). A value this
  // module has never seen must not be rendered as though it were understood.
  assert.equal(deriveRunOutcome("completed", "startup_failure"), "unknown");
  assert.equal(deriveRunOutcome("completed", "brand_new_thing"), "unknown");
});

test("deriveRunOutcome: conclusion is ignored while the run is unfinished", () => {
  assert.equal(deriveRunOutcome("in_progress", null), "in_progress");
  assert.equal(deriveRunOutcome("queued", null), "queued");
  // Defensive: a non-null conclusion on an unfinished run must not leak through.
  assert.equal(deriveRunOutcome("in_progress", "success"), "in_progress");
});

test("deriveRunOutcome: the rarer pre-completion statuses collapse to queued", () => {
  for (const status of ["waiting", "requested", "pending"]) {
    assert.equal(deriveRunOutcome(status, null), "queued", status);
  }
});

test("deriveRunOutcome: an unrecognized status is unknown, not queued", () => {
  assert.equal(deriveRunOutcome("teleported", null), "unknown");
});

test("describeRunOutcome renders human-readable labels", () => {
  assert.equal(describeRunOutcome("in_progress"), "running");
  assert.equal(describeRunOutcome("timed_out"), "timed out");
  assert.equal(describeRunOutcome("action_required"), "action required");
  assert.equal(describeRunOutcome("success"), "success");
});

test("glyphForRunOutcome is total and ASCII-only", () => {
  // ASCII because the widget renders into a terminal of unknown font and
  // width behaviour; a wide emoji would shift the line.
  const all: RunOutcome[] = [
    "queued", "in_progress", "success", "failure", "cancelled",
    "skipped", "timed_out", "action_required", "neutral", "stale", "unknown",
  ];
  for (const outcome of all) {
    const glyph = glyphForRunOutcome(outcome);
    assert.equal(glyph.length, 1, outcome);
    assert.ok(/^[\x20-\x7E]$/.test(glyph), `${outcome} glyph is not printable ASCII`);
  }
});

test("isFailedOutcome covers the outcomes that need operator attention", () => {
  assert.ok(isFailedOutcome("failure"));
  assert.ok(isFailedOutcome("timed_out"));
  assert.ok(isFailedOutcome("action_required"));
  assert.ok(!isFailedOutcome("success"));
  assert.ok(!isFailedOutcome("cancelled"));
  assert.ok(!isFailedOutcome("in_progress"));
  assert.ok(!isFailedOutcome("unknown"));
});
