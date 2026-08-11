/**
 * reconstruct.ts — complete provenance reconstruction and the grant digest
 * (#928, ADR-0129; digest contents from ADR-0127 §5).
 *
 * This module answers the question #916 deliberately left open. A review
 * draft enumerates six fields it cannot resolve
 * (`UNRESOLVED_PROVENANCE_FIELDS`); a grant must resolve all six, from
 * CURRENT STATE, trusting nothing a draft recorded:
 *
 *   effective-tool-implementations → built-ins only, each bound to the runner
 *       digest (ADR-0127 §6). Non-built-ins are refused by `builtin-tools.ts`.
 *   runner-identity-and-content    → the executable that will actually be
 *       spawned: symlink-resolved, O_NOFOLLOW-opened, fstat-verified, and
 *       digested byte-for-byte.
 *   argv-policy                    → a broker-owned constant template,
 *       digested as data; placeholders are resolved at dispatch from the
 *       grant's own definition, never from caller input.
 *   extension-closure              → EMPTY BY CONSTRUCTION. The child is
 *       spawned with `--no-extensions` and no explicit `-e`.
 *   event-handler-set              → empty, following from the above: event
 *       handlers are registered by extensions.
 *   transitive-module-closure      → empty, following from an empty extension
 *       closure: there is no extension whose imports could be walked.
 *
 * "Empty" is recorded as `mode: "none"` — a positive assertion — so it can
 * never be read as "not determined". Reconstruction has no partial success:
 * a field that cannot be resolved is a refusal.
 *
 * Confinement, inherited from `discovery.ts` and not weakened: this module
 * imports node:fs/node:path/node:crypto only. It must never import package
 * modules, execute lifecycle scripts, SPAWN PROCESSES, or touch the network.
 * That constraint is why the runner is identified by its content digest and
 * not by shelling out to `--version`: the content digest is the authoritative
 * binding ADR-0127 §5 asks for, and a version string probed by spawning the
 * very binary under evaluation would be both weaker and a confinement breach.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  canonicalDigest,
  type CanonicalValue,
} from "../../shared/package-agent-canonical.ts";
import {
  GRANT_BOUNDS,
  GRANT_DIGEST_DOMAIN,
  GRANT_POLICY_VERSION,
  GRANT_SCHEMA_VERSION,
  type ApprovalBinding,
  type ArgvPolicy,
  type Closure,
  type EffectiveDefinition,
  type EffectiveTool,
  type EventHandlerSet,
  type RunnerIdentity,
} from "../../shared/package-agent-grant-contract.ts";
import { assertGrantableTools } from "./builtin-tools.ts";
import type { DiscoveredProposal } from "./discovery.ts";

export class ReconstructionError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "runner-unresolvable"
      | "revision-unresolvable"
      | "tool-policy-refused"
      | "argv-policy-inconsistent"
      | "bounds-exceeded"
      | "asset-tree-refused",
  ) {
    super(message);
    this.name = "ReconstructionError";
  }
}

/**
 * The isolation guarantees the argv template must carry. Restated as data so
 * that dropping a flag from the template without dropping it here is caught
 * by `assertArgvConsistent` rather than shipping silently.
 *
 * `--no-approve` is included deliberately: project-local trust must never be
 * inherited by a package-agent child.
 */
export const CHILD_ISOLATION_FLAGS: readonly string[] = [
  "--no-approve",
  "--no-context-files",
  "--no-extensions",
  "--no-prompt-templates",
  "--no-session",
  "--no-skills",
  "--no-themes",
];

/** Placeholders resolved at dispatch from the grant's own definition. */
export const ARGV_PLACEHOLDER_TOOLS = "{{tools}}";
export const ARGV_PLACEHOLDER_PROMPT = "{{system-prompt}}";
export const ARGV_PLACEHOLDER_MODEL = "{{model}}";

/**
 * Build the broker-owned argv template. It is a pure function of broker
 * policy plus the agent's own model policy — no caller-supplied material
 * reaches it.
 */
