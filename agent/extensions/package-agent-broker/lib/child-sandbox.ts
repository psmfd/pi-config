/**
 * child-sandbox.ts — pure builders for the package-agent child filesystem
 * confinement (#934, ADR-0130).
 *
 * PURE BY DESIGN: no filesystem, no subprocess spawning, no network. It builds
 * the sandbox artifacts — the macOS SBPL profile, the Linux bwrap argv, the
 * explicit child environment, and the canary verification plan — and #930's
 * dispatch component is what spawns through them. Keeping the builders pure
 * preserves the broker extension's standing static assertions (no spawn, no
 * network) and makes every artifact unit-testable byte-for-byte.
 *
 * Confinement is RESOURCE CONTAINMENT applied at spawn, never an
 * authorization input: it does not touch the grant digest, and the tool set
 * the operator approved is unchanged — only its filesystem reach is bounded.
 *
 * Non-negotiable properties (ADR-0130):
 *
 *   - deny-default. The macOS profile's first rule is `(deny default)` —
 *     an allow-default profile is a denylist, the documented real-world
 *     escape shape. The bwrap namespace contains only what is explicitly
 *     bound.
 *   - `~/.pi/agent` (auth.json, sessions, settings, extensions) is never
 *     visible, even though the package root nests under it: only the
 *     package-root SUBPATH is allowed, and the spec validator refuses roots
 *     that are not strictly under `<agentDir>/git/`.
 *   - the child never downloads tool binaries: `rg`/`fd` come from a
 *     read-only pre-provisioned directory and `PI_OFFLINE=1` is always set.
 *   - the environment is an explicit allowlist built here; the dispatcher
 *     must pass EXACTLY this env to the spawn, never the broker's own.
 *   - verification is empirical: the canary plan must be executed through
 *     the IDENTICAL wrapper before the real child spawns, and any anomaly
 *     refuses dispatch (fail posture = no file-tool dispatch, ADR-0130).
 */

import * as path from "node:path";

export class SandboxSpecError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "path-not-absolute"
      | "path-unrepresentable"
      | "package-root-outside-git"
      | "scratch-inside-agent-dir"
      | "sensitive-agent-path"
      | "path-too-shallow"
      | "reserved-env-var"
      | "unsupported-platform",
  ) {
    super(message);
    this.name = "SandboxSpecError";
  }
}

/**
 * Directories/files under the agent dir that hold operator credentials,
 * session history, or auto-loaded code. Nothing bound into the child may
 * live under any of these, whatever else the spec says.
 */
export const SENSITIVE_AGENT_SUBPATHS: readonly string[] = [
  "auth.json",
  "settings.json",
  "sessions",
  "extensions",
  "skills",
  "prompts",
];

export interface SandboxSpec {
  platform: "linux" | "darwin";
  /** The operator agent dir (`~/.pi/agent`). Used for validation only. */
  agentDir: string;
  /** Package install root — must be strictly under `<agentDir>/git/`. */
  packageRoot: string;
  /** Scratch dir (rw) — must live OUTSIDE the agent dir. */
  scratchDir: string;
  /** Absolute path of the child binary (pi). */
  childBinary: string;
  /** Read-only dir holding pre-provisioned `rg`/`fd`, or null for none. */
  toolBinDir: string | null;
  /** Linux: CA bundle path pinned into SSL_CERT_FILE. Ignored on darwin. */
  caBundlePath?: string;
}

/** Paths are embedded in SBPL strings and argv; keep them boring. */
function assertRepresentablePath(p: string, label: string): void {
  if (!path.isAbsolute(p)) {
    throw new SandboxSpecError(`${label} must be absolute`, "path-not-absolute");
  }
  if (p !== path.normalize(p) || p.includes("..")) {
    throw new SandboxSpecError(`${label} must be normalized`, "path-unrepresentable");
  }
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || p[i] === '"' || p[i] === "\\") {
      throw new SandboxSpecError(
        `${label} contains characters unsafe for profile embedding`,
        "path-unrepresentable",
      );
    }
  }
}

function isStrictlyUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Minimum path depth (segments below root) for a caller-supplied writable or
 * bindable location. `/` is depth 0, `/scratch` depth 1, `/a/b/c` depth 3.
 * A shallow path like `/` or `/tmp` bound read-write, or allowed as a
 * tool-exec subpath, would defeat confinement wholesale — `validateSandboxSpec`
 * refuses it rather than trust the caller to never pass one.
 */
function pathDepth(p: string): number {
  return p.split("/").filter((s) => s.length > 0).length;
}

const MIN_SCRATCH_DEPTH = 2;
const MIN_TOOLBIN_DEPTH = 2;

export function validateSandboxSpec(spec: SandboxSpec): void {
  if (spec.platform !== "linux" && spec.platform !== "darwin") {
    throw new SandboxSpecError(
      `no confinement mechanism for platform ${String(spec.platform)}`,
      "unsupported-platform",
    );
  }
  assertRepresentablePath(spec.agentDir, "agentDir");
  assertRepresentablePath(spec.packageRoot, "packageRoot");
  assertRepresentablePath(spec.scratchDir, "scratchDir");
  assertRepresentablePath(spec.childBinary, "childBinary");
  if (spec.toolBinDir !== null) assertRepresentablePath(spec.toolBinDir, "toolBinDir");
  if (spec.caBundlePath !== undefined) assertRepresentablePath(spec.caBundlePath, "caBundlePath");

  const gitRoot = path.join(spec.agentDir, "git");
  if (!isStrictlyUnder(spec.packageRoot, gitRoot)) {
    throw new SandboxSpecError(
      "packageRoot must be strictly under <agentDir>/git/",
      "package-root-outside-git",
    );
  }
  if (spec.scratchDir === spec.agentDir || isStrictlyUnder(spec.scratchDir, spec.agentDir)) {
    throw new SandboxSpecError(
      "scratchDir must live outside the agent dir",
      "scratch-inside-agent-dir",
    );
  }
  // ...and must not be an ANCESTOR of the agent dir either: a scratch at the
  // home dir would nest agentDir (and auth.json) inside the read-write scratch
  // grant. Both nesting directions are refused.
  if (isStrictlyUnder(spec.agentDir, spec.scratchDir)) {
    throw new SandboxSpecError(
      "scratchDir must not contain the agent dir",
      "scratch-inside-agent-dir",
    );
  }
  // Upper bound: a shallow scratch (`/`, `/tmp`) becomes `--bind` of a broad
  // writable tree; a shallow toolBinDir becomes a broad process-exec/read
  // subpath. Either silently defeats confinement — refuse both.
  if (pathDepth(spec.scratchDir) < MIN_SCRATCH_DEPTH) {
    throw new SandboxSpecError(
      `scratchDir is too shallow (min depth ${MIN_SCRATCH_DEPTH})`,
      "path-too-shallow",
    );
  }
  if (spec.toolBinDir !== null && pathDepth(spec.toolBinDir) < MIN_TOOLBIN_DEPTH) {
    throw new SandboxSpecError(
      `toolBinDir is too shallow (min depth ${MIN_TOOLBIN_DEPTH})`,
      "path-too-shallow",
    );
  }
  // The binary and tool dir may legitimately live under the agent dir (this
  // repo vendors pi under agent/vendor), but never under a sensitive subpath.
  for (const candidate of [spec.childBinary, spec.toolBinDir ?? undefined]) {
    if (candidate === undefined) continue;
    for (const sensitive of SENSITIVE_AGENT_SUBPATHS) {
      const sensitiveAbs = path.join(spec.agentDir, sensitive);
      if (candidate === sensitiveAbs || isStrictlyUnder(candidate, sensitiveAbs)) {
        throw new SandboxSpecError(
          `sandbox may not expose ${sensitive} from the agent dir`,
          "sensitive-agent-path",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// macOS: deny-default SBPL profile.
// ---------------------------------------------------------------------------

/**
 * CANONICAL PATHS REQUIRED: Seatbelt filters match against canonical vnode
 * paths, so every path in the spec must be pre-resolved through realpath by
 * the caller (`~/.pi` and `/var`/`/tmp` are symlinks on real hosts). This
 * pure module cannot resolve them itself — but the mistake is not silent:
 * a non-canonical packageRoot makes the canary's MUST-SUCCEED in-scope read
 * fail, which refuses dispatch (fail closed, ADR-0130).
 */
export function buildDarwinProfile(spec: SandboxSpec): string {
  validateSandboxSpec(spec);
  const q = (p: string): string => `"${p}"`;
  // getcwd()/path resolution needs stat access on every ANCESTOR component
  // of the cwd (the package root) and scratch. LITERALS only — never a
  // subpath — so this discloses the existence of path components the grant
  // already names, not any sibling content (the existence-oracle concern
  // ADR-0130 scoped file-read-metadata for).
  const ancestorLiterals = (p: string): string[] => {
    const out: string[] = [];
    let cur = path.dirname(p);
    while (cur !== "/" && out.length < 32) {
      out.push(cur);
      cur = path.dirname(cur);
    }
    return out;
  };
  const metadataAncestors = [
    ...new Set([...ancestorLiterals(spec.packageRoot), ...ancestorLiterals(spec.scratchDir)]),
  ].sort();
  const lines: string[] = [
    "(version 1)",
    // FIRST RULE DECIDES: deny-default makes this an allowlist. Reordering
    // this line below any allow turns the profile into a denylist — the
    // documented escape shape ADR-0130 forbids.
    "(deny default)",
    "",
    ";; process bootstrap / dyld / Bun runtime. The bare root-directory",
    ";; literal is a verified bootstrap requirement (2026-07-30): without",
    ";; file-read on the root dir itself the child aborts before main().",
    "(allow process-fork)",
    `(allow process-exec (literal ${q(spec.childBinary)}))`,
    ...(spec.toolBinDir !== null ? [`(allow process-exec (subpath ${q(spec.toolBinDir)}))`] : []),
    '(allow file-read* (literal "/"))',
    '(allow file-read* (subpath "/usr/lib"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/private/var/db/dyld"))',
    `(allow file-read* (literal ${q(spec.childBinary)}))`,
    ...(spec.toolBinDir !== null ? [`(allow file-read* (subpath ${q(spec.toolBinDir)}))`] : []),
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    ";; stat/access only, and scoped to the runtime read-set rather than the",
    ";; whole filesystem: a blanket (subpath \"/\") here is a metadata-existence",
    ";; oracle over ~/.ssh, ~/.aws, and sibling repos. These are the same paths",
    ";; content-read is allowed for, plus the package root and scratch.",
    '(allow file-read-metadata (literal "/"))',
    '(allow file-read-metadata (subpath "/usr/lib"))',
    '(allow file-read-metadata (subpath "/System"))',
    '(allow file-read-metadata (subpath "/private/var/db/dyld"))',
    `(allow file-read-metadata (literal ${q(spec.childBinary)}))`,
    ...(spec.toolBinDir !== null ? [`(allow file-read-metadata (subpath ${q(spec.toolBinDir)}))`] : []),
    `(allow file-read-metadata (subpath ${q(spec.packageRoot)}))`,
    `(allow file-read-metadata (subpath ${q(spec.scratchDir)}))`,
    ...metadataAncestors.map((a) => `(allow file-read-metadata (literal ${q(a)}))`),
    "(allow sysctl-read)",
    "(allow signal (target self))",
    "(allow process-info* (target self))",
    ";; DNS only — scoped to mDNSResponder, not every registered Mach service.",
    '(allow mach-lookup (global-name "com.apple.mDNSResponder"))',
    "",
    ";; the confined subtree: read-only",
    `(allow file-read* (subpath ${q(spec.packageRoot)}))`,
    ";; ...minus the package's own VCS internals (#930, ADR-0131 Decision 2):",
    ";; the top-level .git holds the full object store and no granted tool",
    ";; needs it. Later rules win in SBPL, so these denies override the",
    ";; subpath allows above. The digest walk in reconstruct.ts excludes",
    ";; exactly this path — keep the two aligned.",
    `(deny file-read* (subpath ${q(spec.packageRoot + "/.git")}))`,
    `(deny file-read-metadata (subpath ${q(spec.packageRoot + "/.git")}))`,
    "",
    ";; scratch: the only writable location",
    `(allow file-read* file-write* (subpath ${q(spec.scratchDir)}))`,
    '(allow file-write* (literal "/dev/null"))',
    "",
    ";; outbound network only (model provider reachability)",
    "(allow network-outbound)",
    "(allow system-socket)",
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Linux: bwrap argv.
// ---------------------------------------------------------------------------

/**
 * Arguments after the `bwrap` binary itself. The mount namespace contains
 * ONLY what is bound here; the trailing `--` is followed by the child argv
 * the dispatcher appends.
 *
 * `--clearenv` + `--setenv` make the child environment SELF-CONTAINED: the
 * sandboxed child's environment is exactly `env`, regardless of whatever
 * environment the dispatcher's spawn call inherits. Without it, bwrap forwards
 * its own (broker) environment, and the child's own granted `read` built-in
 * could recover it via `/proc/self/environ` — a same-uid self-read the
 * filesystem allowlist does not stop (the mount includes `/proc`). The env map
 * is therefore an OS-enforced allowlist here, not a caller convention.
 *
 * ‼ SECRET-IN-ARGV: these args carry `--setenv <VAR> <value>` pairs, including
 * the credential. If the dispatcher passes them as bwrap's literal command-line
 * argv, the credential lands in the long-lived monitor process's
 * `/proc/<pid>/cmdline`, which is WORLD-readable on a default Debian host
 * (`hidepid=0`) — a strictly worse exposure than the `/proc/self/environ`
 * same-uid self-read `--clearenv` closes. The dispatcher (#930) MUST therefore
 * deliver these args via bwrap's `--args <fd>` primitive — write
 * `encodeBwrapArgsFd(args)` to a pipe and spawn `bwrap --args <fd> -- …` so the
 * only visible argv is `--args <fd>` and no `--setenv` value is exposed. The
 * credential then reaches the child's `environ` only (same-uid, per the
 * disclosed non-goal), never `cmdline`. Pass `buildChildEnv(spec, credential)`
 * as `env`.
 */
function buildBwrapArgs(spec: SandboxSpec, env: Record<string, string>): string[] {
  validateSandboxSpec(spec);
  const setenv: string[] = [];
  for (const key of Object.keys(env).sort()) {
    setenv.push("--setenv", key, env[key]);
  }
  const args: string[] = [
    "--clearenv",
    ...setenv,
    "--ro-bind", "/usr/lib", "/usr/lib",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/usr/lib64", "/usr/lib64",
    // Deliberately NOT binding /usr/bin or /bin wholesale: bwrap has no
    // process-exec allowlist (unlike Seatbelt), so a bound executable tree is
    // a runnable tree. Only the child binary and the pre-provisioned toolBinDir
    // (rg/fd) are bound below — everything else is simply absent from the
    // namespace, so an execve of it fails ENOENT with no rule required.
    "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind", spec.childBinary, spec.childBinary,
    ...(spec.toolBinDir !== null ? ["--ro-bind", spec.toolBinDir, spec.toolBinDir] : []),
    "--ro-bind", spec.packageRoot, spec.packageRoot,
    // Mask the package's top-level .git (#930, ADR-0131 Decision 2): an empty
    // tmpfs over the subpath hides the object store from the child. Mounted
    // unconditionally — if the package has no .git, the child merely sees an
    // empty dir. The digest walk in reconstruct.ts excludes exactly this
    // path — keep the two aligned.
    "--tmpfs", spec.packageRoot + "/.git",
    "--bind", spec.scratchDir, spec.scratchDir,
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--chdir", spec.packageRoot,
    "--",
  ];
  return args;
}

/**
 * Encode `buildBwrapArgs` output as the NUL-separated payload bwrap's
 * `--args <fd>` reads. The dispatcher writes this to a pipe and spawns
 * `bwrap --args <fd> -- <childArgv…>`, keeping every `--setenv` value
 * (the credential) out of the process's visible `/proc/<pid>/cmdline`.
 * A NUL in any arg is rejected — it is the field separator and cannot appear
 * inside a value (a credential never legitimately contains one).
 */
function encodeBwrapArgsFd(args: readonly string[]): string {
  for (const a of args) {
    if (a.includes("\0")) {
      throw new SandboxSpecError("bwrap arg contains a NUL separator", "path-unrepresentable");
    }
  }
  return args.join("\0") + "\0";
}

/**
 * The ONLY exported form of the bwrap arguments (#930 security-review
 * hand-off d): a raw argv array can be spread into a spawn call, putting
 * every `--setenv` value — the credential — into the world-readable
 * `/proc/<pid>/cmdline`. Exporting only the NUL fd payload makes that
 * mistake structurally impossible: the payload is consumable solely by
 * writing it to the `--args <fd>` pipe. Tests parse it by splitting on NUL.
 */
export function buildBwrapArgsFdPayload(spec: SandboxSpec, env: Record<string, string>): string {
  return encodeBwrapArgsFd(buildBwrapArgs(spec, env));
}

// ---------------------------------------------------------------------------
// Environment allowlist.
// ---------------------------------------------------------------------------

export interface ChildCredential {
  /**
   * Env var carrying provider credentials. Target: `ANTHROPIC_AUTH_TOKEN`
   * holding a short-lived bearer minted at dispatch time via
   * `pi auth print-bearer-token` (pi >= 0.83.0). Pre-bump fallback: the
   * provider API-key var. Never auth.json — it is not mounted.
   */
  envVar: string;
  value: string;
}

const CREDENTIAL_ENV_VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Env keys the allowlist owns. A credential var colliding with one of these
 * would silently overwrite a load-bearing value — most damagingly `PI_OFFLINE`
 * (the "no runtime tool download" invariant) — so a collision is refused, not
 * last-write-wins.
 */
const RESERVED_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "PI_CODING_AGENT_DIR",
  "PI_OFFLINE",
  "SSL_CERT_FILE",
  // #930: the canary-only bun escape hatch. A credential var must never be
  // able to smuggle it into a real child (dispatch-runner refuses it again
  // at spawn — this is the earlier of the two fences).
  "BUN_BE_BUN",
];

/**
 * The COMPLETE child environment. On Linux this becomes `--clearenv`/`--setenv`
 * pairs in the bwrap argv (OS-enforced). On macOS `sandbox-exec` does not
 * scope the environment, so the dispatcher MUST pass exactly this map as the
 * spawn env and inherit nothing — macOS has no `/proc/self/environ`, so the
 * self-read leak the Linux `--clearenv` closes does not exist there, but a
 * broker secret inherited into the child is still visible to same-uid probes.
 */
export function buildChildEnv(
  spec: SandboxSpec,
  credential: ChildCredential | null,
): Record<string, string> {
  validateSandboxSpec(spec);
  if (credential !== null) {
    if (!CREDENTIAL_ENV_VAR_RE.test(credential.envVar)) {
      throw new SandboxSpecError("credential env var name is invalid", "path-unrepresentable");
    }
    if (RESERVED_ENV_KEYS.includes(credential.envVar)) {
      throw new SandboxSpecError(
        `credential env var ${credential.envVar} collides with a reserved allowlist key`,
        "reserved-env-var",
      );
    }
  }
  const scratch = spec.scratchDir;
  const env: Record<string, string> = {
    // Only toolBinDir is bound into the namespace (see buildBwrapArgs), so PATH
    // names exactly it — /usr/bin and /bin are deliberately absent. The child
    // binary and rg/fd are invoked by absolute path, so PATH is not load-bearing
    // for them; it exists only so a PATH lookup resolves to nothing off-limits.
    PATH: spec.toolBinDir ?? "",
    HOME: path.join(scratch, "home"),
    TMPDIR: path.join(scratch, "tmp"),
    // pi >= 0.82.0 honors this for crash/debug logs too, keeping every child
    // write inside scratch. The dir the child sees here is scratch-owned and
    // empty — it carries no operator settings, auth, or extensions.
    PI_CODING_AGENT_DIR: path.join(scratch, "agent"),
    // Never download rg/fd (or anything) at runtime.
    PI_OFFLINE: "1",
  };
  if (spec.platform === "linux" && spec.caBundlePath !== undefined) {
    env.SSL_CERT_FILE = spec.caBundlePath;
  }
  if (credential !== null) {
    env[credential.envVar] = credential.value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Canary verification plan.
// ---------------------------------------------------------------------------

export interface CanaryPlan {
  /** Reads that MUST fail under the wrapper (operator-readable outside scope). */
  mustFailReads: string[];
  /** Reads that MUST succeed (in-scope package content). */
  mustSucceedReads: string[];
  /** Writes that MUST fail (outside scratch). */
  mustFailWrites: string[];
  /** Writes that MUST succeed (inside scratch). */
  mustSucceedWrites: string[];
  /**
   * `host:port` the confined child MUST reach with a completed TLS handshake,
   * or null. #930 must perform a real handshake, not a bare TCP connect: a
   * connect exercises only DNS + socket egress, while an over-tight
   * `mach-lookup` scope breaks the Mach-IPC trust-evaluation path a connect
   * would not catch. A completed handshake turns that into a fail-closed
   * dispatch refusal rather than a child that silently cannot reach its
   * provider.
   */
  mustReachTcp: string | null;
}

/**
 * The empirical probe ADR-0130 requires before every dispatch. `outOfScopeFile`
 * must be a file the INVOKING USER can read (a broker-created canary), so an
 * unconfined control run succeeds and only the sandbox can explain a failure.
 *
 * Every entry in `SENSITIVE_AGENT_SUBPATHS` is probed as a must-fail read, not
 * only auth.json: a future profile edit that over-allows a path other than
 * auth.json would otherwise pass the canary silently, undercutting the
 * "verified before every dispatch" guarantee.
 */
export function buildCanaryPlan(
  spec: SandboxSpec,
  probes: { inScopeFile: string; outOfScopeFile: string; providerHostPort?: string | null },
): CanaryPlan {
  validateSandboxSpec(spec);
  assertRepresentablePath(probes.inScopeFile, "inScopeFile");
  assertRepresentablePath(probes.outOfScopeFile, "outOfScopeFile");
  if (!isStrictlyUnder(probes.inScopeFile, spec.packageRoot)) {
    throw new SandboxSpecError("inScopeFile must be under packageRoot", "path-unrepresentable");
  }
  if (
    isStrictlyUnder(probes.outOfScopeFile, spec.packageRoot) ||
    isStrictlyUnder(probes.outOfScopeFile, spec.scratchDir)
  ) {
    throw new SandboxSpecError("outOfScopeFile must be outside scope", "path-unrepresentable");
  }
  const sensitiveReads = SENSITIVE_AGENT_SUBPATHS.map((s) => path.join(spec.agentDir, s));
  return {
    // The package's masked .git is probed as a must-fail read (#930,
    // ADR-0131 Decision 2) so the mask is verified empirically, not assumed.
    mustFailReads: [
      probes.outOfScopeFile,
      ...sensitiveReads,
      path.join(spec.packageRoot, ".git", "config"),
    ],
    mustSucceedReads: [probes.inScopeFile],
    // A write inside the read-only package root AND a write to a sibling of
    // the out-of-scope canary: prove denial both inside a bound-but-ro tree
    // and outside every bound tree.
    mustFailWrites: [
      path.join(spec.packageRoot, ".canary-write-denied"),
      path.join(path.dirname(probes.outOfScopeFile), ".canary-write-denied"),
    ],
    mustSucceedWrites: [path.join(spec.scratchDir, ".canary-write-allowed")],
    mustReachTcp: probes.providerHostPort ?? null,
  };
}
