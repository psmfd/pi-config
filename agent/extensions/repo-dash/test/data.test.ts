import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchRows, resolveRepository, toRows, type GhRunner } from "../data.ts";
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