export function buildArgvPolicy(modelPolicy: string | null): ArgvPolicy {
  const template: string[] = [
    ...CHILD_ISOLATION_FLAGS,
    "--print",
    "--mode",
    "json",
    "--tools",
    ARGV_PLACEHOLDER_TOOLS,
    "--system-prompt",
    ARGV_PLACEHOLDER_PROMPT,
  ];
  if (modelPolicy !== null) {
    template.push("--model", ARGV_PLACEHOLDER_MODEL);
  }
  if (template.length > GRANT_BOUNDS.maxArgvEntries) {
    throw new ReconstructionError("argv template exceeds entry bound", "bounds-exceeded");
  }
  return { template, isolation: CHILD_ISOLATION_FLAGS };
}

/** Every declared isolation flag must actually appear in the argv template. */
export function assertArgvConsistent(policy: ArgvPolicy): void {
  for (const flag of policy.isolation) {
    if (!policy.template.includes(flag)) {
      throw new ReconstructionError(
        `argv template omits declared isolation flag ${flag}`,
        "argv-policy-inconsistent",
      );
    }
  }
}

const RUNNER_READ_CHUNK = 1024 * 1024;

/**
 * Resolve and digest the runner executable.
 *
 * The path is symlink-resolved FIRST (so the digest describes the file that
 * will actually execute), then opened with O_NOFOLLOW and fstat-verified as a
 * regular file within bounds — closing the window where the resolved path is
 * replaced by a symlink between resolution and open.
 */
