import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterDownOmlxIds,
  getAvailableModelIds,
  isQualifiedPin,
  resolveModelPin,
  sanitizeFallbackModelId,
  type CopilotFallback,
} from "../model-pin.ts";

const AVAILABLE = new Set(["omlx/coding-workhorse", "github-copilot/claude-opus-4.7"]);

test("isQualifiedPin: provider/id yes; bare id, edge slashes no", () => {
  assert.equal(isQualifiedPin("omlx/coding-workhorse"), true);
  assert.equal(isQualifiedPin("claude-opus-4.7"), false);
  assert.equal(isQualifiedPin("/leading"), false);
  assert.equal(isQualifiedPin("trailing/"), false);
});

test("no pin: no flag, no note", () => {
  assert.deepEqual(resolveModelPin(undefined, AVAILABLE), { modelArg: null, note: null, kind: "default" });
});

test("qualified pin present in the registry passes through", () => {
  assert.deepEqual(resolveModelPin("omlx/coding-workhorse", AVAILABLE), {
    modelArg: "omlx/coding-workhorse",
    note: null,
    kind: "pinned",
  });
});

test("qualified pin absent from the registry is omitted with a note", () => {
  const r = resolveModelPin("omlx/coding-workhorse", new Set(["anthropic/claude-opus-4-7"]));
  assert.equal(r.modelArg, null);
  assert.equal(r.kind, "default");
  assert.match(r.note ?? "", /omlx\/coding-workhorse/);
  assert.match(r.note ?? "", /session default/);
});

test("empty available set (no credentialed models) omits qualified pins", () => {
  assert.equal(resolveModelPin("github-copilot/claude-opus-4.7", new Set()).modelArg, null);
});

test("slash-less pin passes through ungated even when absent", () => {
  assert.deepEqual(resolveModelPin("claude-opus-4.7", new Set()), {
    modelArg: "claude-opus-4.7",
    note: null,
    kind: "pinned",
  });
});

test("registry unreadable (null) fails open: pin passes through", () => {
  assert.deepEqual(resolveModelPin("omlx/coding-workhorse", null), {
    modelArg: "omlx/coding-workhorse",
    note: null,
    kind: "pinned",
  });
});

test("getAvailableModelIds builds provider/id keys from sync or async registries", async () => {
  const models = [{ provider: "omlx", id: "coding-workhorse" }];
  assert.deepEqual(await getAvailableModelIds({ getAvailable: () => models }), new Set(["omlx/coding-workhorse"]));
  assert.deepEqual(
    await getAvailableModelIds({ getAvailable: () => Promise.resolve(models) }),
    new Set(["omlx/coding-workhorse"]),
  );
});

test("getAvailableModelIds returns null when the registry throws", async () => {
  assert.equal(
    await getAvailableModelIds({
      getAvailable: () => {
        throw new Error("registry unavailable");
      },
    }),
    null,
  );
});

// --- #536: the Copilot fallback rung ----------------------------------------

const FB: CopilotFallback = { modelId: "github-copilot/gpt-5-mini" };
const REG_WITH_FB = new Set(["github-copilot/gpt-5-mini", "github-copilot/claude-opus-4.7"]);

test("dropped non-copilot pin substitutes a registry-present, live-enabled fallback", () => {
  const r = resolveModelPin("omlx/coding-workhorse", REG_WITH_FB, {
    ...FB,
    liveEnabledIds: new Set(["gpt-5-mini"]), // bare ids, per the live filter
  });
  assert.equal(r.modelArg, "github-copilot/gpt-5-mini");
  assert.equal(r.kind, "fallback");
  // Honesty: the note names BOTH the dropped pin and the substituted model,
  // and does NOT claim the session default ran.
  assert.match(r.note ?? "", /omlx\/coding-workhorse/);
  assert.match(r.note ?? "", /github-copilot\/gpt-5-mini/);
  assert.doesNotMatch(r.note ?? "", /ran on the session default/);
});

