/**
 * input-router.test.ts — routing, gating classification, and hostile-input
 * behavior for the #916 broker's raw-input command surface.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isAffirmative, routeInput } from "../lib/input-router.ts";

const QID = "git:github.com/psmfd/pi-work-item-client@v1.0.0#work-item-planner";

test("non-broker input is not ours", () => {
  for (const text of [
    "hello world",
    "/other-command list",
    "/package-agentx list",
    "/package-agent-broker list",
    "run /package-agent list please", // prefix not the first token
    "",
  ]) {
    assert.deepEqual(routeInput(text), { ours: false }, text);
  }
});

test("exact commands parse", () => {
  assert.deepEqual(routeInput("/package-agent list"), {
    ours: true,
    ok: true,
    command: { kind: "list" },
  });
  assert.deepEqual(routeInput("/package-agent status"), {
    ours: true,
    ok: true,
    command: { kind: "status", qualifiedId: null },
  });
  assert.deepEqual(routeInput(`/package-agent status ${QID}`), {
    ours: true,
    ok: true,
    command: { kind: "status", qualifiedId: QID },
  });
  assert.deepEqual(routeInput(`/package-agent inspect ${QID}`), {
    ours: true,
    ok: true,
    command: { kind: "inspect", qualifiedId: QID },
  });
  assert.deepEqual(routeInput(`/package-agent review ${QID}`), {
    ours: true,
    ok: true,
    command: { kind: "review", qualifiedId: QID, alias: null },
  });
  assert.deepEqual(routeInput(`/package-agent review ${QID} --alias planner`), {
    ours: true,
    ok: true,
    command: { kind: "review", qualifiedId: QID, alias: "planner" },
  });
  assert.deepEqual(routeInput(`/package-agent reject ${QID}`), {
    ours: true,
    ok: true,
    command: { kind: "reject", qualifiedId: QID },
  });
  assert.deepEqual(routeInput(`/package-agent revoke-draft ${QID}`), {
    ours: true,
    ok: true,
    command: { kind: "revoke-draft", qualifiedId: QID },
  });
  assert.deepEqual(routeInput(`/package-agent revoke ${QID}`), {
    ours: true,
    ok: true,
    command: { kind: "revoke", qualifiedId: QID },
  });
});

test("only review is affirmative", () => {
  const review = routeInput(`/package-agent review ${QID}`);
  assert.ok(review.ours && review.ok);
  assert.equal(isAffirmative(review.command), true);
  for (const text of [
    "/package-agent list",
    "/package-agent status",
    `/package-agent inspect ${QID}`,
    `/package-agent reject ${QID}`,
    `/package-agent revoke-draft ${QID}`,
    `/package-agent revoke ${QID}`,
  ]) {
    const r = routeInput(text);
    assert.ok(r.ours && r.ok, text);
    assert.equal(isAffirmative(r.command), false, text);
  }
});

test("whitespace variants are ours but rejected (never passed onward)", () => {
  for (const text of [
    "  /package-agent review " + QID,
    "\t/package-agent list",
    "/package-agent  list", // double space
    "/package-agent list ", // trailing space
  ]) {
    const r = routeInput(text);
    assert.ok(r.ours, text);
    assert.ok(!("ok" in r) || r.ok === false, text);
  }
});

test("confusable and non-ASCII forms", () => {
  // Cyrillic 'а' in "package" — NOT the exact ASCII token: not ours; it can
  // only reach the model as inert text (no other authorization path exists).
  const confusable = "/pаckage-agent review " + QID;
  assert.deepEqual(routeInput(confusable), { ours: false });

  // Exact ASCII prefix with non-ASCII argument: ours, rejected.
  const nonAsciiArg = "/package-agent review git:github.com/psmfd/pi-x@v1#agеnt";
  const r = routeInput(nonAsciiArg);
  assert.ok(r.ours && !r.ok);
});

test("control characters and ANSI escapes are rejected", () => {
  for (const text of [
    `/package-agent review ${QID}\u001b[31m`, // ANSI SGR escape
    `/package-agent review ${QID}\u0000`, // NUL
    `/package-agent review \u202e${QID}`, // RLO bidi override
    `/package-agent review ${QID}\u200b`, // zero-width space
  ]) {
    const r = routeInput(text);
    assert.ok(r.ours && !r.ok, JSON.stringify(text));
  }
});

test("malformed commands are ours and rejected", () => {
  for (const text of [
    "/package-agent",
    "/package-agent unknown-subcommand",
    "/package-agent review", // missing qid
    "/package-agent review not-a-qid",
    `/package-agent review ${QID} --alias`, // missing alias value
    `/package-agent review ${QID} --alias UPPER`, // invalid alias
    `/package-agent review ${QID} --other x`,
    `/package-agent list extra-arg`,
    `/package-agent inspect ${QID} extra`,
    "/package-agent review ../../etc/passwd",
    "/package-agent review git:github.com/a/b@v1#name; rm -rf /",
  ]) {
    const r = routeInput(text);
    assert.ok(r.ours, text);
    assert.ok("ok" in r && r.ok === false, text);
  }
});

test("oversized input is rejected", () => {
  const r = routeInput("/package-agent review " + "a".repeat(2000));
  assert.ok(r.ours && !r.ok);
});

test("qualified id validation is strict", () => {
  for (const bad of [
    "git:github.com/psmfd/pi-x#name", // missing ref
    "github.com/psmfd/pi-x@v1#name", // missing scheme
    "git:github.com/psmfd/pi-x@v1#Name", // uppercase agent name
    "git:github.com/psmfd/pi-x@v1#na", // ok actually? 'na' matches {1,63} min 2 chars total
  ]) {
    const r = routeInput(`/package-agent inspect ${bad}`);
    assert.ok(r.ours, bad);
    if (bad.endsWith("#na")) {
      assert.ok("ok" in r && r.ok === true, bad);
    } else {
      assert.ok("ok" in r && r.ok === false, bad);
    }
  }
});

// --- #928 verbs -------------------------------------------------------------

test("approve routes with an optional alias, like review", () => {
  const qid = "git:github.com/psmfd/pi-x@v1.0.0#planner";
  const plain = routeInput(`/package-agent approve ${qid}`);
  assert.ok(plain.ours && "ok" in plain && plain.ok);
  assert.deepEqual(plain.command, { kind: "approve", qualifiedId: qid, alias: null });

  const aliased = routeInput(`/package-agent approve ${qid} --alias planner`);
  assert.ok(aliased.ours && "ok" in aliased && aliased.ok);
  assert.deepEqual(aliased.command, { kind: "approve", qualifiedId: qid, alias: "planner" });
});

test("approve is affirmative, and read-only verbs are not", () => {
  const qid = "git:github.com/psmfd/pi-x@v1.0.0#planner";
  assert.ok(isAffirmative({ kind: "approve", qualifiedId: qid, alias: null }));
  assert.ok(isAffirmative({ kind: "review", qualifiedId: qid, alias: null }));
  assert.ok(!isAffirmative({ kind: "grants" }));
  assert.ok(!isAffirmative({ kind: "status", qualifiedId: null }));
  assert.ok(!isAffirmative({ kind: "inspect", qualifiedId: qid }));
});

test("malformed approve variants are handled and rejected, never passed on", () => {
  for (const text of [
    "/package-agent approve",
    "/package-agent approve not-a-qid",
    "/package-agent approve git:github.com/psmfd/pi-x@v1.0.0#planner --alias",
    "/package-agent approve git:github.com/psmfd/pi-x@v1.0.0#planner --alias BAD",
    "/package-agent approve git:github.com/psmfd/pi-x@v1.0.0#planner --unknown x",
    "/package-agent grants extra",
  ]) {
    const r = routeInput(text);
    assert.ok(r.ours, text);
    assert.ok("ok" in r && r.ok === false, text);
  }
});

test("grants takes no arguments", () => {
  const r = routeInput("/package-agent grants");
  assert.ok(r.ours && "ok" in r && r.ok);
  assert.deepEqual(r.command, { kind: "grants" });
});
