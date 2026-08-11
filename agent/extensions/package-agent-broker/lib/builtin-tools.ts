/**
 * builtin-tools.ts — the reviewed built-in tool allowlist for package agents
 * (#928, ADR-0127 §6).
 *
 * A package agent must declare a finite tool allowlist; an omitted or
 * unrestricted surface is invalid (#916's descriptor validation already
 * refuses an empty `tools` array). This module answers the separate question
 * the grant needs: which declared names may become EFFECTIVE tools in an
 * isolated child.
 *
 * Two refusal classes, both fail-closed:
 *
 *   1. Not a pi built-in. A package-agent child is spawned with extension
 *      discovery disabled and no explicit `-e`, so no extension-registered
 *      tool (`web_fetch`, `git_read`, `github_read`, …) can exist in it.
 *      Granting a name that cannot exist would bind a tool allowlist that
 *      does not describe the child, and #930's startup attestation — which
 *      requires the effective tool set to match the grant exactly — would
 *      fail closed at dispatch instead of here, where the operator can see
 *      why.
 *
 *   2. A mutating built-in. `bash`, `write`, and `edit` are refused for
 *      package agents in this version. The reason is specific rather than
 *      general caution: the guard extensions that constrain those tools in a
 *      normal session (`secrets-guard`, `bash-destructive-guard`,
 *      `gh-identity-guard`) are themselves extensions, so the same isolation
 *      that makes the closure empty also means an isolated child would run
 *      those tools UNGUARDED. Refusing them keeps the grant's blast radius
 *      inside what the isolation actually delivers.
 *
 *      Lifting this requires loading the guards into the child as an explicit
 *      closure — which is a real design change (a non-empty extension and
 *      transitive module closure, both content-addressed), not a list edit.
 *      Changing this list is a policy change and must bump
 *      `GRANT_POLICY_VERSION`, which invalidates existing grants by digest.
 *
 * This is a static, reviewed list for the same reason `PROTECTED_NAMES` is:
 * deriving it from live runtime state would make the refusal surface depend
 * on mutable state at approval time.
 *
 * CONFINEMENT REQUIREMENT — resolved by #934 / ADR-0130.
 *
 * Refusing the mutating built-ins bounds what a package agent can CHANGE; it
 * does not bound what one can READ (pi's file built-ins run in-process with
 * the operator's full permissions, per ADR-0129 citing ADR-0097, and pi ships
 * no path scoping by design). ADR-0130 closes this at the OS boundary: the
 * grantable file built-ins below are dispatchable ONLY inside a verified
 * per-child filesystem sandbox (`bwrap` on Linux, deny-default `sandbox-exec`
 * on macOS) confining the child's whole process tree — including the `rg`/`fd`
 * subprocesses `grep`/`find` spawn — to the package install root (read-only)
 * plus a scratch dir, with `~/.pi/agent` (auth.json, sessions) never visible
 * and no runtime tool downloads (`PI_OFFLINE=1`, pre-provisioned binaries).
 *
 * The sandbox artifacts are built by `lib/child-sandbox.ts` (pure builders)
 * and executed by `lib/dispatch-runner.ts`; the #930 dispatch transaction
 * (`lib/dispatch.ts`) runs the canary verification plan through the
 * identical wrapper before every dispatch and REFUSES dispatch of any grant
 * containing a file built-in when confinement cannot be verified —
 * unconfined file-tool dispatch is never a fallback (ADR-0130's fail
 * posture). Confinement is resource containment applied at spawn, never an
 * authorization input: it does not appear in the grant digest, but the
 * policy-semantics changes are why `GRANT_POLICY_VERSION` moved to 2 and
 * then 3 (full-tree digest, ADR-0131 D1).
 */

/** Built-in tools a package agent may be granted. */
export const GRANTABLE_BUILTIN_TOOLS: readonly string[] = [
  "find",
  "grep",
  "ls",
  "read",
];

/**
 * Built-in tools that exist but are refused for package agents, with the
 * reason surfaced to the operator. Kept separate from "unknown name" so the
 * refusal message can say *why* rather than implying a typo.
 */
export const REFUSED_BUILTIN_TOOLS: Readonly<Record<string, string>> = {
  bash: "mutating built-in; guard extensions do not load in an isolated child",
  edit: "mutating built-in; guard extensions do not load in an isolated child",
  write: "mutating built-in; guard extensions do not load in an isolated child",
};

export class ToolPolicyError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
  ) {
    super(message);
    this.name = "ToolPolicyError";
  }
}

/**
 * Verify every requested tool may become an effective tool. Throws on the
 * first refusal; refusals are total and are never resolved by dropping the
 * offending name (a silently narrowed allowlist is not what the operator
 * reviewed).
 */
export function assertGrantableTools(requested: readonly string[]): void {
  for (const name of requested) {
    const refusal = REFUSED_BUILTIN_TOOLS[name];
    if (refusal !== undefined) {
      throw new ToolPolicyError(`tool ${name} is refused for package agents (${refusal})`, name);
    }
    if (!GRANTABLE_BUILTIN_TOOLS.includes(name)) {
      throw new ToolPolicyError(
        `tool ${name} is not a grantable pi built-in (an isolated child loads no extensions)`,
        name,
      );
    }
  }
}
