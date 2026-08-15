import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchRows, fetchRuns, resolveRepository, toRows, toRunRows, type GhRunner } from "../data.ts";
import type { GhRunResult } from "../../shared/github-read-types.ts";

function ok(stdout: string): GhRunResult {
  return { stdout, stderr: "", exitCode: 0, stdoutBytes: stdout.length, stderrBytes: 0, authSource: "gh-config" };
}

function fail(stderr: string, exitCode = 1): GhRunResult {
  return { stdout: "", stderr, exitCode, stdoutBytes: 0, stderrBytes: stderr.length, authSource: "gh-config" };
}

function recorder(result: GhRunResult): { run: GhRunner; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const run: GhRunner = (args) => { calls.push(args); return Promise.resolve(result); };
  return { run, calls };
}

test("toRows maps projected records onto panel rows", () => {
  const rows = toRows([
    { number: 981, title: "repo-dash", state: "OPEN", author: { login: "octocat" }, updatedAt: "2026-08-13T10:00:00Z" },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    number: 981,
    title: "repo-dash",
    state: "OPEN",
    author: "octocat",
    updatedAt: "2026-08-13T10:00:00Z",
  });
});

test("toRows sanitizes the free-text fields at construction (#989)", () => {
  // The panel renders row.title straight into a SelectList label, and pi-tui's
  // truncateToWidth deliberately preserves ANSI and returns short strings
  // byte-for-byte — so a row must never carry unsanitized text in the first
  // place. Sanitizing here rather than at each sink is what makes that true for
  // every current and future consumer of a DashRow.
  const esc = String.fromCharCode(0x1b);
  const [row] = toRows([
    {
      number: 1,
      title: `${esc}[31mred\u202Eevil\u200B\u{E0041}`,
      state: "OPEN",
      author: { login: `oct\u200Bocat${esc}[0m` },
      updatedAt: "2026-08-13T10:00:00Z",
    },
  ]);
  // ESC became a space (controls sit between words); the bidi override, the
  // zero-width space, and the tag character were deleted outright, so the words
  // they separated close up.
  assert.equal(row?.title, "[31mredevil");
  assert.equal(row?.author, "octocat [0m");
});

test("toRows leaves row titles unbounded — the 80-point cap is the reference's", () => {
  const [row] = toRows([{ number: 1, title: "w".repeat(300) }]);
  assert.equal(row?.title.length, 300);
});

test("toRows carries isDraft only when gh actually supplied it", () => {
  const [pr] = toRows([{ number: 1, title: "t", isDraft: true }]);
  assert.equal(pr?.isDraft, true);
  const [issue] = toRows([{ number: 2, title: "t" }]);
  assert.ok(issue && !("isDraft" in issue));
});

test("toRows drops malformed records instead of throwing", () => {
  // A panel that dies on one bad record is worse than one that omits it.
  const rows = toRows([{ number: 1, title: "keep" }, null, "nonsense", { title: "no number" }, { number: 1.5 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.number, 1);
});

test("toRows tolerates a non-array payload", () => {
  assert.deepEqual(toRows({ unexpected: true }), []);
  assert.deepEqual(toRows(null), []);
});

test("toRows defaults absent string fields rather than emitting undefined", () => {
  const [row] = toRows([{ number: 7 }]);
  assert.equal(row?.title, "");
  assert.equal(row?.author, "");
  assert.equal(row?.state, "");
});

// --- #987: workflow runs -----------------------------------------------------

/** The Actions API wraps its list; issues/PRs return a bare array. */
function runsPayload(runs: unknown[]): unknown {
  return { total_count: runs.length, workflow_runs: runs };
}

function runRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 900100,
    run_number: 12,
    name: "validate",
    display_title: "fix(repo-dash): a thing",
    status: "completed",
    conclusion: "success",
    head_branch: "dev",
    event: "push",
    actor: { login: "octocat" },
    updated_at: "2026-08-14T09:00:00Z",
    ...overrides,
  };
}

