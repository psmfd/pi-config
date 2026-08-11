import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseProcUptimeMs,
  resolveSuspendInclusiveClock,
} from "../lib/suspend-inclusive-clock.ts";

test("parses bounded Linux uptime values as integer milliseconds", () => {
  assert.equal(parseProcUptimeMs("123.456 88.0\n"), 123_456);
  assert.equal(parseProcUptimeMs("0.0 0.0\n"), 0);
  assert.equal(parseProcUptimeMs("invalid"), null);
  assert.equal(parseProcUptimeMs("-1.0 2.0"), null);
});

test("Linux resolver uses a verified kernel uptime source", () => {
  const clock = resolveSuspendInclusiveClock({
    platform: "linux",
    readFile: () => "42.25 10.0\n",
  });
  assert.equal(clock.suspendInclusive, true);
  assert.equal(clock.source, "linux-proc-uptime");
  assert.equal(clock.nowMs(), 42_250);
});

test("invalid Linux uptime fails visible rather than using wall clock", () => {
  const clock = resolveSuspendInclusiveClock({
    platform: "linux",
    readFile: () => "not uptime",
  });
  assert.equal(clock.suspendInclusive, false);
  assert.equal(clock.source, "unverified");
});

test("unsupported platforms are never asserted suspend-inclusive", () => {
  const clock = resolveSuspendInclusiveClock({ platform: "freebsd" });
  assert.equal(clock.suspendInclusive, false);
  assert.equal(clock.source, "unverified");
});
