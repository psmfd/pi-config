import assert from "node:assert/strict";
import { test } from "node:test";

import type { DashRunRow } from "../data.ts";
import {
  CiWidgetPoller,
  MAX_BACKOFF_MS,
  POLL_INTERVAL_MS,
  STALE_AFTER_MS,
  describeWidgetState,
  formatAge,
  formatWidgetLines,
  latestPerWorkflow,
  type CiLoadResult,
  type CiSnapshot,
  type PollerDeps,
} from "../widget.ts";

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

const T0 = 1_760_000_000_000;

function snapshot(rows: readonly DashRunRow[], fetchedAtMs = T0): CiSnapshot {
  return { rows, fetchedAtMs };
}

// --- latestPerWorkflow --------------------------------------------------------

test("latestPerWorkflow keeps only the newest run of each workflow", () => {
  const rows = [
    runRow({ id: 1, workflowName: "validate", updatedAt: "2026-08-14T08:00:00Z" }),
    runRow({ id: 2, workflowName: "validate", updatedAt: "2026-08-14T09:00:00Z" }),
    runRow({ id: 3, workflowName: "tests", updatedAt: "2026-08-14T07:00:00Z" }),
  ];
  const picked = latestPerWorkflow(rows);
  assert.deepEqual(picked.map((row) => row.id), [2, 3]);
});

test("latestPerWorkflow does not trust the API's ordering", () => {
  // The Actions endpoint returns most-recent-first today. The widget claims to
  // show the CURRENT state, so an oldest-first response must not silently make
  // that claim false.
  const rows = [
    runRow({ id: 1, workflowName: "validate", conclusion: "failure", updatedAt: "2026-08-14T08:00:00Z" }),
    runRow({ id: 2, workflowName: "validate", conclusion: "success", updatedAt: "2026-08-14T09:00:00Z" }),
  ];
  assert.equal(latestPerWorkflow(rows)[0]?.id, 2);
});

test("latestPerWorkflow sorts a missing timestamp last rather than letting it win", () => {
  const rows = [
    runRow({ id: 1, workflowName: "validate", updatedAt: "" }),
    runRow({ id: 2, workflowName: "validate", updatedAt: "2026-08-14T09:00:00Z" }),
  ];
  assert.equal(latestPerWorkflow(rows)[0]?.id, 2);
});

test("latestPerWorkflow honours the workflow cap", () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map((name, index) =>
    runRow({ id: index, workflowName: name }));
  assert.equal(latestPerWorkflow(rows).length, 4);
  assert.equal(latestPerWorkflow(rows, 2).length, 2);
});

test("latestPerWorkflow falls back to the run id when a workflow has no name", () => {
  // Two nameless runs are two workflows, not one collapsed row.
  const rows = [runRow({ id: 1, workflowName: "" }), runRow({ id: 2, workflowName: "" })];
  assert.equal(latestPerWorkflow(rows).length, 2);
});

// --- formatAge ----------------------------------------------------------------

test("formatAge renders coarse, bounded ages", () => {
  assert.equal(formatAge(0), "just now");
  assert.equal(formatAge(59_000), "just now");
  assert.equal(formatAge(60_000), "1m ago");
  assert.equal(formatAge(90 * 60_000), "1h ago");
  assert.equal(formatAge(49 * 60 * 60_000), "2d ago");
});

// --- formatWidgetLines --------------------------------------------------------

test("formatWidgetLines reserves no space before the first result", () => {
  // A placeholder line above the editor on every session start would be a
  // permanent cost for a feature that has nothing to say yet.
  assert.equal(formatWidgetLines(undefined, T0), undefined);
});

test("formatWidgetLines reports an error when there is no snapshot to fall back on", () => {
  const lines = formatWidgetLines(undefined, T0, "gh exited 1");
  assert.deepEqual(lines, ["CI  ? unavailable — gh exited 1"]);
});

test("formatWidgetLines says so when the repository has no runs", () => {
  assert.deepEqual(formatWidgetLines(snapshot([]), T0), ["CI  no recent workflow runs"]);
});

test("formatWidgetLines leads with outcome glyphs and trails with branch and age", () => {
  const lines = formatWidgetLines(
    snapshot([
      runRow({ id: 1, workflowName: "validate", conclusion: "success" }),
      runRow({ id: 2, workflowName: "tests", conclusion: "failure" }),
    ]),
    T0 + 3 * 60_000,
  );
  assert.equal(lines?.length, 2);
  assert.equal(lines?.[0], "CI  + validate · x tests");
  assert.equal(lines?.[1], "    dev · 3m ago");
});

