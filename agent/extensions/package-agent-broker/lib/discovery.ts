/**
 * discovery.ts — pure inert proposal discovery (#916).
 *
 * Reads already-installed pinned-Git packages' `agents/*.json` (and optional
 * sibling `agents/<name>.md` wrapper) as DATA ONLY. This module must never:
 * import package modules, execute lifecycle scripts, spawn processes, access
 * the network, resolve executable dependencies, or register any resource.
 * (Its imports are node:fs/node:path/node:crypto only; the adversarial test
 * suite asserts that statically.)
 *
 * Confinement per file:
 *   - candidate paths are built from validated components (no `..`, no
 *     separators in basenames) under the package's `agents/` directory;
 *   - every open uses O_NOFOLLOW and the opened descriptor is fstat-verified
 *     as a regular file within size bounds before reading;
 *   - the containing directory is lstat-verified as a real directory (not a
 *     symlink) before enumeration.
 *
 * Scope: USER-scope packages only (operator-owned `<agentDir>/git/...`).
 * Project-scope packages are deliberately out of scope for review drafts —
 * a repository-controlled install dir is not operator-owned evidence.
 *
 * The observed commit sha is read from the install tree's git metadata as
 * bounded data (`.git/HEAD`, one level of ref indirection, packed-refs).
 * It is EVIDENCE ONLY: the broker does not verify tree contents against it
 * (that reconstruction is #917's work) and the snapshot says so via
 * `unresolvedProvenance`.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  AGENT_NAME_RE,
  BOUNDS,
  QUALIFIED_ID_RE,
  isPrintableAscii,
  type PackageSourceIdentity,
  type SourceFileEvidence,
} from "../../shared/package-agent-review-contract.ts";
import { validateDescriptor, type AgentDescriptor, DescriptorError } from "./descriptor.ts";

export class DiscoveryError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "bounds-exceeded" // per-file size bound — continue-eligible skip
      | "total-budget-exceeded" // global pass budget — systemic, aborts the pass
      | "unsafe-file-refused"
      | "descriptor-invalid",
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/** One discovered, validated, inert proposal. */
export interface DiscoveredProposal {
  qualifiedId: string;
  packageIdentity: PackageSourceIdentity;
  descriptor: AgentDescriptor;
  descriptorText: string;
  descriptorEvidence: SourceFileEvidence;
  wrapperText: string | null;
  wrapperEvidence: SourceFileEvidence | null;
  /** Absolute install root the evidence was read from (state/UI only; never audited). */
  installRoot: string;
}

/** A package/file skipped with a bounded, safe reason (surfaced in the TUI). */
export interface DiscoverySkip {
  source: string | null;
  relPath: string | null;
  reason: string;
}

export interface DiscoveryResult {
  proposals: DiscoveredProposal[];
  skips: DiscoverySkip[];
}

/** Parsed pinned-git source. */
export interface PinnedGitSource {
  source: string;
  host: string;
  path: string;
  ref: string;
}

const HOST_RE = /^[a-z0-9.-]{1,128}$/;
const PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,7}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,128}$/;

/**
 * Parse a settings package source into a pinned git source, or null when the
 * entry is not a pinned git package (npm, local, unpinned git, malformed).
 * Accepts the string form and the object form's `source` field.
 */