export function resolveRunner(runnerPath: string): RunnerIdentity {
  let resolved: string;
  try {
    resolved = fs.realpathSync(runnerPath);
  } catch {
    throw new ReconstructionError("runner path could not be resolved", "runner-unresolvable");
  }

  let fd: number;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new ReconstructionError("runner could not be opened", "runner-unresolvable");
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new ReconstructionError("runner is not a regular file", "runner-unresolvable");
    }
    if (st.size === 0) {
      throw new ReconstructionError("runner is empty", "runner-unresolvable");
    }
    if (st.size > GRANT_BOUNDS.maxRunnerBytes) {
      throw new ReconstructionError("runner exceeds size bound", "bounds-exceeded");
    }
    const hash = createHash("sha256");
    const buf = Buffer.alloc(RUNNER_READ_CHUNK);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      total += n;
      if (total > st.size) {
        throw new ReconstructionError("runner grew during read", "runner-unresolvable");
      }
    }
    if (total !== st.size) {
      throw new ReconstructionError("runner changed during read", "runner-unresolvable");
    }
    return {
      path: resolved,
      byteLength: total,
      sha256: hash.digest("hex"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Ordered content-addressed digest over every package byte that can reach the
 * child: the FULL install tree, minus the sandbox-masked top-level `.git`
 * (#930, ADR-0131 Decisions 1–2).
 *
 * History: #928 hashed only the descriptor and wrapper, on the premise that
 * no other package file could influence the child. ADR-0130 falsified that
 * premise — the sandbox binds the whole install root read-only, so a
 * `read`/`grep`/`find`/`ls`-granted child can read every file under it. The
 * one-directional coupling rule this header used to state ("if #930 widens
 * what the child reads, this digest MUST widen with it") therefore fired,
 * and the digest now covers exactly the readable tree:
 *
 *   - the top-level `.git` is EXCLUDED, byte-for-byte matching the sandbox
 *     mask in `child-sandbox.ts` (`--tmpfs` / SBPL deny) — VCS internals are
 *     unreadable in the child, and `resolvedCommit` already binds revision
 *     identity. A nested directory named `.git` deeper in the tree is NOT
 *     masked, so it IS digested. Changing either side without the other
 *     breaks the coverage argument; both cite this paragraph.
 *   - regular files are content-hashed (O_NOFOLLOW, fstat-verified, size
 *     drift refused — same discipline as `resolveRunner`);
 *   - symlinks are recorded as entries carrying their literal target string
 *     and are NEVER followed (a symlink's readable content in the child is
 *     whatever its target resolves to inside the mount namespace — binding
 *     the target string binds what the operator can review);
 *   - any other file type (fifo, socket, device) refuses reconstruction;
 *   - the walk is bounded by `GRANT_BOUNDS.maxAssetFiles` and
 *     `GRANT_BOUNDS.maxAssetTreeBytes` and refuses on overflow;
 *   - ordering is a deterministic sort over `/`-separated relPaths, which
 *     the canonical encoding then binds.
 */
const ASSET_TREE_MAX_RELPATH_CHARS = 512;

interface AssetTreeFileEntry {
  relPath: string;
  kind: "file";
  byteLength: number;
  sha256: string;
}

interface AssetTreeSymlinkEntry {
  relPath: string;
  kind: "symlink";
  target: string;
}

type AssetTreeEntry = AssetTreeFileEntry | AssetTreeSymlinkEntry;

function refuseAssetTree(message: string): never {
  throw new ReconstructionError(message, "asset-tree-refused");
}

function hashRegularFile(absPath: string, relPath: string): AssetTreeFileEntry {
  let fd: number;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    refuseAssetTree(`asset tree entry could not be opened: ${relPath}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      refuseAssetTree(`asset tree entry changed type during walk: ${relPath}`);
    }
    const hash = createHash("sha256");
    const buf = Buffer.alloc(RUNNER_READ_CHUNK);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      total += n;
      if (total > st.size) {
        refuseAssetTree(`asset tree entry grew during read: ${relPath}`);
      }
    }
    if (total !== st.size) {
      refuseAssetTree(`asset tree entry changed during read: ${relPath}`);
    }
    return { relPath, kind: "file", byteLength: total, sha256: hash.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

/** Walk the install tree into deterministic, bounded, content-addressed entries. */
export function walkAssetTree(installRoot: string): AssetTreeEntry[] {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(installRoot);
  } catch {
    refuseAssetTree("install root could not be read");
  }
  if (!rootStat.isDirectory()) {
    refuseAssetTree("install root is not a directory");
  }

  const entries: AssetTreeEntry[] = [];
  let totalBytes = 0;

  const visit = (dirAbs: string, dirRel: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dirAbs);
    } catch {
      refuseAssetTree(`asset tree directory could not be read: ${dirRel || "."}`);
    }
    names.sort();
    for (const name of names) {
      // The sandbox masks exactly the TOP-LEVEL .git (see header). Nested
      // `.git` names are ordinary readable content and are digested. The
      // mask (bwrap --tmpfs / SBPL subpath deny) assumes a DIRECTORY; a
      // worktree-style `.git` FILE would make the mask's shape ambiguous,
      // so it refuses here with a clear reason instead of an opportunistic
      // wrapper spawn error (2026-07-31 security review).
      if (dirRel === "" && name === ".git") {
        let gitStat: fs.Stats;
        try {
          gitStat = fs.lstatSync(path.join(dirAbs, name));
        } catch {
          refuseAssetTree("top-level .git could not be stat'd");
        }
        if (!gitStat.isDirectory()) {
          refuseAssetTree("top-level .git is not a directory (worktree-style installs are not maskable)");
        }
        continue;
      }
      const relPath = dirRel === "" ? name : `${dirRel}/${name}`;
      if (relPath.length > ASSET_TREE_MAX_RELPATH_CHARS) {
        refuseAssetTree("asset tree path exceeds length bound");
      }
      const abs = path.join(dirAbs, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        refuseAssetTree(`asset tree entry could not be stat'd: ${relPath}`);
      }
      if (st.isDirectory()) {
        visit(abs, relPath);
        continue;
      }
      if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.readlinkSync(abs);
        } catch {
          refuseAssetTree(`asset tree symlink could not be read: ${relPath}`);
        }
        entries.push({ relPath, kind: "symlink", target });
      } else if (st.isFile()) {
        totalBytes += st.size;
        if (totalBytes > GRANT_BOUNDS.maxAssetTreeBytes) {
          refuseAssetTree("asset tree exceeds byte bound");
        }
        entries.push(hashRegularFile(abs, relPath));
      } else {
        refuseAssetTree(`asset tree contains a special file: ${relPath}`);
      }
      if (entries.length > GRANT_BOUNDS.maxAssetFiles) {
        refuseAssetTree("asset tree exceeds entry bound");
      }
    }
  };

  visit(installRoot, "");
  return entries;
}

