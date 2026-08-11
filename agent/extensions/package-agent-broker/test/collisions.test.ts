/**
 * collisions.test.ts — protected names, cross-package duplicates,
 * case-normalization collisions, and alias rules (#916).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkCollisions,
  checkPackageIdentityCollision,
  CollisionError,
  PROTECTED_NAMES,
  type GrantIdentity,
} from "../lib/collisions.ts";
import type { DiscoveredProposal } from "../lib/discovery.ts";

function proposal(name: string, repo = "psmfd/pi-work-item-client"): DiscoveredProposal {
  return {
    qualifiedId: `git:github.com/${repo}@v1.0.0#${name}`,
    packageIdentity: {
      source: `git:github.com/${repo}@v1.0.0`,
      host: "github.com",
      path: repo,
      ref: "v1.0.0",
      observedCommit: null,
    },
    descriptor: {
      schemaVersion: 1,
      name,
      description: "d",
      prompt: "p",
      tools: ["read"],
      model: null,
      guardProfile: null,
      contextPolicy: null,
      environment: {},
    },
    descriptorText: "{}",
    descriptorEvidence: { relPath: `agents/${name}.json`, byteLength: 2, sha256: "a".repeat(64) },
    wrapperText: null,
    wrapperEvidence: null,
    installRoot: "/tmp/x",
  };
}

const NO_ALIASES = new Map<string, string>();

test("clean proposal passes", () => {
  const p = proposal("work-item-planner");
  checkCollisions(p, [p], NO_ALIASES, null);
  checkCollisions(p, [p], NO_ALIASES, "planner");
});

test("protected names are refused, case-insensitively", () => {
  assert.ok(PROTECTED_NAMES.length > 0);
  const p = proposal("code-review-expert");
  assert.throws(() => checkCollisions(p, [p], NO_ALIASES, null), CollisionError);
});

test("cross-package agent-name collisions are refused", () => {
  const a = proposal("work-item-planner");
  const b = proposal("work-item-planner", "psmfd/pi-other");
  assert.throws(() => checkCollisions(a, [a, b], NO_ALIASES, null), CollisionError);
});

test("alias validation and collisions", () => {
  const p = proposal("work-item-planner");
  // invalid shapes
  for (const alias of ["UPPER", "-x", "a", "ünïcode", "a".repeat(40)]) {
    assert.throws(() => checkCollisions(p, [p], NO_ALIASES, alias), CollisionError, alias);
  }
  // alias vs protected name
  assert.throws(() => checkCollisions(p, [p], NO_ALIASES, "linter"), CollisionError);
  // alias vs another proposal's name
  const other = proposal("issue-triager", "psmfd/pi-other");
  assert.throws(() => checkCollisions(p, [p, other], NO_ALIASES, "issue-triager"), CollisionError);
  // alias vs existing draft alias
  const aliases = new Map([["git:github.com/psmfd/pi-other@v1.0.0#issue-triager", "triager"]]);
  assert.throws(() => checkCollisions(p, [p], aliases, "triager"), CollisionError);
  // same qualified id re-reviewing with its own alias is fine
  const own = new Map([[p.qualifiedId, "planner"]]);
  checkCollisions(p, [p], own, "planner");
});

// --- #928: package-identity collisions --------------------------------------

function grantIdentity(repo: string, ref: string, agentName: string): GrantIdentity {
  return {
    qualifiedId: `git:github.com/${repo}@${ref}#${agentName}`,
    host: "github.com",
    path: repo,
    ref,
    agentName,
  };
}

test("an active grant at a different ref refuses approval of the same agent", () => {
  const p = proposal("work-item-planner");
  const held = grantIdentity("psmfd/pi-work-item-client", "v0.9.0", "work-item-planner");
  assert.throws(() => checkPackageIdentityCollision(p, [held]), CollisionError);
});

test("re-approving the same qualified identity is not a package-identity collision", () => {
  // Same identity is the re-approval path: it atomically replaces the prior
  // grant, so the two are never simultaneously resolvable.
  const p = proposal("work-item-planner");
  const held = grantIdentity("psmfd/pi-work-item-client", "v1.0.0", "work-item-planner");
  assert.equal(held.qualifiedId, p.qualifiedId);
  checkPackageIdentityCollision(p, [held]);
});

test("a different agent or a different package is not a package-identity collision", () => {
  const p = proposal("work-item-planner");
  checkPackageIdentityCollision(p, [grantIdentity("psmfd/pi-work-item-client", "v0.9.0", "other-agent")]);
  checkPackageIdentityCollision(p, [grantIdentity("psmfd/pi-other", "v0.9.0", "work-item-planner")]);
});

test("package-identity collisions fold case on host and agent name", () => {
  const p = proposal("work-item-planner");
  const held = {
    ...grantIdentity("psmfd/pi-work-item-client", "v0.9.0", "Work-Item-Planner"),
    host: "GitHub.com",
  };
  assert.throws(() => checkPackageIdentityCollision(p, [held]), CollisionError);
});

test("no active grants means no package-identity collision", () => {
  checkPackageIdentityCollision(proposal("work-item-planner"), []);
});

test("package-identity collisions fold case on the repository path too", () => {
  // Repository paths are case-insensitive on the hosting platforms these
  // packages come from, so an exact comparison would let a re-cased path
  // slip past a refusal that is supposed to be total.
  const p = proposal("work-item-planner");
  const held = grantIdentity("psmfd/Pi-Work-Item-Client", "v0.9.0", "work-item-planner");
  assert.throws(() => checkPackageIdentityCollision(p, [held]), CollisionError);
});
