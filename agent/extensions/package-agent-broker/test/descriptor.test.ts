/**
 * descriptor.test.ts — strict JSON parsing + descriptor schema validation
 * for the #916 broker (duplicate keys, unknown keys, bounds, identities).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseStrictJson, StrictJsonError } from "../lib/strict-json.ts";
import { validateDescriptor, DescriptorError } from "../lib/descriptor.ts";

const BOUNDS = { maxDepth: 8, maxEntries: 256, maxStringLength: 262144 };

// --- strict JSON -----------------------------------------------------------

test("strict json: parses plain documents", () => {
  const parsed = parseStrictJson('{"a": [1, 2, "x"], "b": null, "c": true}', BOUNDS);
  // Round-trip through JSON to normalize the (deliberate) null prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
    a: [1, 2, "x"],
    b: null,
    c: true,
  });
});

test("strict json: duplicate keys are refused", () => {
  assert.throws(() => parseStrictJson('{"a": 1, "a": 2}', BOUNDS), StrictJsonError);
});

test("strict json: floats and exponents are refused", () => {
  for (const doc of ['{"a": 1.5}', '{"a": 1e3}', '{"a": 0.0}']) {
    assert.throws(() => parseStrictJson(doc, BOUNDS), StrictJsonError, doc);
  }
});

test("strict json: depth bound is enforced", () => {
  const deep = "[".repeat(20) + "]".repeat(20);
  assert.throws(() => parseStrictJson(deep, { ...BOUNDS, maxDepth: 4 }), StrictJsonError);
});

test("strict json: entry-count bound is enforced", () => {
  const doc = `[${Array.from({ length: 20 }, () => "1").join(",")}]`;
  assert.throws(() => parseStrictJson(doc, { ...BOUNDS, maxEntries: 10 }), StrictJsonError);
});

test("strict json: trailing content and control chars are refused", () => {
  assert.throws(() => parseStrictJson('{"a": 1} extra', BOUNDS), StrictJsonError);
  assert.throws(() => parseStrictJson('{"a": "x\u0001y"}', BOUNDS), StrictJsonError);
});

test("strict json: __proto__ cannot pollute", () => {
  const parsed = parseStrictJson('{"__proto__": {"polluted": true}}', BOUNDS) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

// --- descriptor ------------------------------------------------------------

function descriptorDoc(overrides: Record<string, unknown> = {}, remove: string[] = []): string {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    name: "work-item-planner",
    description: "Plans work items from bounded context.",
    prompt: "You are a credentialless proposal-only planner.",
    tools: ["read", "expertise_search"],
    ...overrides,
  };
  for (const key of remove) delete base[key];
  return JSON.stringify(base);
}

test("descriptor: valid document validates and normalizes", () => {
  const d = validateDescriptor(descriptorDoc(), "work-item-planner");
  assert.equal(d.name, "work-item-planner");
  assert.deepEqual(d.tools, ["expertise_search", "read"]); // sorted
  assert.equal(d.model, null);
  assert.deepEqual(d.environment, {});
});

test("descriptor: name must match file basename", () => {
  assert.throws(() => validateDescriptor(descriptorDoc(), "other-name"), DescriptorError);
});

test("descriptor: unknown keys are refused", () => {
  assert.throws(
    () => validateDescriptor(descriptorDoc({ sneaky: true }), "work-item-planner"),
    DescriptorError,
  );
});

test("descriptor: required keys are enforced", () => {
  for (const key of ["schemaVersion", "name", "description", "prompt", "tools"]) {
    assert.throws(
      () => validateDescriptor(descriptorDoc({}, [key]), "work-item-planner"),
      DescriptorError,
      key,
    );
  }
});

test("descriptor: unsupported schema version is refused", () => {
  assert.throws(
    () => validateDescriptor(descriptorDoc({ schemaVersion: 2 }), "work-item-planner"),
    DescriptorError,
  );
});

test("descriptor: tools must be a non-empty finite allowlist", () => {
  assert.throws(() => validateDescriptor(descriptorDoc({ tools: [] }), "work-item-planner"), DescriptorError);
  assert.throws(
    () => validateDescriptor(descriptorDoc({ tools: ["read", "read"] }), "work-item-planner"),
    DescriptorError,
  );
  assert.throws(
    () => validateDescriptor(descriptorDoc({ tools: ["Read"] }), "work-item-planner"),
    DescriptorError,
  );
  assert.throws(
    () =>
      validateDescriptor(
        descriptorDoc({ tools: Array.from({ length: 33 }, (_, i) => `t${i}`) }),
        "work-item-planner",
      ),
    DescriptorError,
  );
});

test("descriptor: invalid names are refused", () => {
  for (const name of ["UPPER", "-leading", "a", "with space", "ünïcode", "a".repeat(65)]) {
    assert.throws(
      () => validateDescriptor(descriptorDoc({ name }), name),
      DescriptorError,
      name,
    );
  }
});

test("descriptor: environment keys and values are bounded ASCII", () => {
  const good = validateDescriptor(
    descriptorDoc({ environment: { WORK_ITEM_MODE: "propose-only" } }),
    "work-item-planner",
  );
  assert.deepEqual(good.environment, { WORK_ITEM_MODE: "propose-only" });

  assert.throws(
    () => validateDescriptor(descriptorDoc({ environment: { "bad-key": "x" } }), "work-item-planner"),
    DescriptorError,
  );
  assert.throws(
    () =>
      validateDescriptor(
        descriptorDoc({ environment: { GOOD_KEY: "bad\u0007value" } }),
        "work-item-planner",
      ),
    DescriptorError,
  );
});

test("descriptor: duplicate JSON keys in the raw text are refused", () => {
  const doc = descriptorDoc().replace("{", '{"name": "shadow-name", ');
  assert.throws(() => validateDescriptor(doc, "work-item-planner"), StrictJsonError);
});

test("descriptor: policy fields accept null and bounded ASCII strings only", () => {
  const ok = validateDescriptor(
    descriptorDoc({ model: "local-small", guardProfile: "strict", contextPolicy: "none" }),
    "work-item-planner",
  );
  assert.equal(ok.model, "local-small");
  assert.throws(
    () => validateDescriptor(descriptorDoc({ model: "x".repeat(200) }), "work-item-planner"),
    DescriptorError,
  );
  assert.throws(
    () => validateDescriptor(descriptorDoc({ model: "mödel" }), "work-item-planner"),
    DescriptorError,
  );
});
