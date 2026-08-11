/**
 * grant-digest.test.ts — the acceptance tests for #928's digest contract:
 *
 *   - the grant digest covers EVERY ADR-0127 §5 field, proven by a mutator
 *     table whose key set must equal `GRANT_DIGEST_FIELDS` exactly;
 *   - digest-domain separation from #916's review drafts is enforced;
 *   - all six fields a review draft declares unresolvable are resolved.
 *
 * The mutator table is the mechanism that keeps this honest over time: adding
 * a §5 field to `GRANT_DIGEST_FIELDS` without adding a mutator fails the key
 * -set assertion, and adding a field to the definition without threading it
 * through `definitionCanonicalValue` fails its mutator's digest assertion.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { canonicalDigest } from "../../shared/package-agent-canonical.ts";
import {
  GRANT_DIGEST_DOMAIN,
  GRANT_DIGEST_FIELDS,
  type ApprovalBinding,
  type EffectiveDefinition,
  type GrantDigestField,
} from "../../shared/package-agent-grant-contract.ts";
import {
  REVIEW_DRAFT_DIGEST_DOMAIN,
  UNRESOLVED_PROVENANCE_FIELDS,
} from "../../shared/package-agent-review-contract.ts";
import type { DiscoveredProposal } from "../lib/discovery.ts";
import {
  computeGrantDigest,
  definitionCanonicalValue,
  reconstructEffectiveDefinition,
} from "../lib/reconstruct.ts";

const COMMIT = "a".repeat(40);

/**
 * A real minimal install tree: the full-tree asset digest (#930, ADR-0131)
 * walks `installRoot`, so proposals must point at a directory that exists.
 * Created once per module — walk determinism across builds depends on it.
 */
function makeInstallRoot(name = "work-item-planner"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pab-install-"));
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", `${name}.json`), "{}");
  return root;
}
const INSTALL_ROOT = makeInstallRoot();


/** A small stand-in runner so tests never digest the real 70+ MB binary. */
function fakeRunner(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pab-runner-"));
  const p = path.join(dir, "pi");
  fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
  return p;
}

function proposal(overrides: Partial<DiscoveredProposal> = {}): DiscoveredProposal {
  const repo = "psmfd/pi-work-item-client";
  const name = "work-item-planner";
  return {
    qualifiedId: `git:github.com/${repo}@v1.0.0#${name}`,
    packageIdentity: {
      source: `git:github.com/${repo}@v1.0.0`,
      host: "github.com",
      path: repo,
      ref: "v1.0.0",
      observedCommit: COMMIT,
    },
    descriptor: {
      schemaVersion: 1,
      name,
      description: "Plans work items.",
      prompt: "You are a proposal-only planner.",
      tools: ["read"],
      model: null,
      guardProfile: null,
      contextPolicy: null,
      environment: {},
    },
    descriptorText: "{}",
    descriptorEvidence: { relPath: `agents/${name}.json`, byteLength: 2, sha256: "b".repeat(64) },
    wrapperText: null,
    wrapperEvidence: null,
    installRoot: INSTALL_ROOT,
    ...overrides,
  };
}

function binding(): ApprovalBinding {
  return {
    approval: { runtimeInstanceId: "c".repeat(64), sequence: 1 },
    nonce: "d".repeat(64),
    expiresAtMs: 1_800_000_000_000,
    expiresAtMonotonicMs: 4_000_000,
    clockSuspendInclusive: false,
  };
}

function build(p: DiscoveredProposal = proposal(), alias: string | null = null): EffectiveDefinition {
  return reconstructEffectiveDefinition(p, alias, binding(), { runnerPath: fakeRunner() });
}

/** Shallow-patch a frozen definition. */
function mutate(def: EffectiveDefinition, patch: Record<string, unknown>): EffectiveDefinition {
  return { ...def, ...patch } as EffectiveDefinition;
}

