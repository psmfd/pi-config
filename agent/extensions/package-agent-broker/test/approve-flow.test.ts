/**
 * approve-flow.test.ts — adversarial integration coverage for the #928
 * approval flow (ADR-0129).
 *
 * The properties under test are the five #928 acceptance criteria:
 *
 *   1. review drafts are rejected as authorization evidence under every path,
 *      including a hand-forged one;
 *   2. the grant digest covers the ADR-0127 §5 field set (asserted in
 *      `grant-digest.test.ts`; asserted here to be what the operator retypes);
 *   3. digest-domain separation from #916 is observable end to end;
 *   4. non-TUI, RPC, steer/follow-up, and extension-injected ingress cannot
 *      create a grant;
 *   5. collision refusals are total.
 *
 * Plus the two structural guarantees ADR-0129 turns on: approval creates
 * authority in memory only, and approval never dispatches.
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
const AGENT = "work-item-planner";
const QID = `git:${HOST}/${REPO}@${REF}#${AGENT}`;
const COMMIT = "9".repeat(40);

/** Answer sentinel: "retype the grant digest this flow just displayed". */
const AUTO_DIGEST = "<<auto-digest>>";

const restoreEnvHooks: Array<() => void> = [];
afterEach(() => {
  while (restoreEnvHooks.length > 0) (restoreEnvHooks.pop() as () => void)();
});

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
  notices: string[];
  confirmed: string[];
  agentDir: string;
  stateRoot: string;
  confirmQueue: boolean[];
  inputQueue: (string | undefined)[];
  send: (text: string, over?: { source?: string; streamingBehavior?: string; mode?: string }) => Promise<string>;
  /** Returns the handler's best-effort shutdown-audit promise (#929). */
  shutdown: () => void | Promise<void>;
}

