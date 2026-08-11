/**
 * discovery.test.ts — inert discovery: bounded data-only reads, symlink and
 * special-file refusal, bounds, source parsing, and the static zero-execution
 * guarantee (#916).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  DiscoveryError,
  discoverProposals,
  parsePinnedGitSource,
  readObservedCommit,
} from "../lib/discovery.ts";

const HOST = "github.com";
const REPO = "psmfd/pi-work-item-client";
const REF = "v1.0.0";
const SOURCE = `git:${HOST}/${REPO}@${REF}`;

function mkAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pab-discovery-"));
}

function installPackage(agentDir: string, descriptor: unknown, opts: { wrapper?: string; name?: string } = {}): string {
  const name = opts.name ?? "work-item-planner";
  const root = path.join(agentDir, "git", HOST, ...REPO.split("/"));
  const agents = path.join(root, "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, `${name}.json`), JSON.stringify(descriptor));
  if (opts.wrapper !== undefined) {
    fs.writeFileSync(path.join(agents, `${name}.md`), opts.wrapper);
  }
  return root;
}

function validDescriptor(name = "work-item-planner"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name,
    description: "Plans work items.",
    prompt: "You are a proposal-only planner.",
    tools: ["read"],
  };
}

test("parsePinnedGitSource accepts pinned git sources only", () => {
  assert.deepEqual(parsePinnedGitSource(SOURCE), {
    source: SOURCE,
    host: HOST,
    path: REPO,
    ref: REF,
  });
  assert.deepEqual(parsePinnedGitSource({ source: SOURCE }), {
    source: SOURCE,
    host: HOST,
    path: REPO,
    ref: REF,
  });
  for (const bad of [
    "git:github.com/psmfd/pi-x", // unpinned
    "npm:@scope/pkg",
    "local:../somewhere",
    "git:github.com/../../etc@v1",
    "git:github.com/a/b@..",
    42,
    null,
    { notSource: true },
    `git:github.com/psmfd/‮pi-x@v1`, // bidi char
  ]) {
    assert.equal(parsePinnedGitSource(bad), null, JSON.stringify(bad));
  }
});

test("discovers a valid proposal with evidence and identity", () => {
  const agentDir = mkAgentDir();
  installPackage(agentDir, validDescriptor(), { wrapper: "# wrapper\n" });
  const result = discoverProposals({ agentDir, settingsPackages: [SOURCE] });
  assert.equal(result.proposals.length, 1);
  const p = result.proposals[0];
  assert.equal(p.qualifiedId, `git:${HOST}/${REPO}@${REF}#work-item-planner`);
  assert.equal(p.descriptorEvidence.relPath, "agents/work-item-planner.json");
  assert.equal(p.descriptorEvidence.sha256.length, 64);
  assert.equal(p.wrapperText, "# wrapper\n");
  assert.equal(p.packageIdentity.ref, REF);
});

test("uninstalled and non-git packages are skipped, not fatal", () => {
  const agentDir = mkAgentDir();
  const result = discoverProposals({
    agentDir,
    settingsPackages: [SOURCE, "npm:@scope/pkg", "git:example.com/not/installed@v9"],
  });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skips.some((s) => s.reason === "not installed"));
});

test("invalid descriptors are skipped with a bounded reason", () => {
  const agentDir = mkAgentDir();
  installPackage(agentDir, { schemaVersion: 1, name: "work-item-planner" }); // missing fields
  const result = discoverProposals({ agentDir, settingsPackages: [SOURCE] });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skips.some((s) => s.reason === "descriptor invalid"));
});

test("symlinked descriptor files are refused", () => {
  const agentDir = mkAgentDir();
  const root = installPackage(agentDir, validDescriptor());
  const agents = path.join(root, "agents");
  const outside = path.join(agentDir, "outside.json");
  fs.writeFileSync(outside, JSON.stringify(validDescriptor("smuggled-agent")));
  fs.symlinkSync(outside, path.join(agents, "smuggled-agent.json"));
  const result = discoverProposals({ agentDir, settingsPackages: [SOURCE] });
  assert.equal(result.proposals.length, 1); // the regular file still discovers
  assert.ok(result.skips.some((s) => s.relPath === "agents/smuggled-agent.json"));
});

test("symlinked agents directory is ignored", () => {
  const agentDir = mkAgentDir();
  const root = path.join(agentDir, "git", HOST, ...REPO.split("/"));
  fs.mkdirSync(root, { recursive: true });
  const elsewhere = path.join(agentDir, "elsewhere");
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "x.json"), JSON.stringify(validDescriptor("x-agent")));
  fs.symlinkSync(elsewhere, path.join(root, "agents"));
  const result = discoverProposals({ agentDir, settingsPackages: [SOURCE] });
  assert.equal(result.proposals.length, 0);
});

test("oversized descriptor files are refused", () => {
  const agentDir = mkAgentDir();
  const big = validDescriptor();
  big.description = "x".repeat(70 * 1024);
  installPackage(agentDir, big);
  const result = discoverProposals({ agentDir, settingsPackages: [SOURCE] });
  assert.equal(result.proposals.length, 0);
  assert.ok(result.skips.some((s) => s.reason === "bounds-exceeded"));
});

test("descriptor file name must be a valid agent name", () => {
  const agentDir = mkAgentDir();
  const root = installPackage(agentDir, validDescriptor());
  fs.writeFileSync(
    path.join(root, "agents", "Bad Name.json"),
    JSON.stringify(validDescriptor()),
  );
  const result = discoverProposals({ agentDir, settingsPackages: [SOURCE] });
  assert.equal(result.proposals.length, 1);
  assert.ok(result.skips.some((s) => s.reason === "invalid descriptor file name"));
});

test("global discovery byte budget exhaustion aborts the whole pass", () => {
  // Distinct from the per-file `maxDescriptorBytes` bound (continue-eligible):
  // this is the systemic `total-budget-exceeded` path that refuses the pass.
  const agentDir = mkAgentDir();
  const root = path.join(agentDir, "git", HOST, ...REPO.split("/"));
  const agents = path.join(root, "agents");
  fs.mkdirSync(agents, { recursive: true });
  // Each descriptor is under the 64 KiB per-file cap but together they exceed
  // the 4 MiB pass budget.
  const filler = "x".repeat(60 * 1024);
  for (let i = 0; i < 16; i++) {
    fs.writeFileSync(
      path.join(agents, `agent-${i}.json`),
      JSON.stringify({ ...validDescriptor(`agent-${i}`), description: filler }),
    );
  }
  const sources: string[] = [];
  for (let p = 0; p < 8; p++) {
    const repo = `psmfd/pkg-${p}`;
    const pkgAgents = path.join(agentDir, "git", HOST, ...repo.split("/"), "agents");
    fs.mkdirSync(pkgAgents, { recursive: true });
    for (let i = 0; i < 16; i++) {
      fs.writeFileSync(
        path.join(pkgAgents, `agent-${i}.json`),
        JSON.stringify({ ...validDescriptor(`agent-${i}`), description: filler }),
      );
    }
    sources.push(`git:${HOST}/${repo}@${REF}`);
  }
  assert.throws(
    () => discoverProposals({ agentDir, settingsPackages: sources }),
    (err: unknown) =>
      err instanceof DiscoveryError && err.reason === "total-budget-exceeded",
    "budget exhaustion must abort the pass, not degrade to a per-file skip",
  );
});

test("package count bound is enforced", () => {
  const agentDir = mkAgentDir();
  const many = Array.from({ length: 100 }, (_, i) => `git:${HOST}/o/p${i}@v1`);
  assert.throws(() => discoverProposals({ agentDir, settingsPackages: many }));
});

test("readObservedCommit reads detached HEAD, loose refs, and packed-refs", () => {
  const agentDir = mkAgentDir();
  const root = installPackage(agentDir, validDescriptor());
  const sha = "a".repeat(40);

  // detached HEAD
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), `${sha}\n`);
  assert.equal(readObservedCommit(root), sha);

  // symbolic ref -> loose ref
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${sha}\n`);
  assert.equal(readObservedCommit(root), sha);

  // symbolic ref -> packed-refs
  fs.rmSync(path.join(root, ".git", "refs", "heads", "main"));
  fs.writeFileSync(
    path.join(root, ".git", "packed-refs"),
    `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n`,
  );
  assert.equal(readObservedCommit(root), sha);

  // hostile ref name is refused
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/../../../etc/passwd\n");
  assert.equal(readObservedCommit(root), null);

  // missing metadata is null, not an error
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  assert.equal(readObservedCommit(root), null);
});

test("static guarantee: the broker's spawn boundary is exactly dispatch-runner.ts", () => {
  const brokerDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const libDir = path.join(brokerDir, "lib");
  // Every lib file is scanned via a directory glob rather than a hand-kept
  // list, so a newly added pure module (e.g. child-sandbox.ts) is covered
  // automatically — the enumerated list previously silently excluded new files.
  // state-store.ts legitimately uses node:fs (persistence); it is scanned for
  // the process/network/eval surface below, none of which it may reference.
  //
  // #930 (ADR-0131 Decision 6): process creation is confined to exactly ONE
  // named module, `dispatch-runner.ts`, which may reference `child_process`
  // and NOTHING ELSE on the forbidden list (its TLS probe runs inside the
  // sandboxed child, never in the broker). `index.ts` is scanned too — it was
  // previously asserted spawn-free by comment only.
  const SPAWN_BOUNDARY_FILE = "dispatch-runner.ts";
  const SPAWN_BOUNDARY_ALLOWED = new Set(["child_process"]);
  const libFiles = fs.readdirSync(libDir).filter((f) => f.endsWith(".ts"));
  assert.ok(libFiles.includes("child-sandbox.ts"), "the glob must cover new modules");
  assert.ok(libFiles.includes(SPAWN_BOUNDARY_FILE), "the spawn boundary module must exist");
  const scanTargets: Array<{ file: string; sourcePath: string }> = [
    ...libFiles.map((f) => ({ file: f, sourcePath: path.join(libDir, f) })),
    { file: "index.ts", sourcePath: path.join(brokerDir, "index.ts") },
  ];
  for (const { file, sourcePath } of scanTargets) {
    const src = fs.readFileSync(sourcePath, "utf8");
    for (const forbidden of [
      "child_process",
      "node:http",
      "node:https",
      "node:net",
      "node:dgram",
      "node:tls",
      "worker_threads",
      "node:vm",
      "eval(",
      "Function(",
      "process.binding",
    ]) {
      if (file === SPAWN_BOUNDARY_FILE && SPAWN_BOUNDARY_ALLOWED.has(forbidden)) continue;
      assert.ok(!src.includes(forbidden), `${file} must not reference ${forbidden}`);
    }
    // No dynamic import of package content anywhere in the broker.
    assert.ok(!/\bimport\s*\(/.test(src), `${file} must not use dynamic import`);
  }
});
