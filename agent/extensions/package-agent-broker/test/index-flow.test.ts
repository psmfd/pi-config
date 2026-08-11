/**
 * index-flow.test.ts — integration coverage for the orchestration layer:
 * the input gate (ctx.mode / event.source / event.streamingBehavior), command
 * dispatch, the page-review consent contract, retype confirmation, the
 * display-to-commit CAS, and terminal-safety of every notification path
 * (#916, ADR-0128).
 *
 * The extension factory is driven through a fake ExtensionAPI/ExtensionContext
 * so the real handler runs against a temp agentDir and temp state root — no pi
 * runtime required. This suite exists because both Error-severity findings of
 * the first review lived in exactly this untested layer.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

import brokerFactory from "../index.ts";

const HOST = "github.com";
const REPO = "psmfd/pi-work-item-client";
const REF = "v1.0.0";
const SOURCE = `git:${HOST}/${REPO}@${REF}`;
const AGENT = "work-item-planner";
const QID = `git:${HOST}/${REPO}@${REF}#${AGENT}`;

/** Env restorers registered by makeHarness, drained after each test. */
const restoreEnvHooks: Array<() => void> = [];
afterEach(() => {
  while (restoreEnvHooks.length > 0) (restoreEnvHooks.pop() as () => void)();
});

const ESC = "\u001b";
const RLO = "\u202e";

type InputHandler = (
  event: { type: "input"; text: string; source: string; streamingBehavior?: string },
  ctx: FakeCtx,
) => Promise<{ action: string } | void>;

interface FakeCtx {
  mode: string;
  hasUI: boolean;
  ui: {
    notify: (message: string, level?: string) => void;
    confirm: (title: string, message: string) => Promise<boolean>;
    input: (title: string) => Promise<string | undefined>;
  };
}

interface Harness {
  handler: InputHandler;
  notices: string[];
  confirmed: string[];
  ctx: FakeCtx;
  agentDir: string;
  stateRoot: string;
  send: (text: string, over?: { source?: string; streamingBehavior?: string; mode?: string }) => Promise<string>;
}