export function computeAssetTreeDigest(proposal: DiscoveredProposal): string {
  const entries: CanonicalValue[] = walkAssetTree(proposal.installRoot).map(
    (e): CanonicalValue =>
      e.kind === "file"
        ? { relPath: e.relPath, kind: e.kind, byteLength: e.byteLength, sha256: e.sha256 }
        : { relPath: e.relPath, kind: e.kind, target: e.target },
  );
  return canonicalDigest(`${GRANT_DIGEST_DOMAIN}/asset-tree`, entries);
}

/** The empty-by-construction closures an isolated child necessarily has. */
export const EMPTY_CLOSURE: Closure = Object.freeze({ mode: "none", entries: [] });
export const EMPTY_EVENT_HANDLERS: EventHandlerSet = Object.freeze({ mode: "none", handlers: [] });

export interface ReconstructOptions {
  /**
   * Path of the executable that will be spawned. Defaults to this runtime's
   * own executable, which is what #930 will spawn.
   */
  runnerPath?: string;
}

/**
 * Reconstruct the complete effective definition for one proposal.
 *
 * `binding` carries the approval-instance material (approval identifier,
 * nonce, expiry). At approval it is generated fresh; at dispatch-time
 * revalidation it is taken from the in-memory grant being validated against,
 * because those fields are properties of the approval event rather than of
 * the package on disk. Everything else is re-derived from current state on
 * every call — that is what makes the dispatch-time digest comparison
 * meaningful.
 *
 * Nothing from a #916 review draft is read here, by construction: the inputs
 * are a freshly discovered proposal, the operator's alias choice, the
 * approval binding, and broker policy.
 */
export function reconstructEffectiveDefinition(
  proposal: DiscoveredProposal,
  alias: string | null,
  binding: ApprovalBinding,
  options: ReconstructOptions = {},
): EffectiveDefinition {
  const d = proposal.descriptor;

  // A grant requires a resolved immutable revision. #916 tolerated null here
  // because a draft authorizes nothing; a grant may not.
  const resolvedCommit = proposal.packageIdentity.observedCommit;
  if (resolvedCommit === null || resolvedCommit.length === 0) {
    throw new ReconstructionError(
      "package revision could not be resolved from the install tree",
      "revision-unresolvable",
    );
  }

  try {
    assertGrantableTools(d.tools);
  } catch (err) {
    throw new ReconstructionError(
      err instanceof Error ? err.message : "tool policy refused",
      "tool-policy-refused",
    );
  }
  if (d.tools.length > GRANT_BOUNDS.maxEffectiveTools) {
    throw new ReconstructionError("tool count exceeds grant bound", "bounds-exceeded");
  }

  const runner = resolveRunner(options.runnerPath ?? process.execPath);

  // Built-in tools ARE the runner's own code (ADR-0127 §6).
  const effectiveTools: EffectiveTool[] = d.tools.map((name) => ({
    name,
    provenance: "builtin" as const,
    implementationDigest: runner.sha256,
  }));

  const argvPolicy = buildArgvPolicy(d.model);
  assertArgvConsistent(argvPolicy);

  return Object.freeze({
    schemaVersion: GRANT_SCHEMA_VERSION,
    policyVersion: GRANT_POLICY_VERSION,
    digestDomain: GRANT_DIGEST_DOMAIN,

    qualifiedId: proposal.qualifiedId,
    agentName: d.name,
    alias,

    packageIdentity: { ...proposal.packageIdentity },
    resolvedCommit,
    assetTreeDigest: computeAssetTreeDigest(proposal),

    descriptorText: proposal.descriptorText,
    descriptorEvidence: { ...proposal.descriptorEvidence },
    wrapperText: proposal.wrapperText,
    wrapperEvidence: proposal.wrapperEvidence ? { ...proposal.wrapperEvidence } : null,

    promptText: d.prompt,

    effectiveTools,

    runner,
    argvPolicy,
    extensionClosure: EMPTY_CLOSURE,
    moduleClosure: EMPTY_CLOSURE,
    eventHandlerSet: EMPTY_EVENT_HANDLERS,

    environmentPolicy: { ...d.environment },
    modelPolicy: d.model,
    guardPolicy: d.guardProfile,
    contextPolicy: d.contextPolicy,

    approval: { ...binding.approval },
    nonce: binding.nonce,
    expiresAtMs: binding.expiresAtMs,
    expiresAtMonotonicMs: binding.expiresAtMonotonicMs,
    clockSuspendInclusive: binding.clockSuspendInclusive,
  });
}