function installPackage(
  agentDir: string,
  opts: { ref?: string; tools?: string[]; withGit?: boolean; agentName?: string } = {},
): void {
  const ref = opts.ref ?? REF;
  const name = opts.agentName ?? AGENT;
  const root = path.join(agentDir, "git", HOST, ...REPO.split("/"));
  const agents = path.join(root, "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(
    path.join(agents, `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      description: "Plans work items.",
      prompt: "You are a proposal-only planner.",
      tools: opts.tools ?? ["read"],
    }),
  );
  if (opts.withGit !== false) {
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "HEAD"), `${COMMIT}\n`);
  }
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ packages: [`git:${HOST}/${REPO}@${ref}`] }),
  );
}

function makeHarness(): Harness {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pab-approve-agent-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pab-approve-state-"));
  fs.chmodSync(stateRoot, 0o700);
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
  const confirmQueue: boolean[] = [];
  const inputQueue: (string | undefined)[] = [];

  const ctx: FakeCtx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => notices.push(message),
      confirm: (title: string, message: string) => {
        confirmed.push(`${title}\n${message}`);
        return Promise.resolve(confirmQueue.length > 0 ? (confirmQueue.shift() as boolean) : true);
      },
      input: () => {
        const answer = inputQueue.length > 0 ? inputQueue.shift() : undefined;
        // A grant digest binds a per-attempt nonce, so it cannot be learned in
        // a probe pass and replayed in a second one — the operator retypes the
        // digest shown in the flow they are confirming. The sentinel models
        // exactly that: read it off the pages this flow already displayed.
        if (answer === AUTO_DIGEST) return Promise.resolve(digestFrom(confirmed, "Grant digest"));
        return Promise.resolve(answer);
      },
    },
  };

  let handler: InputHandler | undefined;
  let shutdownHandler: (() => void | Promise<void>) | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registeredTools: Array<{ name: string }> = [];
  brokerFactory({
    on: (event: string, h: InputHandler | (() => void)) => {
      if (event === "input") handler = h as InputHandler;
      if (event === "session_shutdown") shutdownHandler = h as () => void | Promise<void>;
    },
    // #930: the single static dispatch ingress registers at load; the fake
    // captures it so tests can assert on the (exactly one) registration.
    registerTool: (tool: { name: string }) => {
      registeredTools.push(tool);
    },
  } as any);
  assert.equal(registeredTools.length, 1, "exactly one tool (the dispatch ingress) may register");
  assert.equal(registeredTools[0].name, "package_agent_dispatch");
  assert.ok(handler, "extension must register an input handler");
  assert.ok(shutdownHandler, "extension must register a shutdown handler");
  const registered: InputHandler = handler;

  const send = async (
    text: string,
    over: { source?: string; streamingBehavior?: string; mode?: string } = {},
  ): Promise<string> => {
    const prevMode = ctx.mode;
    if (over.mode !== undefined) ctx.mode = over.mode;
    const result = await registered(
      {
        type: "input" as const,
        text,
        source: over.source ?? "interactive",
        ...(over.streamingBehavior !== undefined ? { streamingBehavior: over.streamingBehavior } : {}),
      },
      ctx,
    );
    ctx.mode = prevMode;
    return (result as { action: string } | undefined)?.action ?? "undefined";
  };

  return {
    notices, confirmed, agentDir, stateRoot, confirmQueue, inputQueue, send,
    shutdown: shutdownHandler as () => void | Promise<void>,
  };
}

function stateImage(stateRoot: string): Record<string, unknown> | null {
  const p = path.join(stateRoot, "pi", "package-agent-broker", "state.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

function receipts(stateRoot: string): Record<string, Record<string, unknown>> {
  return (stateImage(stateRoot)?.grantReceipts ?? {}) as Record<string, Record<string, unknown>>;
}

function auditEvents(stateRoot: string, kind?: string): Array<Record<string, unknown>> {
  const audit = (stateImage(stateRoot)?.audit ?? []) as Array<Record<string, unknown>>;
  return kind === undefined ? audit : audit.filter((e) => e.kind === kind);
}

/** Pull a labelled sha256 out of the rendered pages. */
function digestFrom(confirmed: string[], section: string): string {
  const shown = confirmed.join("\n");
  const idx = shown.indexOf(section);
  assert.ok(idx >= 0, `section ${section} was never displayed`);
  const match = /sha256: ([0-9a-f]{64})/.exec(shown.slice(idx));
  assert.ok(match, `no digest under ${section}`);
  return match[1];
}

/**
 * The nonce-independent content bindings the approval pages display: the
 * resolved revision, the asset tree digest, and the runner digest. Two
 * approvals of the same bytes agree on all three even though their grant
 * digests differ.
 */
function contentBindingsFrom(confirmed: string[]): string {
  const shown = confirmed.join("\n");
  const grab = (label: string): string => {
    const match = new RegExp(`${label}:\\s*([0-9a-f]{40,64})`).exec(shown);
    assert.ok(match, `expected a ${label} line in the rendered pages`);
    return `${label}=${match[1]}`;
  };
  return [grab("Resolved commit"), grab("Asset tree digest"), grab("Runner sha256")].join("|");
}

/** Run one approval to completion, answering both retypes correctly. */
async function approve(h: Harness, qid = QID, extra = ""): Promise<void> {
  h.confirmed.length = 0;
  h.inputQueue.length = 0;
  h.inputQueue.push(qid, AUTO_DIGEST);
  await h.send(`/package-agent approve ${qid}${extra}`);
}

// --- ingress (criterion 4) --------------------------------------------------

test("non-interactive provenance cannot create a grant", async () => {
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
    assert.equal(await h.send(`/package-agent approve ${QID}`, c.over), "handled", c.label);
    assert.ok(
      h.notices.some((n) => n.includes("require direct interactive TUI input")),
      `${c.label} must be refused`,
    );
    h.notices.length = 0;
    await h.send("/package-agent grants");
    assert.ok(h.notices.some((n) => n.includes("no active grants")), `${c.label} must not create a grant`);
  }
});

// --- happy path -------------------------------------------------------------

test("a fully confirmed approval creates exactly one in-memory grant", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);

  assert.ok(
    h.notices.some((n) => n.includes("ACTIVE GRANT created")),
    `expected a grant, saw: ${JSON.stringify(h.notices)}`,
  );
  h.notices.length = 0;
  await h.send("/package-agent grants");
  const listed = h.notices.join("\n");
  assert.ok(listed.includes(QID), "the grant must be listed");
  assert.ok(listed.includes("approval #1"));
});

test("approval says explicitly that nothing was dispatched", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);
  assert.ok(h.notices.some((n) => n.includes("Nothing has been dispatched")));
});

test("non-TUI revoke removes only current-runtime authority without prompting", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);
  h.notices.length = 0;
  h.confirmed.length = 0;
  assert.equal(await h.send(`/package-agent revoke ${QID}`, { source: "extension" }), "handled");
  assert.equal(h.confirmed.length, 0, "revoke must never prompt");
  assert.ok(h.notices.some((n) => n.includes("current runtime only")));
  h.notices.length = 0;
  await h.send("/package-agent grants");
  assert.ok(h.notices.some((n) => n.includes("no active grants")));
});

test("session shutdown invalidates grants held by a captured input handler", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);
  h.shutdown();
  const promptsBefore = h.confirmed.length;
  await h.send(`/package-agent approve ${QID}`);
  assert.equal(h.confirmed.length, promptsBefore, "stale handler must not reopen approval");
  assert.deepEqual(Object.keys(receipts(h.stateRoot)), [QID], "shutdown cannot alter persisted evidence");
});

test("the persisted receipt is non-authorizing and holds no authority", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);

  const written = receipts(h.stateRoot);
  assert.deepEqual(Object.keys(written), [QID]);
  const receipt = written[QID];
  assert.equal(receipt.kind, "package-agent-grant-receipt");
  assert.equal(receipt.authorizing, false);
  // The receipt records what was approved; it is never an authorization input.
  assert.match(receipt.observedGrantDigest as string, /^[0-9a-f]{64}$/);
  // No grant object, definition, prompt, or descriptor bytes are persisted.
  const serialized = JSON.stringify(stateImage(h.stateRoot));
  assert.ok(!serialized.includes("proposal-only planner"), "prompt bytes must not be persisted with the receipt");
  assert.ok(!serialized.includes("package-agent-active-grant"), "the grant must never be serialized");
});

test("authority does not survive into a new runtime instance", async () => {
  const first = makeHarness();
  installPackage(first.agentDir);
  await approve(first);
  const stateRoot = first.stateRoot;
  const agentDir = first.agentDir;
  assert.ok(Object.keys(receipts(stateRoot)).length === 1);

  // A fresh harness is a fresh runtime: same on-disk state, new registry.
  const second = makeHarness();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.XDG_STATE_HOME = stateRoot;
  await second.send("/package-agent grants");
  assert.ok(
    second.notices.some((n) => n.includes("no active grants")),
    "a receipt on disk must not resurrect authority in a new runtime",
  );
});

// --- drafts are not evidence (criterion 1) ----------------------------------

test("a state image whose draft claims to be authorizing is refused outright", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  const dir = path.join(h.stateRoot, "pi", "package-agent-broker");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      draftRevisions: {},
      drafts: {
        [QID]: {
          kind: "package-agent-review-draft",
          activatable: true, // forged
          authorizationDigest: "f".repeat(64), // forged
          qualifiedId: QID,
        },
      },
      grantReceipts: {},
      audit: [],
      auditDropped: 0,
    }),
    { mode: 0o600 },
  );
  await h.send(`/package-agent approve ${QID}`);
  assert.ok(
    h.notices.some((n) => n.includes("refused")),
    `a forged draft must refuse the load, saw: ${JSON.stringify(h.notices)}`,
  );
  h.notices.length = 0;
  await h.send("/package-agent grants");
  assert.ok(h.notices.some((n) => n.includes("no active grants")));
});

test("a forged receipt claiming to authorize is refused outright", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  const dir = path.join(h.stateRoot, "pi", "package-agent-broker");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      draftRevisions: {},
      drafts: {},
      grantReceipts: {
        [QID]: { kind: "package-agent-grant-receipt", authorizing: true, qualifiedId: QID },
      },
      audit: [],
      auditDropped: 0,
    }),
    { mode: 0o600 },
  );
  await h.send(`/package-agent approve ${QID}`);
  assert.ok(h.notices.some((n) => n.includes("refused")));
});

test("a legitimate review draft shortens nothing in the approval", async () => {
  // The proof is behavioural: with and without a draft, the approval shows
  // the same pages, asks the same questions, and requires the same answers.
  const withoutDraft = makeHarness();
  installPackage(withoutDraft.agentDir);
  withoutDraft.confirmed.length = 0;
  await withoutDraft.send(`/package-agent approve ${QID}`);
  const pagesWithout = withoutDraft.confirmed.length;
  const digestWithout = digestFrom(withoutDraft.confirmed, "Grant digest");

  const withDraft = makeHarness();
  installPackage(withDraft.agentDir);
  // Record a real review draft through the real review flow.
  withDraft.confirmed.length = 0;
  await withDraft.send(`/package-agent inspect ${QID}`);
  const proposalDigest = digestFrom(withDraft.confirmed, "Proposal digest");
  withDraft.inputQueue.push(QID, proposalDigest);
  await withDraft.send(`/package-agent review ${QID}`);
  assert.ok(withDraft.notices.some((n) => n.includes("AUTHORIZES NOTHING")));

  withDraft.confirmed.length = 0;
  withDraft.notices.length = 0;
  await withDraft.send(`/package-agent approve ${QID}`);
  const shown = withDraft.confirmed.join("\n");

  assert.ok(shown.includes("satisfies nothing"), "the prior-review note must disclaim itself");
  // The approved CONTENT is identical. Grant digests cannot be compared
  // across attempts — each binds its own nonce — so compare the two
  // nonce-independent content bindings the pages display instead.
  assert.equal(
    contentBindingsFrom(withDraft.confirmed),
    contentBindingsFrom(withoutDraft.confirmed),
    "a draft must not change what is approved",
  );
  assert.notEqual(digestWithout, digestFrom(withDraft.confirmed, "Grant digest"));
  assert.ok(
    withDraft.confirmed.length >= pagesWithout,
    "a draft must not reduce the number of pages the operator acknowledges",
  );
  // Still requires both retypes: no answers were queued, so it aborts.
  assert.ok(withDraft.notices.some((n) => n.includes("approval aborted")));
});

test("each approval attempt binds its own nonce, so a digest cannot be replayed", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  h.confirmed.length = 0;
  await h.send(`/package-agent approve ${QID}`);
  const first = digestFrom(h.confirmed, "Grant digest");
  h.confirmed.length = 0;
  await h.send(`/package-agent approve ${QID}`);
  const second = digestFrom(h.confirmed, "Grant digest");
  assert.notEqual(first, second, "two attempts must be distinguishable");

  // Replaying the first attempt's digest against the second attempt aborts.
  h.confirmed.length = 0;
  h.inputQueue.push(QID, first);
  h.notices.length = 0;
  await h.send(`/package-agent approve ${QID}`);
  assert.ok(h.notices.some((n) => n.includes("digest retype did not match")));
});

test("the grant digest is not the review-draft proposal digest (criterion 3)", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await h.send(`/package-agent inspect ${QID}`);
  const proposalDigest = digestFrom(h.confirmed, "Proposal digest");
  h.confirmed.length = 0;
  await h.send(`/package-agent approve ${QID}`);
  const grantDigest = digestFrom(h.confirmed, "Grant digest");
  assert.notEqual(grantDigest, proposalDigest);
});

// --- refusals ---------------------------------------------------------------

test("an unresolvable revision refuses the approval", async () => {
  const h = makeHarness();
  installPackage(h.agentDir, { withGit: false });
  await h.send(`/package-agent approve ${QID}`);
  assert.ok(
    h.notices.some((n) => n.includes("approval aborted") && n.includes("revision")),
    `expected a revision refusal, saw: ${JSON.stringify(h.notices)}`,
  );
});

test("a descriptor requesting bash cannot be approved", async () => {
  const h = makeHarness();
  installPackage(h.agentDir, { tools: ["read", "bash"] });
  await h.send(`/package-agent approve ${QID}`);
  assert.ok(
    h.notices.some((n) => n.includes("approval aborted") && n.includes("bash")),
    `expected a tool-policy refusal, saw: ${JSON.stringify(h.notices)}`,
  );
  h.notices.length = 0;
  await h.send("/package-agent grants");
  assert.ok(h.notices.some((n) => n.includes("no active grants")));
});

test("an unknown proposal refuses without creating anything", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await h.send(`/package-agent approve git:${HOST}/${REPO}@${REF}#no-such-agent`);
  assert.ok(h.notices.some((n) => n.includes("no such proposal")));
});

test("a retype mismatch on identity or digest creates no grant", async () => {
  for (const answers of [["wrong-id"], [QID, "wrong-digest"], [undefined], [` ${QID}`]]) {
    const h = makeHarness();
    installPackage(h.agentDir);
    h.inputQueue.push(...(answers as (string | undefined)[]));
    await h.send(`/package-agent approve ${QID}`);
    assert.ok(
      h.notices.some((n) => n.includes("approval aborted")),
      `answers ${JSON.stringify(answers)} must abort`,
    );
    h.notices.length = 0;
    await h.send("/package-agent grants");
    assert.ok(h.notices.some((n) => n.includes("no active grants")));
  }
});

test("declining any page aborts before the retype prompts", async () => {
  const probe = makeHarness();
  installPackage(probe.agentDir);
  await probe.send(`/package-agent approve ${QID}`);
  const pageCount = probe.confirmed.length;
  assert.ok(pageCount >= 1);

  const h = makeHarness();
  installPackage(h.agentDir);
  h.confirmQueue.push(...Array.from({ length: pageCount }, (_, i) => i !== pageCount - 1));
  h.inputQueue.push(QID, "should-never-be-consumed");
  await h.send(`/package-agent approve ${QID}`);
  assert.ok(h.notices.some((n) => n.includes("stopped before the full definition was acknowledged")));
  assert.equal(h.inputQueue.length, 2, "declining must short-circuit before the retypes");
});

// --- collisions (criterion 5) -----------------------------------------------

test("a package-identity collision refuses approval of a different ref", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);
  assert.ok(h.notices.some((n) => n.includes("ACTIVE GRANT created")));

  // The operator re-pins the same package to a new ref. That is a distinct
  // qualified identity, so it would not retire the existing grant — leaving
  // two dispatchable grants for what reads as one agent. Refuse instead.
  installPackage(h.agentDir, { ref: "v2.0.0" });
  const newQid = `git:${HOST}/${REPO}@v2.0.0#${AGENT}`;
  h.notices.length = 0;
  await h.send(`/package-agent approve ${newQid}`);
  assert.ok(
    h.notices.some((n) => n.includes("approval aborted") && n.includes("v1.0.0")),
    `expected a package-identity refusal, saw: ${JSON.stringify(h.notices)}`,
  );
});