export function parsePinnedGitSource(entry: unknown): PinnedGitSource | null {
  let source: string;
  if (typeof entry === "string") {
    source = entry;
  } else if (
    entry !== null &&
    typeof entry === "object" &&
    typeof (entry as { source?: unknown }).source === "string"
  ) {
    source = (entry as { source: string }).source;
  } else {
    return null;
  }
  if (!isPrintableAscii(source) || source.length > 512) return null;
  if (!source.startsWith("git:")) return null;
  const rest = source.slice(4);
  const at = rest.lastIndexOf("@");
  if (at <= 0) return null; // unpinned git sources are not eligible
  const hostAndPath = rest.slice(0, at);
  const ref = rest.slice(at + 1);
  const slash = hostAndPath.indexOf("/");
  if (slash <= 0) return null;
  const host = hostAndPath.slice(0, slash);
  const repoPath = hostAndPath.slice(slash + 1);
  if (!HOST_RE.test(host) || !PATH_RE.test(repoPath) || !REF_RE.test(ref)) return null;
  if (repoPath.split("/").some((seg) => seg === "." || seg === "..")) return null;
  if (ref.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return { source, host, path: repoPath, ref };
}

interface ByteBudget {
  left: number;
}

/**
 * Open a file with O_NOFOLLOW, verify it is a regular file within `maxBytes`,
 * and read it fully. Returns null when the file does not exist. Throws
 * DiscoveryError on symlinks, special files, or size violations.
 */
function readBoundedFile(
  absPath: string,
  maxBytes: number,
  budget: ByteBudget,
): { text: string; byteLength: number; sha256: string } | null {
  let fd: number;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new DiscoveryError("refusing symlinked file", "unsafe-file-refused");
    }
    throw new DiscoveryError("file open refused", "unsafe-file-refused");
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new DiscoveryError("refusing non-regular file", "unsafe-file-refused");
    }
    if (st.size > maxBytes) {
      throw new DiscoveryError("file exceeds size bound", "bounds-exceeded");
    }
    if (st.size > budget.left) {
      throw new DiscoveryError("discovery total-byte budget exceeded", "total-budget-exceeded");
    }
    const buf = Buffer.alloc(Number(st.size));
    let offset = 0;
    while (offset < buf.length) {
      const n = fs.readSync(fd, buf, offset, buf.length - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== buf.length) {
      throw new DiscoveryError("short read (file changed during read)", "unsafe-file-refused");
    }
    budget.left -= buf.length;
    return {
      text: buf.toString("utf8"),
      byteLength: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** lstat-verify `absPath` is a real directory (not a symlink). */
function isRealDirectory(absPath: string): boolean {
  try {
    const st = fs.lstatSync(absPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Read the installed tree's checked-out commit from git metadata as bounded
 * data. One level of symbolic-ref indirection plus packed-refs. Never spawns
 * a process. Returns null when unreadable — the proposal remains valid with
 * `observedCommit: null` (it is evidence, not authorization).
 *
 * Called once per package (not per descriptor file); when a shared discovery
 * budget is supplied, these reads count against it so git metadata cannot
 * bypass the global pass bound.
 */
export function readObservedCommit(installRoot: string, sharedBudget?: ByteBudget): string | null {
  const budget: ByteBudget = sharedBudget ?? { left: 512 * 1024 };
  try {
    const head = readBoundedFile(path.join(installRoot, ".git", "HEAD"), 4096, budget);
    if (!head) return null;
    const headText = head.text.trim();
    if (SHA_RE.test(headText)) return headText;
    if (!headText.startsWith("ref: ")) return null;
    const refName = headText.slice(5).trim();
    if (!/^refs\/[A-Za-z0-9._/-]{1,200}$/.test(refName)) return null;
    if (refName.split("/").some((seg) => seg === "." || seg === "..")) return null;
    const looseRef = readBoundedFile(path.join(installRoot, ".git", ...refName.split("/")), 4096, budget);
    if (looseRef) {
      const sha = looseRef.text.trim();
      return SHA_RE.test(sha) ? sha : null;
    }
    const packed = readBoundedFile(path.join(installRoot, ".git", "packed-refs"), 256 * 1024, budget);
    if (!packed) return null;
    for (const line of packed.text.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const sp = line.indexOf(" ");
      if (sp <= 0) continue;
      if (line.slice(sp + 1).trim() === refName) {
        const sha = line.slice(0, sp).trim();
        return SHA_RE.test(sha) ? sha : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface DiscoveryInput {
  /** Absolute agent dir (e.g. ~/.pi/agent). */
  agentDir: string;
  /** The operator settings `packages` array, verbatim. */
  settingsPackages: unknown[];
}

/**
 * Discover inert proposals across all configured pinned-git user-scope
 * packages. Data-only; every violation is either a thrown DiscoveryError
 * (systemic: budget exhausted) or a per-item skip with a bounded reason.
 */
export function discoverProposals(input: DiscoveryInput): DiscoveryResult {
  const proposals: DiscoveredProposal[] = [];
  const skips: DiscoverySkip[] = [];
  const budget: ByteBudget = { left: BOUNDS.maxTotalDiscoveryBytes };

  const entries = input.settingsPackages.slice(0, BOUNDS.maxPackages + 1);
  if (entries.length > BOUNDS.maxPackages) {
    throw new DiscoveryError("configured package count exceeds bound", "bounds-exceeded");
  }

  const seenQualifiedIds = new Set<string>();

  for (const entry of entries) {
    const pinned = parsePinnedGitSource(entry);
    if (!pinned) continue; // not a pinned-git package: out of discovery scope

    const installRoot = path.resolve(
      input.agentDir,
      "git",
      pinned.host,
      ...pinned.path.split("/"),
    );
    const gitRoot = path.resolve(input.agentDir, "git");
    if (installRoot !== gitRoot && !installRoot.startsWith(gitRoot + path.sep)) {
      skips.push({ source: pinned.source, relPath: null, reason: "install path escapes git root" });
      continue;
    }
    if (!isRealDirectory(installRoot)) {
      skips.push({ source: pinned.source, relPath: null, reason: "not installed" });
      continue;
    }
    const agentsDir = path.join(installRoot, "agents");
    if (!isRealDirectory(agentsDir)) continue; // package ships no agents: fine

    let names: string[];
    try {
      names = fs.readdirSync(agentsDir);
    } catch {
      skips.push({ source: pinned.source, relPath: "agents", reason: "unreadable directory" });
      continue;
    }
    const jsonNames = names.filter((n) => n.endsWith(".json")).sort();
    if (jsonNames.length > BOUNDS.maxAgentFilesPerPackage) {
      skips.push({ source: pinned.source, relPath: "agents", reason: "descriptor count exceeds bound" });
      continue;
    }

    // Once per package, charged to the shared discovery budget.
    const observedCommit = readObservedCommit(installRoot, budget);

    for (const fileName of jsonNames) {
      const base = fileName.slice(0, -".json".length);
      // Length-bounded here; display layers must additionally visibly encode
      // this value (an on-disk name may carry hostile bytes — see viewer.ts).
      const relPath = `agents/${fileName.slice(0, 120)}`;
      if (!AGENT_NAME_RE.test(base)) {
        skips.push({ source: pinned.source, relPath, reason: "invalid descriptor file name" });
        continue;
      }
      try {
        const read = readBoundedFile(path.join(agentsDir, fileName), BOUNDS.maxDescriptorBytes, budget);
        if (!read) {
          skips.push({ source: pinned.source, relPath, reason: "vanished during discovery" });
          continue;
        }
        const descriptor = validateDescriptor(read.text, base);

        const wrapperName = `${base}.md`;
        const wrapperRead = readBoundedFile(
          path.join(agentsDir, wrapperName),
          BOUNDS.maxWrapperBytes,
          budget,
        );

        const qualifiedId = `git:${pinned.host}/${pinned.path}@${pinned.ref}#${descriptor.name}`;
        if (!QUALIFIED_ID_RE.test(qualifiedId)) {
          skips.push({ source: pinned.source, relPath, reason: "assembled identity failed validation" });
          continue;
        }
        if (seenQualifiedIds.has(qualifiedId)) {
          skips.push({ source: pinned.source, relPath, reason: "duplicate qualified identity" });
          continue;
        }
        seenQualifiedIds.add(qualifiedId);

        proposals.push({
          qualifiedId,
          packageIdentity: {
            source: pinned.source,
            host: pinned.host,
            path: pinned.path,
            ref: pinned.ref,
            observedCommit,
          },
          descriptor,
          descriptorText: read.text,
          descriptorEvidence: { relPath, byteLength: read.byteLength, sha256: read.sha256 },
          wrapperText: wrapperRead ? wrapperRead.text : null,
          wrapperEvidence: wrapperRead
            ? { relPath: `agents/${wrapperName}`, byteLength: wrapperRead.byteLength, sha256: wrapperRead.sha256 }
            : null,
          installRoot,
        });
      } catch (err) {
        if (err instanceof DiscoveryError && err.reason === "total-budget-exceeded") {
          throw err; // systemic: the global pass budget is exhausted — refuse the whole pass
        }
        if (err instanceof DescriptorError) {
          skips.push({ source: pinned.source, relPath, reason: "descriptor invalid" });
        } else if (err instanceof DiscoveryError) {
          skips.push({ source: pinned.source, relPath, reason: err.reason });
        } else {
          skips.push({ source: pinned.source, relPath, reason: "unreadable" });
        }
      }
    }
  }

  return { proposals, skips };
}
