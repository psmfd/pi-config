/**
 * reconstruct.test.ts — reconstruction refusals and the tool policy (#928).
 *
 * Reconstruction has no partial success: a field it cannot resolve is a
 * refusal, never a null, an empty string, or a silently narrowed allowlist.
 * These tests pin each refusal to its reason code so the audit trail keeps
 * distinguishing them.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  GRANT_BOUNDS,
  type ApprovalBinding,
} from "../../shared/package-agent-grant-contract.ts";
import {
  assertGrantableTools,
  GRANTABLE_BUILTIN_TOOLS,
  REFUSED_BUILTIN_TOOLS,
  ToolPolicyError,
} from "../lib/builtin-tools.ts";
import type { DiscoveredProposal } from "../lib/discovery.ts";
import {
  assertArgvConsistent,
  buildArgvPolicy,
  CHILD_ISOLATION_FLAGS,
  computeAssetTreeDigest,
  reconstructEffectiveDefinition,
  ReconstructionError,
  resolveRunner,
  walkAssetTree,
} from "../lib/reconstruct.ts";

const COMMIT = "a".repeat(40);

/**
 * A real minimal install tree: the full-tree asset digest (#930, ADR-0131)
 * walks `installRoot`, so proposals must point at a directory that exists.
 * Created once per module — walk determinism across builds depends on it.
 */
function makeInstallRoot(name = "work-item-planner"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pab-install-"));
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", `${name}.json`), "{}");
  return root;
}
const INSTALL_ROOT = makeInstallRoot();


function fakeRunner(contents = "#!/bin/sh\nexit 0\n"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pab-runner-"));
  const p = path.join(dir, "pi");
  fs.writeFileSync(p, contents);
  return p;
}

function proposal(
  descriptorOverrides: Partial<DiscoveredProposal["descriptor"]> = {},
  identityOverrides: Partial<DiscoveredProposal["packageIdentity"]> = {},
  proposalOverrides: Partial<DiscoveredProposal> = {},
): DiscoveredProposal {
  const repo = "psmfd/pi-work-item-client";
  const name = "work-item-planner";
  return {
    qualifiedId: `git:github.com/${repo}@v1.0.0#${name}`,
    packageIdentity: {
      source: `git:github.com/${repo}@v1.0.0`,
      host: "github.com",
      path: repo,
      ref: "v1.0.0",
      observedCommit: COMMIT,
      ...identityOverrides,
    },
    descriptor: {
      schemaVersion: 1,
      name,
      description: "Plans work items.",
      prompt: "You are a proposal-only planner.",
      tools: ["read"],
      model: null,
      guardProfile: null,
      contextPolicy: null,
      environment: {},
      ...descriptorOverrides,
    },
    descriptorText: "{}",
    descriptorEvidence: { relPath: `agents/${name}.json`, byteLength: 2, sha256: "b".repeat(64) },
    wrapperText: null,
    wrapperEvidence: null,
    installRoot: INSTALL_ROOT,
    ...proposalOverrides,
  };
}

function binding(): ApprovalBinding {
  return {
    approval: { runtimeInstanceId: "c".repeat(64), sequence: 1 },
    nonce: "d".repeat(64),
    expiresAtMs: 1_800_000_000_000,
    expiresAtMonotonicMs: 4_000_000,
    clockSuspendInclusive: false,
  };
}

// --- revision ---------------------------------------------------------------

test("an unresolvable package revision refuses the reconstruction", () => {
  // #916 tolerates a null observed commit because a draft authorizes nothing.
  // A grant may not: the revision is part of what the operator approves.
  assert.throws(
    () =>
      reconstructEffectiveDefinition(proposal({}, { observedCommit: null }), null, binding(), {
        runnerPath: fakeRunner(),
      }),
    (err: unknown) =>
      err instanceof ReconstructionError && err.reason === "revision-unresolvable",
  );
});

// --- tool policy ------------------------------------------------------------

test("mutating built-ins are refused for package agents", () => {
  for (const name of Object.keys(REFUSED_BUILTIN_TOOLS)) {
    assert.throws(
      () => assertGrantableTools([name]),
      (err: unknown) => err instanceof ToolPolicyError && err.toolName === name,
      name,
    );
  }
});

test("extension-provided tool names are refused (an isolated child has none)", () => {
  for (const name of ["web_fetch", "git_read", "github_read", "task"]) {
    assert.throws(() => assertGrantableTools([name]), ToolPolicyError, name);
  }
});

test("grantable built-ins pass", () => {
  assert.ok(GRANTABLE_BUILTIN_TOOLS.length > 0);
  assertGrantableTools([...GRANTABLE_BUILTIN_TOOLS]);
});