/** Descriptor + optional wrapper installed as a pinned-git user-scope package. */
function installPackage(
  agentDir: string,
  opts: { prompt?: string; extraFileName?: string; agentName?: string } = {},
): void {
  const name = opts.agentName ?? AGENT;
  const agents = path.join(agentDir, "git", HOST, ...REPO.split("/"), "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(
    path.join(agents, `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      description: "Plans work items.",
      prompt: opts.prompt ?? "You are a proposal-only planner.",
      tools: ["read"],
    }),
  );
  if (opts.extraFileName !== undefined) {
    fs.writeFileSync(path.join(agents, opts.extraFileName), "{}");
  }
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ packages: [SOURCE] }),
  );
}

function makeHarness(opts: {
  confirmAnswers?: boolean[];
  inputAnswers?: (string | undefined)[];
} = {}): Harness {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pab-flow-agent-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pab-flow-state-"));
  fs.chmodSync(stateRoot, 0o700);
  // Capture-and-restore so harnesses cannot leak env into each other or into
  // other suites; index.ts re-reads process.env on every dispatch.
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevStateHome = process.env.XDG_STATE_HOME;
  restoreEnvHooks.push(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevStateHome;
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.XDG_STATE_HOME = stateRoot;

  const notices: string[] = [];
  const confirmed: string[] = [];
  const confirmQueue = [...(opts.confirmAnswers ?? [])];
  const inputQueue = [...(opts.inputAnswers ?? [])];

  const ctx: FakeCtx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => notices.push(message),
      confirm: (title: string, message: string) => {
        confirmed.push(`${title}\n${message}`);
        return Promise.resolve(confirmQueue.length > 0 ? (confirmQueue.shift() as boolean) : true);
      },
      input: () => Promise.resolve(inputQueue.length > 0 ? inputQueue.shift() : undefined),
    },
  };

  let handler: InputHandler | undefined;
  const pi = {
    on: (event: string, h: InputHandler) => {
      if (event === "input") handler = h;
    },
    registerTool: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brokerFactory(pi as any);
  assert.ok(handler, "extension must register an input handler");
  const registeredHandler: InputHandler = handler;

  const send = async (
    text: string,
    over: { source?: string; streamingBehavior?: string; mode?: string } = {},
  ): Promise<string> => {
    const prevMode = ctx.mode;
    if (over.mode !== undefined) ctx.mode = over.mode;
    const event = {
      type: "input" as const,
      text,
      source: over.source ?? "interactive",
      ...(over.streamingBehavior !== undefined ? { streamingBehavior: over.streamingBehavior } : {}),
    };
    const result = await registeredHandler(event, ctx);
    ctx.mode = prevMode;
    return (result as { action: string } | undefined)?.action ?? "undefined";
  };

  return { handler, notices, confirmed, ctx, agentDir, stateRoot, send };
}

function stateImage(stateRoot: string): Record<string, unknown> | null {
  const p = path.join(stateRoot, "pi", "package-agent-broker", "state.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

function drafts(stateRoot: string): Record<string, { activatable: boolean; authorizationDigest: null; kind: string }> {
  const image = stateImage(stateRoot);
  return (image?.drafts ?? {}) as Record<string, { activatable: boolean; authorizationDigest: null; kind: string }>;
}

// --- input gate ------------------------------------------------------------

test("non-broker input passes through untouched", async () => {
  const h = makeHarness();
  assert.equal(await h.send("what is the weather"), "continue");
  assert.equal(h.notices.length, 0);
});

test("broker input is always handled, never passed onward", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  for (const text of ["/package-agent list", "/package-agent bogus", "/package-agent"]) {
    assert.equal(await h.send(text), "handled", text);
  }
});

test("non-interactive provenance is refused for every command", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  const cases: Array<{ label: string; over: Record<string, string> }> = [
    { label: "rpc source", over: { source: "rpc" } },
    { label: "extension-injected source", over: { source: "extension" } },
    { label: "steer", over: { streamingBehavior: "steer" } },
    { label: "follow-up", over: { streamingBehavior: "followUp" } },
    { label: "rpc mode", over: { mode: "rpc" } },
    { label: "json mode", over: { mode: "json" } },
    { label: "print mode", over: { mode: "print" } },
  ];
  for (const c of cases) {
    h.notices.length = 0;
    assert.equal(await h.send(`/package-agent review ${QID}`, c.over), "handled", c.label);
    assert.ok(
      h.notices.some((n) => n.includes("require direct interactive TUI input")),
      `${c.label} must be refused`,
    );
    assert.deepEqual(drafts(h.stateRoot), {}, `${c.label} must not create a draft`);
  }
});

// --- consent contract ------------------------------------------------------

test("declining a page aborts on the DECLINE, not on a later retype failure", async () => {
  // Regression guard: the original showPages ignored a decline on the last
  // page, so the flow fell through to the retype prompts and only aborted
  // there. Supplying CORRECT retype answers isolates the consent step — if
  // the decline is honored, the retype prompts are never reached.
  const probe = makeHarness();
  installPackage(probe.agentDir, { prompt: "short" });
  await probe.send(`/package-agent inspect ${QID}`);
  const shown = probe.confirmed.join("\n");
  const digest = /sha256: ([0-9a-f]{64})/.exec(shown.slice(shown.indexOf("Proposal digest")))?.[1];
  assert.ok(digest);

  // Accept every page EXCEPT the last. The original bug only checked
  // `!ok && !last`, so a decline on the final page was silently ignored.
  const pageCount = probe.confirmed.length;
  assert.ok(pageCount >= 1);
  const h = makeHarness({
    confirmAnswers: Array.from({ length: pageCount }, (_, i) => i !== pageCount - 1),
    inputAnswers: [QID, digest], // valid — must never be consumed
  });
  installPackage(h.agentDir, { prompt: "short" });
  await h.send(`/package-agent review ${QID}`);

  assert.ok(
    h.notices.some((n) => n.includes("stopped before the full snapshot was acknowledged")),
    `expected an operator-declined abort, saw: ${JSON.stringify(h.notices)}`,
  );
  assert.ok(
    !h.notices.some((n) => n.includes("retype")),
    "declining must short-circuit before the retype prompts",
  );
  assert.deepEqual(drafts(h.stateRoot), {}, "declining must not create a draft");
});

test("declining the final page of a multi-page snapshot aborts", async () => {
  // Accept every page except the last.
  const probe = makeHarness();
  installPackage(probe.agentDir, {
    prompt: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
  });
  await probe.send(`/package-agent inspect ${QID}`);
  const pageCount = probe.confirmed.length;
  assert.ok(pageCount > 1, "snapshot should span multiple pages");

  const answers = Array.from({ length: pageCount }, (_, i) => i !== pageCount - 1);
  const h2 = makeHarness({ confirmAnswers: answers });
  installPackage(h2.agentDir, {
    prompt: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
  });
  await h2.send(`/package-agent review ${QID}`);
  assert.ok(h2.notices.some((n) => n.includes("review aborted")));
  assert.deepEqual(drafts(h2.stateRoot), {});
});

test("retype mismatch on identity or digest aborts", async () => {
  for (const answers of [
    ["wrong-id"],
    [QID, "wrong-digest"],
    [undefined],
    [` ${QID}`], // leading space must not be tolerated
  ]) {
    const h = makeHarness({ inputAnswers: answers as (string | undefined)[] });
    installPackage(h.agentDir, { prompt: "short" });
    await h.send(`/package-agent review ${QID}`);
    assert.ok(
      h.notices.some((n) => n.includes("review aborted")),
      `answers ${JSON.stringify(answers)} must abort`,
    );
    assert.deepEqual(drafts(h.stateRoot), {});
  }
});

// --- happy path ------------------------------------------------------------

test("a fully confirmed review records exactly one inert draft", async () => {
  // First pass: learn the digest from the rendered pages.
  const probe = makeHarness();
  installPackage(probe.agentDir, { prompt: "short" });
  await probe.send(`/package-agent inspect ${QID}`);
  // The proposal digest is the sha256 in the "Proposal digest" section — not
  // the per-file source hashes that also render as `sha256:` lines.
  const shown = probe.confirmed.join("\n");
  const digestSection = shown.slice(shown.indexOf("Proposal digest"));
  const digestMatch = /sha256: ([0-9a-f]{64})/.exec(digestSection);
  assert.ok(digestMatch, "proposal digest must be displayed in the snapshot");
  const digest = digestMatch[1];

  const h = makeHarness({ inputAnswers: [QID, digest] });
  installPackage(h.agentDir, { prompt: "short" });
  assert.equal(await h.send(`/package-agent review ${QID}`), "handled");

  const recorded = drafts(h.stateRoot);
  assert.deepEqual(Object.keys(recorded), [QID]);
  assert.equal(recorded[QID].kind, "package-agent-review-draft");
  assert.equal(recorded[QID].activatable, false);
  assert.equal(recorded[QID].authorizationDigest, null);
  assert.ok(h.notices.some((n) => n.includes("AUTHORIZES NOTHING")));

  // status reflects the draft and keeps saying it is non-authorizing.
  h.notices.length = 0;
  await h.send("/package-agent status");
  assert.ok(h.notices.some((n) => n.includes("non-authorizing")));

  // revoke-draft removes the evidence.
  await h.send(`/package-agent revoke-draft ${QID}`);
  assert.deepEqual(drafts(h.stateRoot), {});
});

// --- terminal safety of notification paths ---------------------------------

test("hostile on-disk file names cannot inject escapes via list", async () => {
  const h = makeHarness();
  installPackage(h.agentDir, { extraFileName: `Bad${ESC}[31m${RLO}Name.json` });
  await h.send("/package-agent list");
  const all = h.notices.join("\n");
  assert.ok(all.length > 0, "list must produce output");
  assert.ok(!all.includes(ESC), "raw ESC leaked into the list notification");
  assert.ok(!all.includes(RLO), "raw bidi override leaked into the list notification");
  assert.ok(all.includes("⟦U+001B⟧"), "escape should be visibly encoded");
});

test("hostile prompt content cannot inject escapes via the review viewer", async () => {
  const h = makeHarness();
  installPackage(h.agentDir, { prompt: `hostile${ESC}[2J${RLO}payload` });
  await h.send(`/package-agent inspect ${QID}`);
  const shown = h.confirmed.join("\n");
  assert.ok(!shown.includes(ESC));
  assert.ok(!shown.includes(RLO));
});

// --- no activation, ever ---------------------------------------------------

test("no command registers or activates anything beyond the single dispatch ingress", async () => {
  const h = makeHarness({ inputAnswers: [QID, "nope"] });
  installPackage(h.agentDir, { prompt: "short" });
  const registered: string[] = [];
  const tools: string[] = [];
  const pi = {
    on: () => undefined,
    registerCommand: (name: string) => registered.push(name),
    // #930 (ADR-0131 D7): the boundary NARROWS, deliberately — exactly one
    // static tool, the dispatch ingress, registers at load. It never
    // represents a package agent, and no approval or command changes the
    // registration set (asserted after the command sweep below).
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerAgent: (name: string) => registered.push(name),
    addTool: (name: string) => registered.push(name),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brokerFactory(pi as any);
  assert.deepEqual(registered, [], "the broker must register no command/agent");
  assert.deepEqual(tools, ["package_agent_dispatch"], "exactly one static tool: the dispatch ingress");

  for (const cmd of [
    "/package-agent list",
    "/package-agent status",
    `/package-agent inspect ${QID}`,
    `/package-agent review ${QID}`,
    `/package-agent reject ${QID}`,
  ]) {
    await h.send(cmd);
  }
  assert.deepEqual(drafts(h.stateRoot), {}, "no draft from a failed retype");
  assert.deepEqual(registered, [], "no command sweep may register a command/agent");
  assert.deepEqual(tools, ["package_agent_dispatch"], "no command sweep may add a tool");
});
