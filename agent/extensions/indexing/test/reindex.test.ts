import assert from "node:assert/strict";
import { test } from "node:test";

import { Reindexer } from "../reindex.ts";
import type { DetachedLauncher, DetachedProcess } from "../types.ts";

/** A launcher that records calls and lets the test fire the exit callback. */
function fakeLauncher() {
  const calls: { command: string; args: string[] }[] = [];
  const exits: Array<() => void> = [];
  const launcher: DetachedLauncher = (command, args): DetachedProcess => {
    calls.push({ command, args: [...args] });
    return {
      pid: 123,
      onExit(cb) {
        exits.push(cb);
      },
    };
  };
  return { launcher, calls, finishAll: () => exits.splice(0).forEach((cb) => cb()) };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("maybeReindex skips when disabled or not idle", () => {
  const f = fakeLauncher();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {} });
  assert.equal(r.maybeReindex(false, true), "skipped-disabled");
  assert.equal(r.maybeReindex(true, false), "skipped-not-idle");
  assert.equal(f.calls.length, 0);
});

test("maybeReindex launches `ccc index` when enabled and idle", () => {
  const f = fakeLauncher();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {} });
  assert.equal(r.maybeReindex(true, true), "started");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { command: "ccc", args: ["index"] });
  assert.equal(r.running, true);
});

test("single-flight: a second call while in flight is skipped", () => {
  const f = fakeLauncher();
  const c = clock();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {}, now: c.now });
  assert.equal(r.maybeReindex(true, true), "started");
  assert.equal(r.maybeReindex(true, true), "skipped-in-flight");
  assert.equal(f.calls.length, 1);
  // After the process exits and the cooldown elapses, it may run again.
  f.finishAll();
  assert.equal(r.running, false);
  c.advance(60_001);
  assert.equal(r.maybeReindex(true, true), "started");
  assert.equal(f.calls.length, 2);
});

test("cooldown: a call within the window is skipped after the prior finishes", () => {
  const f = fakeLauncher();
  const c = clock();
  const r = new Reindexer({ launcher: f.launcher, binary: "ccc", cwd: "/r", env: {}, now: c.now, cooldownMs: 5000 });
  assert.equal(r.maybeReindex(true, true), "started");
  f.finishAll(); // not in flight anymore
  c.advance(1000); // still inside cooldown
  assert.equal(r.maybeReindex(true, true), "skipped-cooldown");
  c.advance(4001); // past cooldown
  assert.equal(r.maybeReindex(true, true), "started");
  assert.equal(f.calls.length, 2);
});