test("the refused and grantable sets are disjoint", () => {
  for (const name of Object.keys(REFUSED_BUILTIN_TOOLS)) {
    assert.ok(!GRANTABLE_BUILTIN_TOOLS.includes(name), `${name} is both refused and grantable`);
  }
});

test("a refused tool refuses the whole reconstruction, never a narrowed allowlist", () => {
  assert.throws(
    () =>
      reconstructEffectiveDefinition(proposal({ tools: ["read", "bash"] }), null, binding(), {
        runnerPath: fakeRunner(),
      }),
    (err: unknown) => err instanceof ReconstructionError && err.reason === "tool-policy-refused",
  );
});

test("every granted tool is bound to the runner digest", () => {
  const runner = fakeRunner();
  const def = reconstructEffectiveDefinition(proposal({ tools: ["read", "ls"] }), null, binding(), {
    runnerPath: runner,
  });
  assert.equal(def.effectiveTools.length, 2);
  for (const tool of def.effectiveTools) {
    assert.equal(tool.provenance, "builtin");
    assert.equal(tool.implementationDigest, def.runner.sha256);
  }
});

// --- runner -----------------------------------------------------------------

test("a missing runner refuses the reconstruction", () => {
  assert.throws(
    () => resolveRunner(path.join(os.tmpdir(), "pab-nonexistent-runner")),
    (err: unknown) => err instanceof ReconstructionError && err.reason === "runner-unresolvable",
  );
});

test("a directory is not a runner", () => {
  assert.throws(() => resolveRunner(os.tmpdir()), ReconstructionError);
});

test("an empty runner is refused", () => {
  assert.throws(
    () => resolveRunner(fakeRunner("")),
    (err: unknown) => err instanceof ReconstructionError && err.reason === "runner-unresolvable",
  );
});

test("runner digests differ for different bytes and match for identical bytes", () => {
  const a = resolveRunner(fakeRunner("alpha"));
  const b = resolveRunner(fakeRunner("beta"));
  const a2 = resolveRunner(fakeRunner("alpha"));
  assert.notEqual(a.sha256, b.sha256);
  assert.equal(a.sha256, a2.sha256);
  assert.equal(a.byteLength, 5);
});

test("the runner path is symlink-resolved before digesting", () => {
  const real = fakeRunner("target-bytes");
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pab-link-"));
  const link = path.join(linkDir, "pi-link");
  fs.symlinkSync(real, link);
  const viaLink = resolveRunner(link);
  assert.equal(viaLink.path, fs.realpathSync(real));
  assert.equal(viaLink.sha256, resolveRunner(real).sha256);
});

// --- argv policy ------------------------------------------------------------

test("the argv template carries every declared isolation flag", () => {
  const policy = buildArgvPolicy(null);
  assertArgvConsistent(policy);
  for (const flag of CHILD_ISOLATION_FLAGS) {
    assert.ok(policy.template.includes(flag), `template omits ${flag}`);
  }
});

test("isolation includes extension, skill, template, context, session, and trust flags", () => {
  // These are the flags that make the empty extension/module/event closures
  // true. Losing one silently would make the closure assertion a lie.
  for (const flag of [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--no-approve",
    "--no-themes",
  ]) {
    assert.ok(CHILD_ISOLATION_FLAGS.includes(flag), `missing isolation flag ${flag}`);
  }
});

test("an isolation flag missing from the template is caught", () => {
  const policy = buildArgvPolicy(null);
  const broken = {
    template: policy.template.filter((t) => t !== "--no-extensions"),
    isolation: policy.isolation,
  };
  assert.throws(
    () => assertArgvConsistent(broken),
    (err: unknown) =>
      err instanceof ReconstructionError && err.reason === "argv-policy-inconsistent",
  );
});

test("a model policy adds a model argument, and no model policy does not", () => {
  assert.ok(!buildArgvPolicy(null).template.includes("--model"));
  assert.ok(buildArgvPolicy("anthropic/claude").template.includes("--model"));
});

test("the argv template carries no caller-supplied material, only placeholders", () => {
  const def = reconstructEffectiveDefinition(
    proposal({ prompt: "SENSITIVE PROMPT TEXT", tools: ["read"] }),
    null,
    binding(),
    { runnerPath: fakeRunner() },
  );
  const joined = def.argvPolicy.template.join(" ");
  assert.ok(!joined.includes("SENSITIVE PROMPT TEXT"), "the prompt must stay a placeholder");
  assert.ok(joined.includes("{{system-prompt}}"));
  assert.ok(joined.includes("{{tools}}"));
});

// --- reconstruction is draft-independent ------------------------------------