test("a protected agent name cannot be approved", async () => {
  const h = makeHarness();
  installPackage(h.agentDir, { agentName: "linter" });
  const qid = `git:${HOST}/${REPO}@${REF}#linter`;
  await h.send(`/package-agent approve ${qid}`);
  assert.ok(h.notices.some((n) => n.includes("approval aborted") && n.includes("protected")));
});

test("re-approving the same identity replaces rather than duplicating", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);
  await approve(h);
  h.notices.length = 0;
  await h.send("/package-agent grants");
  const listed = h.notices.join("\n");
  assert.ok(listed.includes("approval #2"), `expected the second approval, saw: ${listed}`);
  assert.equal(listed.split(QID).length - 1, 1, "exactly one grant must be resolvable for the identity");
});

// --- lifecycle evidence (#929) ----------------------------------------------

test("operator revocation records audit evidence and stamps the receipt terminal", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);
  await h.send(`/package-agent revoke ${QID}`);

  const revoked = auditEvents(h.stateRoot, "grant-revoked");
  assert.equal(revoked.length, 1, "exactly one grant-revoked event");
  assert.equal(revoked[0].qualifiedId, QID);
  assert.equal(revoked[0].approvalSequence, 1);
  assert.equal(revoked[0].outcome, "committed");
  assert.equal(revoked[0].reason, "operator-declined");
  assert.match(revoked[0].grantDigest as string, /^[0-9a-f]{64}$/);

  const receipt = receipts(h.stateRoot)[QID];
  const terminal = receipt.terminal as { state: string; atMs: number };
  assert.equal(terminal.state, "revoked");
  assert.ok(Number.isSafeInteger(terminal.atMs) && terminal.atMs > 0);
  // Evidence, never authority: the receipt still declares itself inert.
  assert.equal(receipt.authorizing, false);
});