function closureValue(c: Closure): CanonicalValue {
  return {
    mode: c.mode,
    entries: c.entries.map((e) => ({
      relPath: e.relPath,
      byteLength: e.byteLength,
      sha256: e.sha256,
    })),
  };
}

/**
 * Canonical value for the effective definition. Every field is mapped
 * explicitly — a new field must be added here (and to the digest-coverage
 * table in `test/grant-digest.test.ts`) or it silently escapes the digest.
 */
export function definitionCanonicalValue(def: EffectiveDefinition): CanonicalValue {
  return {
    schemaVersion: def.schemaVersion,
    policyVersion: def.policyVersion,
    digestDomain: def.digestDomain,

    qualifiedId: def.qualifiedId,
    agentName: def.agentName,
    alias: def.alias,

    packageIdentity: {
      source: def.packageIdentity.source,
      host: def.packageIdentity.host,
      path: def.packageIdentity.path,
      ref: def.packageIdentity.ref,
      observedCommit: def.packageIdentity.observedCommit,
    },
    resolvedCommit: def.resolvedCommit,
    assetTreeDigest: def.assetTreeDigest,

    descriptorText: def.descriptorText,
    descriptorEvidence: {
      relPath: def.descriptorEvidence.relPath,
      byteLength: def.descriptorEvidence.byteLength,
      sha256: def.descriptorEvidence.sha256,
    },
    wrapperText: def.wrapperText,
    wrapperEvidence: def.wrapperEvidence
      ? {
          relPath: def.wrapperEvidence.relPath,
          byteLength: def.wrapperEvidence.byteLength,
          sha256: def.wrapperEvidence.sha256,
        }
      : null,

    promptText: def.promptText,

    effectiveTools: def.effectiveTools.map((t) => ({
      name: t.name,
      provenance: t.provenance,
      implementationDigest: t.implementationDigest,
    })),

    runner: {
      path: def.runner.path,
      byteLength: def.runner.byteLength,
      sha256: def.runner.sha256,
    },
    argvPolicy: {
      template: [...def.argvPolicy.template],
      isolation: [...def.argvPolicy.isolation],
    },
    extensionClosure: closureValue(def.extensionClosure),
    moduleClosure: closureValue(def.moduleClosure),
    eventHandlerSet: {
      mode: def.eventHandlerSet.mode,
      handlers: [...def.eventHandlerSet.handlers],
    },

    environmentPolicy: { ...def.environmentPolicy },
    modelPolicy: def.modelPolicy,
    guardPolicy: def.guardPolicy,
    contextPolicy: def.contextPolicy,

    approval: {
      runtimeInstanceId: def.approval.runtimeInstanceId,
      sequence: def.approval.sequence,
    },
    nonce: def.nonce,
    expiresAtMs: def.expiresAtMs,
    expiresAtMonotonicMs: def.expiresAtMonotonicMs,
    clockSuspendInclusive: def.clockSuspendInclusive,
  };
}

/** sha256 hex grant digest under the active-grant domain. */
export function computeGrantDigest(def: EffectiveDefinition): string {
  return canonicalDigest(GRANT_DIGEST_DOMAIN, definitionCanonicalValue(def));
}

/** Byte-exact equality of two reconstructed definitions. */
export function definitionsEqual(a: EffectiveDefinition, b: EffectiveDefinition): boolean {
  return computeGrantDigest(a) === computeGrantDigest(b);
}