test("reconstruction reads only the proposal, alias, binding, and policy", () => {
  // Two reconstructions of the same inputs agree; nothing persisted can
  // influence the result, because no persisted state is an input at all.
  const runner = fakeRunner();
  const a = reconstructEffectiveDefinition(proposal(), null, binding(), { runnerPath: runner });
  const b = reconstructEffectiveDefinition(proposal(), null, binding(), { runnerPath: runner });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Full-tree asset digest (#930, ADR-0131 Decisions 1-2).
//
// The digest must cover exactly what the sandboxed child can read: every
// entry under the install root EXCEPT the top-level .git the sandbox masks.
// ---------------------------------------------------------------------------

function treeDigestOf(root: string): string {
  return computeAssetTreeDigest(proposal({}, {}, { installRoot: root }));
}

test("asset digest covers every readable file, not just descriptor+wrapper", () => {
  const root = makeInstallRoot();
  const before = treeDigestOf(root);
  fs.writeFileSync(path.join(root, "reference.md"), "content the child can read");
  assert.notEqual(treeDigestOf(root), before);
});

test("asset digest excludes exactly the sandbox-masked top-level .git", () => {
  const root = makeInstallRoot();
  const before = treeDigestOf(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]");
  assert.equal(treeDigestOf(root), before);
  // A NESTED .git is readable in the child (only the top level is masked),
  // so it must be digested.
  fs.mkdirSync(path.join(root, "vendor", ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "vendor", ".git", "config"), "[core]");
  assert.notEqual(treeDigestOf(root), before);
});

test("asset digest records symlinks by target string and never follows them", () => {
  const root = makeInstallRoot();
  const targetFile = path.join(root, "agents", "work-item-planner.json");
  fs.symlinkSync("agents/work-item-planner.json", path.join(root, "link.json"));
  const withLink = treeDigestOf(root);
  // Following the link would double-count the target bytes; changing the
  // TARGET's content must change the digest via the file entry only, so the
  // symlink entry itself must be target-string-based: rewriting the link to a
  // different target changes the digest even when no file content changed.
  fs.unlinkSync(path.join(root, "link.json"));
  fs.symlinkSync("does-not-exist", path.join(root, "link.json"));
  assert.notEqual(treeDigestOf(root), withLink);
  // A dangling symlink is recordable evidence, not a refusal.
  assert.ok(treeDigestOf(root).length === 64);
  void targetFile;
});

test("asset walk refuses special files", { skip: process.platform === "win32" }, () => {
  const root = makeInstallRoot();
  const fifo = path.join(root, "pipe");
  try {
    // node has no mkfifo; use the platform binary where present.
    execFileSync("mkfifo", [fifo]);
  } catch {
    return; // mkfifo unavailable — nothing to assert on this host
  }
  assert.throws(
    () => walkAssetTree(root),
    (err: unknown) => err instanceof ReconstructionError && err.reason === "asset-tree-refused",
  );
});

test("asset walk refuses a path over the length bound", () => {
  const root = makeInstallRoot();
  let deep = root;
  const seg = "d".repeat(64);
  for (let i = 0; i < 9; i++) {
    deep = path.join(deep, seg);
    fs.mkdirSync(deep);
  }
  fs.writeFileSync(path.join(deep, "x"), "");
  assert.throws(
    () => walkAssetTree(root),
    (err: unknown) => err instanceof ReconstructionError && err.reason === "asset-tree-refused",
  );
});

test("asset walk refuses a tree over the entry bound", () => {
  const root = makeInstallRoot();
  const bulk = path.join(root, "bulk");
  fs.mkdirSync(bulk);
  for (let i = 0; i < GRANT_BOUNDS.maxAssetFiles + 1; i++) {
    fs.writeFileSync(path.join(bulk, `f${i}`), "");
  }
  assert.throws(
    () => walkAssetTree(root),
    (err: unknown) => err instanceof ReconstructionError && err.reason === "asset-tree-refused",
  );
});

test("asset walk is deterministic and ordered", () => {
  const root = makeInstallRoot();
  fs.writeFileSync(path.join(root, "b.txt"), "b");
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  const first = walkAssetTree(root);
  const second = walkAssetTree(root);
  assert.deepEqual(first, second);
  const rels = first.map((e) => e.relPath);
  assert.deepEqual(rels, [...rels].sort());
});

test("reconstruction refuses a missing install root", () => {
  assert.throws(
    () =>
      reconstructEffectiveDefinition(
        proposal({}, {}, { installRoot: "/tmp/definitely-missing-install-root" }),
        null,
        binding(),
        { runnerPath: fakeRunner() },
      ),
    (err: unknown) => err instanceof ReconstructionError && err.reason === "asset-tree-refused",
  );
});