test("toRunRows unwraps workflow_runs rather than expecting a bare array", () => {
  // The bug this guards: toRows' Array.isArray guard would return [] for every
  // Actions response, silently yielding an always-empty /ci panel.
  const rows = toRunRows(runsPayload([runRecord()]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 900100);
  assert.equal(rows[0]?.conclusion, "success");
  assert.equal(rows[0]?.status, "completed");
});

test("toRunRows returns no rows for a bare array or a missing wrapper key", () => {
  assert.deepEqual(toRunRows([runRecord()]), []);
  assert.deepEqual(toRunRows({ total_count: 1 }), []);
  assert.deepEqual(toRunRows(null), []);
});

test("toRunRows keeps status and conclusion distinct", () => {
  // #987: do not map conclusion onto state and lose the distinction.
  const [row] = toRunRows(runsPayload([runRecord({ status: "in_progress", conclusion: null })]));
  assert.equal(row?.status, "in_progress");
  assert.equal(row?.conclusion, null);
});

test("toRunRows sanitizes the free-text run fields (#989 posture)", () => {
  const esc = String.fromCharCode(0x1b);
  const [row] = toRunRows(runsPayload([runRecord({
    display_title: `${esc}[31mred\u202Eevil`,
    name: "vali\u200Bdate",
    head_branch: "feat/\u200Bsneaky",
    actor: { login: "oct\u200Bocat" },
  })]));
  assert.equal(row?.displayTitle, "[31mredevil");
  assert.equal(row?.workflowName, "validate");
  assert.equal(row?.headBranch, "feat/sneaky");
  assert.equal(row?.actor, "octocat");
});

test("toRunRows leaves fixed vocabularies and identifiers untouched", () => {
  const [row] = toRunRows(runsPayload([runRecord({ status: "completed", conclusion: "timed_out", event: "workflow_dispatch" })]));
  assert.equal(row?.status, "completed");
  assert.equal(row?.conclusion, "timed_out");
  assert.equal(row?.event, "workflow_dispatch");
  assert.equal(row?.updatedAt, "2026-08-14T09:00:00Z");
});

test("toRunRows drops malformed records instead of throwing", () => {
  const rows = toRunRows(runsPayload([runRecord(), null, "nonsense", { run_number: 3 }, { id: 1.5 }]));
  assert.equal(rows.length, 1);
});

test("fetchRuns issues a read-only Actions vector and honours the branch filter", async () => {
  const { run, calls } = recorder(ok(JSON.stringify(runsPayload([runRecord()]))));
  const rows = await fetchRuns("psmfd/pi-config", "dev", undefined, run);
  assert.equal(rows.length, 1);
  const args = calls[0] ?? [];
  // Same allowlisted api-GET prefix the model-facing reader uses.
  assert.deepEqual(args.slice(0, 5), ["api", "--hostname", "github.com", "--method", "GET"]);
  assert.ok(args.some((a) => a.includes("actions/runs")));
  assert.ok(args.some((a) => a.includes("branch=dev")));
  assert.ok(!args.some((a) => a === "-f" || a === "--input" || a === "--field"));
});

test("fetchRuns omits the branch filter when there is no branch", async () => {
  const { run, calls } = recorder(ok(JSON.stringify(runsPayload([]))));
  await fetchRuns("psmfd/pi-config", undefined, undefined, run);
  assert.ok(!(calls[0] ?? []).some((a) => a.includes("branch=")));
});

test("fetchRuns propagates a gh failure with a sanitized diagnostic", async () => {
  const { run } = recorder(fail("gh: rate limit exceeded"));
  await assert.rejects(fetchRuns("psmfd/pi-config", undefined, undefined, run), /rate limit exceeded/);
});

test("resolveRepository reads nameWithOwner from an allowlisted gh shape", async () => {
  const { run, calls } = recorder(ok(JSON.stringify({ nameWithOwner: "psmfd/pi-config" })));
  assert.equal(await resolveRepository(undefined, run), "psmfd/pi-config");
  assert.deepEqual(calls[0], ["repo", "view", "--json", "nameWithOwner"]);
});

test("resolveRepository surfaces a gh failure with sanitized diagnostics", async () => {
  const { run } = recorder(fail("not a git repository"));
  await assert.rejects(resolveRepository(undefined, run), /not a git repository/);
});

test("resolveRepository rejects a payload without a usable repository", async () => {
  const { run } = recorder(ok(JSON.stringify({})));
  await assert.rejects(resolveRepository(undefined, run), /no nameWithOwner/);
});

test("fetchRows issues a read-only issue-list vector", async () => {
  const { run, calls } = recorder(ok(JSON.stringify([{ number: 1, title: "a" }])));
  const rows = await fetchRows("issues", "psmfd/pi-config", undefined, run);
  assert.equal(rows.length, 1);
  const args = calls[0] ?? [];
  assert.equal(args[0], "issue");
  assert.equal(args[1], "list");
  assert.ok(args.includes("--state") && args.includes("open"));
  assert.ok(!args.some((a) => a === "--method" || a === "-f" || a === "--input"));
});

test("fetchRows issues a read-only pr-list vector", async () => {
  const { run, calls } = recorder(ok(JSON.stringify([])));
  await fetchRows("prs", "psmfd/pi-config", undefined, run);
  const args = calls[0] ?? [];
  assert.equal(args[0], "pr");
  assert.equal(args[1], "list");
});

test("fetchRows refuses a repository that is not explicit owner/name", async () => {
  const { run } = recorder(ok("[]"));
  await assert.rejects(fetchRows("issues", "not-a-repo", undefined, run), /owner\/name/);
});

test("fetchRows propagates a gh failure", async () => {
  const { run } = recorder(fail("gh: rate limit exceeded"));
  await assert.rejects(fetchRows("issues", "psmfd/pi-config", undefined, run), /rate limit exceeded/);
});

test("fetchRows rejects malformed JSON rather than rendering a broken panel", async () => {
  const { run } = recorder(ok("{not json"));
  await assert.rejects(fetchRows("issues", "psmfd/pi-config", undefined, run), /malformed JSON/);
});