test("liveEnabledIds null (discovery failed) fails open: fallback still used", () => {
  const r = resolveModelPin("omlx/coding-workhorse", REG_WITH_FB, { ...FB, liveEnabledIds: null });
  assert.equal(r.modelArg, "github-copilot/gpt-5-mini");
  assert.equal(r.kind, "fallback");
});

test("liveEnabledIds omitted entirely behaves like fail-open", () => {
  const r = resolveModelPin("omlx/coding-workhorse", REG_WITH_FB, FB);
  assert.equal(r.kind, "fallback");
});

test("a live-tier-gated fallback is rejected: session default with a tier-gated note", () => {
  const r = resolveModelPin("omlx/coding-workhorse", REG_WITH_FB, {
    ...FB,
    liveEnabledIds: new Set(["claude-opus-4.7"]), // gpt-5-mini absent → gated
  });
  assert.equal(r.modelArg, null);
  assert.equal(r.kind, "default");
  assert.match(r.note ?? "", /tier-gated/);
  assert.match(r.note ?? "", /session default/);
});

test("a registry-absent fallback falls through to the session default with a note", () => {
  const r = resolveModelPin("omlx/coding-workhorse", new Set(["anthropic/claude-opus-4-7"]), FB);
  assert.equal(r.modelArg, null);
  assert.equal(r.kind, "default");
  assert.match(r.note ?? "", /not available either/);
});

test("a dropped github-copilot pin never substitutes a sibling copilot model", () => {
  const r = resolveModelPin("github-copilot/claude-opus-4.7", new Set(["github-copilot/gpt-5-mini"]), FB);
  assert.equal(r.modelArg, null);
  assert.equal(r.kind, "default");
  assert.doesNotMatch(r.note ?? "", /gpt-5-mini/);
  assert.match(r.note ?? "", /session default/);
});

test("registry unreadable (null) never consults the fallback", () => {
  const r = resolveModelPin("omlx/coding-workhorse", null, FB);
  assert.deepEqual(r, { modelArg: "omlx/coding-workhorse", note: null, kind: "pinned" });
});

test("a resolvable pin wins over the fallback", () => {
  const r = resolveModelPin("omlx/coding-workhorse", new Set([...REG_WITH_FB, "omlx/coding-workhorse"]), FB);
  assert.deepEqual(r, { modelArg: "omlx/coding-workhorse", note: null, kind: "pinned" });
});

test("a malformed fallback modelId is ignored (defensive)", () => {
  const r = resolveModelPin("omlx/coding-workhorse", REG_WITH_FB, { modelId: "gpt-5-mini" });
  assert.equal(r.kind, "default");
  assert.match(r.note ?? "", /session default/);
});

test("no fallback argument is byte-identical to the #519 behavior", () => {
  assert.deepEqual(
    resolveModelPin("omlx/coding-workhorse", new Set(["anthropic/x"])),
    resolveModelPin("omlx/coding-workhorse", new Set(["anthropic/x"]), undefined),
  );
});

test("sanitizeFallbackModelId accepts only qualified github-copilot ids", () => {
  assert.equal(sanitizeFallbackModelId("github-copilot/gpt-5-mini"), "github-copilot/gpt-5-mini");
  assert.equal(sanitizeFallbackModelId("  github-copilot/gpt-5-mini  "), "github-copilot/gpt-5-mini");
  assert.equal(sanitizeFallbackModelId("anthropic/claude-haiku-4-5"), null);
  assert.equal(sanitizeFallbackModelId("gpt-5-mini"), null);
  assert.equal(sanitizeFallbackModelId("github-copilot/"), null);
  assert.equal(sanitizeFallbackModelId(42), null);
  assert.equal(sanitizeFallbackModelId(undefined), null);
});

// --- #534: oMLX spawn-time liveness gate -----------------------------------