test("formatWidgetLines shows a completed-but-failed run as failed, never as completed", () => {
  const lines = formatWidgetLines(snapshot([runRow({ status: "completed", conclusion: "failure" })]), T0);
  assert.match(lines?.[0] ?? "", /^CI {2}x /);
});

test("formatWidgetLines attaches a branch per entry when the runs span branches", () => {
  // A single trailing branch would imply a filter this widget does not apply.
  const lines = formatWidgetLines(
    snapshot([
      runRow({ id: 1, workflowName: "validate", headBranch: "dev" }),
      runRow({ id: 2, workflowName: "tests", headBranch: "feat/thing" }),
    ]),
    T0,
  );
  assert.equal(lines?.[0], "CI  + validate@dev · + tests@feat/thing");
  assert.equal(lines?.[1], "    just now");
});

test("formatWidgetLines marks a stale snapshot rather than blanking it", () => {
  // An empty widget reads as "CI is fine". Marked-stale is the honest claim.
  const lines = formatWidgetLines(snapshot([runRow()]), T0 + STALE_AFTER_MS);
  assert.match(lines?.[1] ?? "", /stale/);
  assert.match(lines?.[0] ?? "", /validate/);
});

test("formatWidgetLines names the failure alongside the staleness marker", () => {
  const lines = formatWidgetLines(snapshot([runRow()]), T0 + STALE_AFTER_MS, "API rate limit exceeded");
  assert.match(lines?.[1] ?? "", /stale — API rate limit exceeded/);
});

test("formatWidgetLines is not stale immediately below the threshold", () => {
  const lines = formatWidgetLines(snapshot([runRow()]), T0 + STALE_AFTER_MS - 1);
  assert.ok(!/stale/.test(lines?.[1] ?? ""));
});

test("formatWidgetLines bounds long workflow and branch names", () => {
  const lines = formatWidgetLines(
    snapshot([
      runRow({ id: 1, workflowName: "a".repeat(80), headBranch: "dev" }),
      runRow({ id: 2, workflowName: "tests", headBranch: "b".repeat(80) }),
    ]),
    T0,
  );
  // Both names are clipped, so one pathological workflow name cannot push the
  // rest of the line off the terminal.
  assert.ok((lines?.[0].length ?? 0) < 70, lines?.[0]);
  assert.match(lines?.[0] ?? "", /…/);
});

test("formatWidgetLines emits only ASCII glyphs for outcomes", () => {
  // The terminal's font and width behaviour are unknown; a wide emoji shifts
  // the line. The ellipsis is the one intentional non-ASCII character.
  const lines = formatWidgetLines(
    snapshot([
      runRow({ id: 1, workflowName: "a", status: "in_progress", conclusion: null }),
      runRow({ id: 2, workflowName: "b", status: "queued", conclusion: null }),
      runRow({ id: 3, workflowName: "c", conclusion: "timed_out" }),
      runRow({ id: 4, workflowName: "d", conclusion: "action_required" }),
    ]),
    T0,
  );
  assert.equal(lines?.[0], "CI  > a · . b · x c · ! d");
});

// --- describeWidgetState ------------------------------------------------------

test("describeWidgetState reports OFF without inventing data", () => {
  assert.equal(describeWidgetState(false, undefined, T0), "repo-dash CI widget: OFF");
});

test("describeWidgetState distinguishes 'no data yet' from a failed poll", () => {
  assert.match(describeWidgetState(true, undefined, T0), /no data yet/);
  assert.match(describeWidgetState(true, undefined, T0, "boom"), /last poll failed: boom/);
});

test("describeWidgetState spells outcomes out, unlike the width-bound widget line", () => {
  const text = describeWidgetState(true, snapshot([runRow({ conclusion: "failure" })]), T0);
  assert.match(text, /validate failure/);
  assert.match(text, /just now/);
});

// --- CiWidgetPoller -----------------------------------------------------------

interface Harness {
  readonly deps: PollerDeps;
  readonly emitted: (string[] | undefined)[];
  loads: number;
  nowMs: number;
  idle: boolean;
  result: () => Promise<CiLoadResult>;
}

function harness(overrides: Partial<Pick<Harness, "idle">> = {}): Harness {
  const state: Harness = {
    emitted: [],
    loads: 0,
    nowMs: T0,
    idle: overrides.idle ?? true,
    result: () => Promise.resolve({ rows: [runRow()] }),
    deps: {
      load: async () => {
        state.loads += 1;
        return state.result();
      },
      emit: (lines) => { state.emitted.push(lines); },
      now: () => state.nowMs,
      isIdle: () => state.idle,
    },
  };
  return state;
}

