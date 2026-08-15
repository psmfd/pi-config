import assert from "node:assert/strict";
import { test } from "node:test";

import type { DashRow, DashRunRow } from "../data.ts";
import { itemSpec, runSpec, toRunSelectItems, toSelectItems } from "../panel.ts";

function row(overrides: Partial<DashRow> = {}): DashRow {
  return { number: 981, title: "repo-dash panels", state: "OPEN", author: "octocat", updatedAt: "2026-08-13T10:00:00Z", ...overrides };
}

function runRow(overrides: Partial<DashRunRow> = {}): DashRunRow {
  return {
    id: 900100,
    runNumber: 12,
    workflowName: "validate",
    displayTitle: "fix(repo-dash): a thing",
    status: "completed",
    conclusion: "success",
    headBranch: "dev",
    event: "push",
    actor: "octocat",
    updatedAt: "2026-08-14T09:00:00Z",
    ...overrides,
  };
}

test("itemSpec keys and references issues by their shared-namespace number", () => {
  const spec = itemSpec("issues");
  assert.equal(spec.keyOf(row()), "981");
  assert.equal(spec.buildReference(row()), '#981 "repo-dash panels"');
  assert.equal(spec.toSelectItem(row()).label, "#981 repo-dash panels");
});

test("itemSpec headings distinguish issues from pull requests, and empty from populated", () => {
  assert.match(itemSpec("issues").heading, /Open issues/);
  assert.match(itemSpec("prs").heading, /Open pull requests/);
  assert.match(itemSpec("prs").emptyHeading, /none found/);
});

test("toSelectItems keeps the Phase 1 label shape", () => {
  const [item] = toSelectItems([row()]);
  assert.equal(item?.value, "981");
  assert.match(item?.description ?? "", /open/);
  assert.match(item?.description ?? "", /@octocat/);
});

// --- #987: runs are keyed and referenced differently -------------------------

test("runSpec keys runs by id, never by the per-workflow run number", () => {
  // run_number collides across workflows; id is the repo-unique key AND the one
  // the Actions `run` view operation takes.
  const spec = runSpec;
  assert.equal(spec.keyOf(runRow()), "900100");
  assert.notEqual(spec.keyOf(runRow()), "12");
});

test("runSpec builds a run reference, not a # reference", () => {
  // A `#12` reference would collide with the issue/PR namespace and point at
  // the wrong thing entirely.
  const reference = runSpec.buildReference(runRow());
  assert.equal(reference, 'run 900100 "fix(repo-dash): a thing"');
  assert.ok(!reference.startsWith("#"));
});

test("runSpec surfaces the outcome, not merely the status", () => {
  const failed = runSpec.toSelectItem(runRow({ conclusion: "failure" }));
  assert.match(failed.description ?? "", /failure/);
  // A completed-but-failed run must never read as merely "completed".
  assert.ok(!/completed/.test(failed.description ?? ""));

  const running = runSpec.toSelectItem(runRow({ status: "in_progress", conclusion: null }));
  assert.match(running.description ?? "", /running/);
});

test("runSpec labels lead with the outcome glyph and show the run number for recognition", () => {
  const item = runSpec.toSelectItem(runRow());
  assert.match(item.label, /^\+ validate #12 /);
});

test("toRunSelectItems maps a whole list", () => {
  const items = toRunSelectItems([runRow(), runRow({ id: 900101, conclusion: "failure" })]);
  assert.equal(items.length, 2);
  assert.equal(items[1]?.value, "900101");
  assert.match(items[1]?.label ?? "", /^x /);
});

test("the two specs are independent — a run never produces an issue-shaped reference", () => {
  const issueRef = itemSpec("issues").buildReference(row());
  const runRef = runSpec.buildReference(runRow());
  assert.notEqual(issueRef.split(" ")[0], runRef.split(" ")[0]);
});