test("revoking with no active grant records no lifecycle evidence", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await h.send(`/package-agent revoke ${QID}`);
  assert.ok(h.notices.some((n) => n.includes("no active grant")));
  assert.equal(auditEvents(h.stateRoot, "grant-revoked").length, 0);
});

test("a re-approval after revocation is not mislabelled by the old terminal stamp", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);
  await h.send(`/package-agent revoke ${QID}`);
  await approve(h);
  // The fresh approval (sequence 2) overwrote the receipt; the terminal
  // stamp belonged to sequence 1 and must not survive onto it.
  const receipt = receipts(h.stateRoot)[QID];
  assert.equal(receipt.approvalSequence, 2);
  assert.ok(
    receipt.terminal === undefined || receipt.terminal === null,
    "a live approval's receipt must carry no terminal stamp",
  );
});

test("session shutdown records best-effort shutdown audit for live grants", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await approve(h);
  await h.shutdown();

  const events = auditEvents(h.stateRoot, "grant-shutdown-invalidated");
  assert.equal(events.length, 1);
  assert.equal(events[0].qualifiedId, QID);
  assert.equal(events[0].reason, "runtime-shutdown");
  // Shutdown is not a receipt-terminal state: every grant dies with its
  // runtime by construction.
  const receipt = receipts(h.stateRoot)[QID];
  assert.ok(receipt.terminal === undefined || receipt.terminal === null);
});

test("session shutdown with no live grants records no shutdown audit", async () => {
  const h = makeHarness();
  installPackage(h.agentDir);
  await h.shutdown();
  assert.equal(auditEvents(h.stateRoot, "grant-shutdown-invalidated").length, 0);
});