test("the poller never spawns gh while the agent is busy", () => {
  // This is the constraint #987 calls the point of the feature.
  const h = harness({ idle: false });
  const poller = new CiWidgetPoller(h.deps);
  return poller.tick().then(() => {
    assert.equal(h.loads, 0);
    // Not even a repaint — a busy session gets no widget churn at all.
    assert.equal(h.emitted.length, 0);
  });
});

test("the poller fetches once and renders on the first idle tick", async () => {
  const h = harness();
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  assert.equal(h.loads, 1);
  assert.match(h.emitted.at(-1)?.[0] ?? "", /validate/);
});

test("the interval floor holds even when tick is called repeatedly", async () => {
  const h = harness();
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  h.nowMs += POLL_INTERVAL_MS - 1;
  await poller.tick();
  await poller.tick();
  assert.equal(h.loads, 1, "a sub-interval tick must not re-fetch");
  h.nowMs += 1;
  await poller.tick();
  assert.equal(h.loads, 2);
});

test("a refused tick still repaints, so the age and staleness marker advance", async () => {
  const h = harness();
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  const before = h.emitted.length;
  h.nowMs += STALE_AFTER_MS;
  await poller.tick();
  // Eligible again at +5m, so this one actually fetches; check the sub-interval
  // case separately.
  const h2 = harness();
  const poller2 = new CiWidgetPoller(h2.deps);
  await poller2.tick();
  h2.nowMs += 30_000;
  await poller2.tick();
  assert.equal(h2.loads, 1);
  assert.equal(h2.emitted.length, 2, "the refused tick must still emit");
  assert.ok(h.emitted.length > before);
});

test("a slow load does not accumulate overlapping gh children", async () => {
  const h = harness();
  let release: (() => void) | undefined;
  h.result = () => new Promise((resolve) => {
    release = () => { resolve({ rows: [runRow()] }); };
  });
  const poller = new CiWidgetPoller(h.deps);
  const first = poller.tick();
  // The interval keeps firing while the first fetch is outstanding.
  h.nowMs += POLL_INTERVAL_MS * 5;
  await poller.tick();
  await poller.tick();
  assert.equal(h.loads, 1, "single-flight guard must hold");
  release?.();
  await first;
  assert.equal(h.loads, 1);
});

test("agent_settled-style ticks cannot poll faster than the floor", async () => {
  // Many short turns in quick succession must not turn the edge trigger into a
  // hammer against the same rate limit the model's tools draw on.
  const h = harness();
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  // 100 one-second turns: long enough to cross the 60s floor exactly once.
  for (let i = 0; i < 100; i += 1) {
    h.nowMs += 1_000;
    await poller.tick();
  }
  assert.equal(h.loads, 2, "101 settles across 100s must yield exactly 2 polls, not 101");
});

test("a long turn means the settle tick gets fresh data immediately", async () => {
  const h = harness();
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  // Busy for five minutes: every interval tick is refused by the idle gate.
  h.idle = false;
  for (let i = 0; i < 5; i += 1) {
    h.nowMs += POLL_INTERVAL_MS;
    await poller.tick();
  }
  assert.equal(h.loads, 1);
  h.idle = true;
  await poller.tick();
  assert.equal(h.loads, 2, "the settle tick must refresh a stale widget at once");
});

test("a failed poll keeps the last good snapshot and marks it stale", async () => {
  const h = harness();
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  h.result = () => Promise.reject(new Error("gh exited 1"));
  h.nowMs += STALE_AFTER_MS;
  await poller.tick();
  const lines = h.emitted.at(-1);
  assert.match(lines?.[0] ?? "", /validate/, "the prior snapshot must survive");
  assert.match(lines?.[1] ?? "", /stale — gh exited 1/);
  assert.equal(poller.getLastError(), "gh exited 1");
});

test("failures back off exponentially and clamp at the ceiling", async () => {
  const h = harness();
  h.result = () => Promise.reject(new Error("nope"));
  const poller = new CiWidgetPoller(h.deps);

  await poller.tick();
  assert.equal(h.loads, 1);

  // After one failure the next attempt is 2x the interval away, not 1x.
  h.nowMs += POLL_INTERVAL_MS;
  await poller.tick();
  assert.equal(h.loads, 1, "backoff must exceed the normal interval");

  h.nowMs += POLL_INTERVAL_MS;
  await poller.tick();
  assert.equal(h.loads, 2);

  // Drive the failure count high enough that the raw doubling would exceed the
  // ceiling, then confirm one ceiling-length wait is sufficient.
  for (let i = 0; i < 10; i += 1) {
    h.nowMs += MAX_BACKOFF_MS;
    await poller.tick();
  }
  // Annotated: node:assert/strict's `equal` is an assertion signature, so the
  // two `assert.equal(h.loads, …)` calls above have narrowed the field to
  // `1 & 2` — i.e. `never` — and arithmetic on it would not typecheck.
  const before: number = h.loads;
  h.nowMs += MAX_BACKOFF_MS;
  await poller.tick();
  assert.equal(h.loads, before + 1, "backoff must clamp rather than grow without bound");
});

