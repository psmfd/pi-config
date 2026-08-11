/**
 * review-snapshot.test.ts — snapshot construction, digest stability, and
 * every-field mutation detection (#916).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REVIEW_DRAFT_DIGEST_DOMAIN,
  UNRESOLVED_PROVENANCE_FIELDS,
  type ReviewSnapshot,
} from "../../shared/package-agent-review-contract.ts";
import {
  buildReviewSnapshot,
  computeProposalDigest,
  snapshotCanonicalValue,
  snapshotsEqual,
} from "../lib/review-snapshot.ts";
import type { DiscoveredProposal } from "../lib/discovery.ts";

function proposal(): DiscoveredProposal {
  return {
    qualifiedId: "git:github.com/psmfd/pi-work-item-client@v1.0.0#work-item-planner",
    packageIdentity: {
      source: "git:github.com/psmfd/pi-work-item-client@v1.0.0",
      host: "github.com",
      path: "psmfd/pi-work-item-client",
      ref: "v1.0.0",
      observedCommit: "a".repeat(40),
    },
    descriptor: {
      schemaVersion: 1,
      name: "work-item-planner",
      description: "Plans work items.",
      prompt: "You are a proposal-only planner.",
      tools: ["read"],
      model: null,
      guardProfile: "strict",
      contextPolicy: null,
      environment: { WORK_ITEM_MODE: "propose-only" },
    },
    descriptorText: '{"schemaVersion":1}',
    descriptorEvidence: { relPath: "agents/work-item-planner.json", byteLength: 19, sha256: "b".repeat(64) },
    wrapperText: "# wrapper",
    wrapperEvidence: { relPath: "agents/work-item-planner.md", byteLength: 9, sha256: "c".repeat(64) },
    installRoot: "/tmp/install",
  };
}

test("snapshot carries the non-authorizing unresolved-provenance list", () => {
  const s = buildReviewSnapshot(proposal(), "planner");
  assert.deepEqual([...s.unresolvedProvenance], [...UNRESOLVED_PROVENANCE_FIELDS]);
  assert.equal(s.digestDomain, REVIEW_DRAFT_DIGEST_DOMAIN);
  assert.equal(s.proposedAlias, "planner");
  assert.ok(Object.isFrozen(s));
});

test("digest is stable for identical snapshots", () => {
  const a = buildReviewSnapshot(proposal(), null);
  const b = buildReviewSnapshot(proposal(), null);
  assert.equal(computeProposalDigest(a), computeProposalDigest(b));
  assert.ok(snapshotsEqual(a, b));
});

test("every canonical field mutation changes the digest", () => {
  const base = buildReviewSnapshot(proposal(), "planner");
  const baseDigest = computeProposalDigest(base);

  const mutations: Array<(s: ReviewSnapshot) => ReviewSnapshot> = [
    (s) => ({ ...s, qualifiedId: s.qualifiedId.replace("planner", "planted") }),
    (s) => ({ ...s, packageIdentity: { ...s.packageIdentity, source: s.packageIdentity.source + "x" } }),
    (s) => ({ ...s, packageIdentity: { ...s.packageIdentity, host: "github.com.evil" } }),
    (s) => ({ ...s, packageIdentity: { ...s.packageIdentity, path: "psmfd/pi-other" } }),
    (s) => ({ ...s, packageIdentity: { ...s.packageIdentity, ref: "v1.0.1" } }),
    (s) => ({ ...s, packageIdentity: { ...s.packageIdentity, observedCommit: null } }),
    (s) => ({ ...s, agentName: "other-name" }),
    (s) => ({ ...s, proposedAlias: null }),
    (s) => ({ ...s, proposedAlias: "planner2" }),
    (s) => ({ ...s, descriptorText: s.descriptorText + " " }),
    (s) => ({ ...s, descriptorEvidence: { ...s.descriptorEvidence, byteLength: 20 } }),
    (s) => ({ ...s, descriptorEvidence: { ...s.descriptorEvidence, sha256: "d".repeat(64) } }),
    (s) => ({ ...s, descriptorEvidence: { ...s.descriptorEvidence, relPath: "agents/x.json" } }),
    (s) => ({ ...s, wrapperText: null, wrapperEvidence: null }),
    (s) => ({ ...s, wrapperText: (s.wrapperText ?? "") + "!" }),
    (s) => ({ ...s, promptText: s.promptText + "." }),
    (s) => ({ ...s, requestedTools: [...s.requestedTools, "bash"] }),
    (s) => ({ ...s, requestedTools: [] }),
    (s) => ({ ...s, environmentPolicy: { ...s.environmentPolicy, EXTRA: "x" } }),
    (s) => ({ ...s, environmentPolicy: {} }),
    (s) => ({ ...s, modelPolicy: "some-model" }),
    (s) => ({ ...s, guardPolicy: null }),
    (s) => ({ ...s, contextPolicy: "all" }),
  ];

  for (const [i, mutate] of mutations.entries()) {
    const mutated = mutate({ ...base });
    assert.notEqual(computeProposalDigest(mutated), baseDigest, `mutation ${i} must change the digest`);
  }
});

test("snapshot canonical value enumerates every field explicitly", () => {
  const s = buildReviewSnapshot(proposal(), "planner");
  const value = snapshotCanonicalValue(s) as Record<string, unknown>;
  assert.deepEqual(Object.keys(value).sort(), [
    "agentName",
    "contextPolicy",
    "descriptorEvidence",
    "descriptorText",
    "digestDomain",
    "environmentPolicy",
    "guardPolicy",
    "modelPolicy",
    "packageIdentity",
    "promptText",
    "proposedAlias",
    "qualifiedId",
    "requestedTools",
    "schemaVersion",
    "unresolvedProvenance",
    "wrapperEvidence",
    "wrapperText",
  ]);
  // Field-count pin: adding a ReviewSnapshot field without extending the
  // canonical mapping (and the mutation list above) must fail this test.
  assert.equal(Object.keys(s).length, Object.keys(value).length);
});