test("filterDownOmlxIds fails open on null (ambiguous probe / no omlx / unreadable registry)", () => {
  const avail = new Set(["omlx/coding-workhorse", "anthropic/x"]);
  // servedOmlxIds null → set returned unchanged (a saturated-but-alive server is never dropped)
  assert.equal(filterDownOmlxIds(avail, null), avail);
  // availableIds null → passthrough, never fail-closed
  assert.equal(filterDownOmlxIds(null, new Set()), null);
});

test("filterDownOmlxIds drops unserved omlx ids on an authoritative (even empty) set", () => {
  const avail = new Set(["omlx/coding-workhorse", "omlx/workhorse-8b", "anthropic/x", "github-copilot/y"]);
  // confirmed down (empty set) → every omlx id dropped, non-omlx untouched
  assert.deepEqual(
    new Set(filterDownOmlxIds(avail, new Set())),
    new Set(["anthropic/x", "github-copilot/y"]),
  );
  // partial serve → only the unserved omlx id dropped
  assert.deepEqual(
    new Set(filterDownOmlxIds(avail, new Set(["coding-workhorse"]))),
    new Set(["omlx/coding-workhorse", "anthropic/x", "github-copilot/y"]),
  );
  // fully served → unchanged membership
  assert.deepEqual(
    new Set(filterDownOmlxIds(avail, new Set(["coding-workhorse", "workhorse-8b"]))),
    new Set(avail),
  );
});

// The decision uses the ALREADY-filtered set (as the caller passes it); servedOmlxIds
// shapes only the note. These tests pass a pre-filtered set (down id absent) + the probe set.
const OMLX_PIN = "omlx/coding-workhorse";
const REG_NO_WORKHORSE = new Set(["github-copilot/gpt-5-mini"]); // workhorse already filtered out (down)
const FB534: CopilotFallback = { modelId: "github-copilot/gpt-5-mini", liveEnabledIds: new Set(["gpt-5-mini"]) };

test("down oMLX pin → drops to the Copilot fallback with a 'server appears down' note", () => {
  const r = resolveModelPin(OMLX_PIN, REG_NO_WORKHORSE, FB534, new Set()); // empty served = confirmed down
  assert.equal(r.modelArg, "github-copilot/gpt-5-mini");
  assert.equal(r.kind, "fallback");
  assert.match(r.note ?? "", /oMLX server appears to be down/);
  assert.doesNotMatch(r.note ?? "", /not available on this host/);
});

test("down oMLX pin + no viable fallback → session default with the 'server appears down' note", () => {
  const r = resolveModelPin(OMLX_PIN, new Set(["anthropic/x"]), undefined, new Set());
  assert.equal(r.modelArg, null);
  assert.equal(r.kind, "default");
  assert.match(r.note ?? "", /oMLX server appears to be down/);
});

test("oMLX up but not serving this model → distinct wording from server-down", () => {
  const r = resolveModelPin(OMLX_PIN, new Set(["anthropic/x"]), undefined, new Set(["some-other-model"]));
  assert.match(r.note ?? "", /up but is not currently serving this model/);
  assert.doesNotMatch(r.note ?? "", /appears to be down/);
});

test("servedOmlxIds omitted → byte-identical to the pre-#534 note (registry-absence wording)", () => {
  const withArg = resolveModelPin(OMLX_PIN, new Set(["anthropic/x"]), undefined, null);
  const without = resolveModelPin(OMLX_PIN, new Set(["anthropic/x"]), undefined);
  assert.deepEqual(withArg, without);
  assert.match(without.note ?? "", /not available on this host/);
});

test("servedOmlxIds never shapes a non-omlx pin's note (provider guard)", () => {
  // a github-copilot pin dropped, with an omlx probe result present → generic wording
  const r = resolveModelPin("github-copilot/ghost", new Set(["anthropic/x"]), undefined, new Set());
  assert.match(r.note ?? "", /not available on this host/);
  assert.doesNotMatch(r.note ?? "", /oMLX server/);
});