// ---------------------------------------------------------------------------
// Digest coverage: one mutator per ADR-0127 §5 field.
// ---------------------------------------------------------------------------

const MUTATORS: Record<GrantDigestField, (d: EffectiveDefinition) => EffectiveDefinition> = {
  "schema-and-policy-versions": (d) => mutate(d, { policyVersion: d.policyVersion + 1 }),
  "qualified-package-identity-and-source": (d) =>
    mutate(d, { packageIdentity: { ...d.packageIdentity, source: "git:github.com/other/pkg@v9" } }),
  "resolved-revision-and-tree-digest": (d) => mutate(d, { resolvedCommit: "e".repeat(40) }),
  "descriptor-and-wrapper-bytes": (d) => mutate(d, { descriptorText: `${d.descriptorText} ` }),
  "complete-system-prompt": (d) => mutate(d, { promptText: `${d.promptText} (edited)` }),
  "finite-tool-allowlist-and-implementations": (d) =>
    mutate(d, { effectiveTools: [...d.effectiveTools, { name: "ls", provenance: "builtin", implementationDigest: "f".repeat(64) }] }),
  "runner-identity-and-content": (d) => mutate(d, { runner: { ...d.runner, sha256: "0".repeat(64) } }),
  "argv-policy": (d) =>
    mutate(d, { argvPolicy: { template: [...d.argvPolicy.template, "--extra"], isolation: d.argvPolicy.isolation } }),
  "extension-and-module-closure": (d) =>
    mutate(d, {
      extensionClosure: {
        mode: "explicit",
        entries: [{ relPath: "ext/index.ts", byteLength: 10, sha256: "1".repeat(64) }],
      },
    }),
  "event-handler-set": (d) =>
    mutate(d, { eventHandlerSet: { mode: "explicit", handlers: ["input"] } }),
  "environment-model-guard-and-context-policies": (d) =>
    mutate(d, { environmentPolicy: { ...d.environmentPolicy, EXTRA: "1" } }),
  "qualified-agent-identity-and-alias": (d) => mutate(d, { alias: "planner" }),
  "approval-identifier": (d) =>
    mutate(d, { approval: { ...d.approval, sequence: d.approval.sequence + 1 } }),
  nonce: (d) => mutate(d, { nonce: "9".repeat(64) }),
  expiry: (d) => mutate(d, { expiresAtMs: d.expiresAtMs + 1000 }),
};

test("the mutator table matches the ADR-0127 §5 field enumeration exactly", () => {
  assert.deepEqual(Object.keys(MUTATORS).sort(), [...GRANT_DIGEST_FIELDS].sort());
});

test("every §5 field is bound: mutating it changes the grant digest", () => {
  const def = build();
  const base = computeGrantDigest(def);
  for (const field of GRANT_DIGEST_FIELDS) {
    const mutated = MUTATORS[field](def);
    assert.notEqual(computeGrantDigest(mutated), base, `field ${field} escapes the digest`);
  }
});

test("the tree digest is bound independently of the resolved revision", () => {
  // The "resolved-revision-and-tree-digest" slug covers two values, and its
  // table mutator exercises only the revision. Pin the other half here so the
  // slug's coverage claim is precise rather than approximately true.
  const def = build();
  const base = computeGrantDigest(def);
  assert.notEqual(computeGrantDigest(mutate(def, { assetTreeDigest: "7".repeat(64) })), base);
});

test("the digest is stable for an unchanged definition", () => {
  const def = build();
  assert.equal(computeGrantDigest(def), computeGrantDigest({ ...def }));
});

// ---------------------------------------------------------------------------
// Domain separation from #916.
// ---------------------------------------------------------------------------

test("the grant digest domain is distinct from the review-draft domain", () => {
  assert.notEqual(GRANT_DIGEST_DOMAIN, REVIEW_DRAFT_DIGEST_DOMAIN);
});

