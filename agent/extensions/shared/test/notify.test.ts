import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMessage, notify, type NotifyContext, type NotifyLevel } from "../notify.ts";

test("formatMessage tags the scope", () => {
  assert.equal(formatMessage("auto-router", "routed"), "[pi-suite:auto-router] routed");
});

test("notify delivers a formatted message when a UI is present", () => {
  const calls: Array<{ message: string; level?: NotifyLevel }> = [];
  const ctx: NotifyContext = { hasUI: true, ui: { notify: (message, level) => void calls.push({ message, level }) } };
  const delivered = notify(ctx, "indexer", "done", "warning");
  assert.equal(delivered, true);
  assert.deepEqual(calls, [{ message: "[pi-suite:indexer] done", level: "warning" }]);
});

test("notify defaults to info level", () => {
  let seen: NotifyLevel | undefined;
  const ctx: NotifyContext = { hasUI: true, ui: { notify: (_m, level) => void (seen = level) } };
  notify(ctx, "x", "y");
  assert.equal(seen, "info");
});

test("notify is a no-op without a UI", () => {
  let called = false;
  const noUi: NotifyContext = { hasUI: false, ui: { notify: () => void (called = true) } };
  assert.equal(notify(noUi, "x", "y"), false);
  assert.equal(called, false);
  assert.equal(notify({ hasUI: true }, "x", "y"), false);
});