test("a success clears the backoff", async () => {
  const h = harness();
  h.result = () => Promise.reject(new Error("nope"));
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  h.nowMs += MAX_BACKOFF_MS;
  h.result = () => Promise.resolve({ rows: [runRow()] });
  await poller.tick();
  assert.equal(h.loads, 2);
  assert.equal(poller.getLastError(), undefined);
  // Back to the normal cadence, not still backed off.
  h.nowMs += POLL_INTERVAL_MS;
  await poller.tick();
  assert.equal(h.loads, 3);
});

test("stop() halts polling and emits nothing", async () => {
  // Emitting on stop would recurse straight back into stop() when the reason
  // for stopping is that emit just threw.
  const h = harness();
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  const emitted = h.emitted.length;
  poller.stop();
  h.nowMs += POLL_INTERVAL_MS * 10;
  await poller.tick();
  poller.render();
  assert.equal(h.loads, 1);
  assert.equal(h.emitted.length, emitted, "stop() must be silent");
});

test("a load resolving after stop() does not repaint a torn-down widget", async () => {
  const h = harness();
  let release: ((loaded: CiLoadResult) => void) | undefined;
  h.result = () => new Promise((resolve) => { release = resolve; });
  const poller = new CiWidgetPoller(h.deps);
  const pending = poller.tick();
  poller.stop();
  release?.({ rows: [runRow()] });
  await pending;
  assert.equal(h.emitted.length, 0);
  assert.equal(poller.getSnapshot(), undefined);
});

// --- #1005: branch scoping ----------------------------------------------------

test("a scoped snapshot names the branch when it has no runs", () => {
  // "no recent workflow runs" and "no recent runs for dev" are different
  // claims, and on a freshly pushed branch the second is the true one.
  const lines = formatWidgetLines({ rows: [], fetchedAtMs: T0, branch: "dev" }, T0);
  assert.deepEqual(lines, ["CI  no recent runs for dev"]);
});

test("an unscoped empty snapshot does not invent a branch", () => {
  assert.deepEqual(formatWidgetLines({ rows: [], fetchedAtMs: T0 }, T0), ["CI  no recent workflow runs"]);
});

test("a scoped snapshot reports its branch once, not per entry", () => {
  // Scoping makes every row share a branch, so the per-entry form collapses on
  // its own — no special case needed for the scoped path.
  const lines = formatWidgetLines(
    {
      rows: [
        runRow({ id: 1, workflowName: "validate", headBranch: "dev" }),
        runRow({ id: 2, workflowName: "tests", headBranch: "dev" }),
      ],
      fetchedAtMs: T0,
      branch: "dev",
    },
    T0,
  );
  assert.equal(lines?.[0], "CI  + validate · + tests");
  assert.equal(lines?.[1], "    dev · just now");
});

test("a scoped-and-empty widget never falls back to other branches' runs", () => {
  // Showing repo-wide activity under a scoped widget is the misleading outcome
  // scoping exists to remove.
  const lines = formatWidgetLines({ rows: [], fetchedAtMs: T0, branch: "feat/thing" }, T0);
  assert.equal(lines?.length, 1);
  assert.ok(!/validate|tests/.test(lines?.[0] ?? ""));
});

test("a long branch name is clipped in the empty message", () => {
  const lines = formatWidgetLines({ rows: [], fetchedAtMs: T0, branch: "b".repeat(80) }, T0);
  assert.ok((lines?.[0].length ?? 0) < 45, lines?.[0]);
  assert.match(lines?.[0] ?? "", /…/);
});

test("the poller records the branch its load was scoped to", async () => {
  const h = harness();
  h.result = () => Promise.resolve({ rows: [runRow()], branch: "dev" });
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  assert.equal(poller.getSnapshot()?.branch, "dev");
});

test("an unscopable session yields a snapshot with no branch", async () => {
  // Detached HEAD, no repository, or no git — all resolve to undefined, and the
  // widget must fall back to the repository-wide view rather than error.
  const h = harness();
  h.result = () => Promise.resolve({ rows: [runRow()] });
  const poller = new CiWidgetPoller(h.deps);
  await poller.tick();
  assert.equal(poller.getSnapshot()?.branch, undefined);
  assert.match(h.emitted.at(-1)?.[0] ?? "", /validate/);
});