test("identical content digests differently under the two domains", () => {
  const value = definitionCanonicalValue(build());
  assert.notEqual(
    canonicalDigest(GRANT_DIGEST_DOMAIN, value),
    canonicalDigest(REVIEW_DRAFT_DIGEST_DOMAIN, value),
  );
});

test("the definition carries its own domain, so a domain swap is visible", () => {
  const def = build();
  assert.equal(def.digestDomain, GRANT_DIGEST_DOMAIN);
  const swapped = mutate(def, { digestDomain: REVIEW_DRAFT_DIGEST_DOMAIN });
  assert.notEqual(computeGrantDigest(swapped), computeGrantDigest(def));
});

// ---------------------------------------------------------------------------
// The six #916 gaps are closed.
// ---------------------------------------------------------------------------

test("every field a review draft declares unresolvable is resolved in a grant", () => {
  const def = build();
  const resolved: Record<(typeof UNRESOLVED_PROVENANCE_FIELDS)[number], () => boolean> = {
    "effective-tool-implementations": () =>
      def.effectiveTools.length > 0 &&
      def.effectiveTools.every((t) => /^[0-9a-f]{64}$/.test(t.implementationDigest)),
    "runner-identity-and-content": () =>
      def.runner.byteLength > 0 && /^[0-9a-f]{64}$/.test(def.runner.sha256),
    "argv-policy": () => def.argvPolicy.template.length > 0,
    "event-handler-set": () => def.eventHandlerSet.mode === "none" || def.eventHandlerSet.mode === "explicit",
    "extension-closure": () => def.extensionClosure.mode === "none" || def.extensionClosure.mode === "explicit",
    "transitive-module-closure": () => def.moduleClosure.mode === "none" || def.moduleClosure.mode === "explicit",
  };
  assert.deepEqual(Object.keys(resolved).sort(), [...UNRESOLVED_PROVENANCE_FIELDS].sort());
  for (const [field, check] of Object.entries(resolved)) {
    assert.ok(check(), `provenance field ${field} is not resolved`);
  }
});

test("empty closures are a positive assertion, never an absent field", () => {
  const def = build();
  assert.equal(def.extensionClosure.mode, "none");
  assert.equal(def.moduleClosure.mode, "none");
  assert.equal(def.eventHandlerSet.mode, "none");
  // Dropping the mode (as an "it's empty anyway" shortcut would) changes the
  // digest, so the assertion cannot be silently removed.
  const withoutMode = mutate(def, { extensionClosure: { mode: "explicit", entries: [] } });
  assert.notEqual(computeGrantDigest(withoutMode), computeGrantDigest(def));
});

test("the alias participates in the digest and defaults to null", () => {
  const withoutAlias = build();
  const withAlias = build(proposal(), "planner");
  assert.equal(withoutAlias.alias, null);
  assert.equal(withAlias.alias, "planner");
  assert.notEqual(computeGrantDigest(withAlias), computeGrantDigest(withoutAlias));
});

test("wrapper bytes participate in the asset tree digest", () => {
  // #930 (ADR-0131): the tree digest walks the REAL install tree, so wrapper
  // participation is via the wrapper file's bytes on disk — fabricated
  // evidence fields no longer move it (they remain covered by the grant
  // digest's descriptor-and-wrapper-bytes field).
  const bareRoot = makeInstallRoot();
  const without = build(proposal({ installRoot: bareRoot }));
  const wrapperRoot = makeInstallRoot();
  fs.writeFileSync(path.join(wrapperRoot, "agents", "work-item-planner.md"), "# wrapper\n");
  const with_ = build(
    proposal({
      installRoot: wrapperRoot,
      wrapperText: "# wrapper\n",
      wrapperEvidence: { relPath: "agents/work-item-planner.md", byteLength: 10, sha256: "2".repeat(64) },
    }),
  );
  assert.notEqual(with_.assetTreeDigest, without.assetTreeDigest);
  assert.notEqual(computeGrantDigest(with_), computeGrantDigest(without));
});
