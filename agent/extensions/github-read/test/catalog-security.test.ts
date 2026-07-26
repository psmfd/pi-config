import assert from "node:assert/strict";
import { test } from "node:test";

import { assertReadOnlyPlan, buildOperationPlan, DOMAIN_OPERATIONS } from "../catalog.ts";
import type { GithubDomain, GithubReadParams } from "../types.ts";

const BASE: GithubReadParams = {
  operation: "",
  repository: "psmfd/pi-config",
  number: 123,
  projectNumber: 3,
  ref: "dev",
  threadId: "42",
  limit: 10,
};

for (const [domain, operations] of Object.entries(DOMAIN_OPERATIONS) as [GithubDomain, readonly string[]][]) {
  for (const operation of operations) {
    test(`${domain}/${operation} builds a fixed read-only argv`, () => {
      const plan = buildOperationPlan(domain, { ...BASE, operation });
      assert.doesNotThrow(() => assertReadOnlyPlan(plan));
      assert.equal(plan.args.some((arg) => ["POST", "PUT", "PATCH", "DELETE", "-f", "-F", "--input"].includes(arg)), false);
      assert.equal(plan.args.some((arg) => arg.includes("\u0000")), false);
    });
  }
}

test("repository validation rejects option and shell-shaped input", () => {
  for (const repository of ["-R/evil", "owner/repo;touch", "owner/$(id)", "owner/repo\nnext", "owner/../repo"]) {
    assert.throws(() => buildOperationPlan("repository", { operation: "view", repository }));
  }
});

test("query remains one argv element", () => {
  const query = 'bug; $(touch /tmp/nope) "quoted"';
  const plan = buildOperationPlan("issues", { operation: "list", repository: "psmfd/pi-config", query });
  assert.equal(plan.args.filter((arg) => arg === query).length, 1);
  assert.doesNotThrow(() => assertReadOnlyPlan(plan));
});

test("mutation-shaped words are safe in validated data positions", () => {
  for (const query of ["create", "run", "delete", "POST", "--input"]) {
    const plan = buildOperationPlan("issues", { operation: "list", repository: "psmfd/pi-config", query });
    assert.doesNotThrow(() => assertReadOnlyPlan(plan));
  }
});

test("page is honored or explicitly rejected by every operation", () => {
  for (const [domain, operations] of Object.entries(DOMAIN_OPERATIONS) as [GithubDomain, readonly string[]][]) {
    for (const operation of operations) {
      try {
        const plan = buildOperationPlan(domain, { ...BASE, operation, page: 2 });
        assert.match(plan.args.join(" "), /(?:page=2|--page 2)/, `${domain}/${operation} silently ignored page 2`);
      } catch (error) {
        assert.match(String(error), /page 1 only/, `${domain}/${operation} rejected page for an unrelated reason`);
      }
    }
  }
});

test("review and comment bodies require explicit opt-in", () => {
  for (const operation of ["reviews", "comments"]) {
    const metadataOnly = buildOperationPlan("pull_requests", { ...BASE, operation, includeBody: false });
    assert.equal(metadataOnly.fields?.includes("body"), false);
    const withBody = buildOperationPlan("pull_requests", { ...BASE, operation, includeBody: true });
    assert.equal(withBody.fields?.includes("body"), true);
  }
  const viewMetadata = buildOperationPlan("pull_requests", { ...BASE, operation: "view", includeBody: false });
  assert.equal(viewMetadata.fields?.includes("reviews"), false);
  assert.equal(viewMetadata.fields?.includes("comments"), false);
  const viewContent = buildOperationPlan("pull_requests", { ...BASE, operation: "view", includeBody: true });
  assert.equal(viewContent.fields?.includes("reviews"), true);
  assert.equal(viewContent.fields?.includes("comments"), true);
});

test("security alert states are endpoint-specific", () => {
  assert.doesNotThrow(() => buildOperationPlan("security", { ...BASE, operation: "code_scanning", state: "fixed" }));
  assert.doesNotThrow(() => buildOperationPlan("security", { ...BASE, operation: "dependabot", state: "auto_dismissed" }));
  assert.doesNotThrow(() => buildOperationPlan("security", { ...BASE, operation: "secret_scanning", state: "resolved" }));
  assert.throws(() => buildOperationPlan("security", { ...BASE, operation: "secret_scanning", state: "closed" }), /state must be one of/);
  assert.throws(() => buildOperationPlan("issues", { ...BASE, operation: "list", state: "resolved" }), /state must be one of/);
});

test("Actions check metadata excludes report text", () => {
  const plan = buildOperationPlan("actions", { ...BASE, operation: "checks" });
  const fields = JSON.stringify(plan.fields);
  assert.doesNotMatch(fields, /summary|title/);
  assert.match(fields, /annotations_count/);
});

test("assertion rejects mutation and unknown command shapes", () => {
  assert.throws(() => assertReadOnlyPlan({ args: ["issue", "create"], format: "json", containsUntrustedContent: true }));
  assert.throws(() => assertReadOnlyPlan({ args: ["api", "--hostname", "github.com", "--method", "POST", "repos/x/y"], format: "json", containsUntrustedContent: true }));
});
