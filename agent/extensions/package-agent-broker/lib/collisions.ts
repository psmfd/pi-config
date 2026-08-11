/**
 * collisions.ts — identity/alias collision refusal (#916, extended by #928).
 *
 * Collisions are refused, never resolved by load order. Case-normalization
 * collisions are treated as collisions (two names that fold to the same
 * lowercase form are the same name for refusal purposes), so a confusable
 * pair can never coexist.
 *
 * #928 adds the PACKAGE-IDENTITY collision (ADR-0127 §6, restated in
 * ADR-0129): approving a different ref of the same package and agent is a
 * distinct qualified identity, so it does not retire the older grant. Left
 * unchecked that would leave two independently dispatchable grants for what
 * an operator reads as one agent, so the approval is refused until the older
 * grant is revoked.
 */

import {
  ALIAS_RE,
  isPrintableAscii,
} from "../../shared/package-agent-review-contract.ts";
import type { DiscoveredProposal } from "./discovery.ts";

export class CollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollisionError";
  }
}

/**
 * First-party agent names the broker refuses to shadow. Kept as a static,
 * reviewed list (reading the live catalog at review time would make the
 * refusal surface depend on mutable runtime state). Must cover every wrapper
 * in `agent/agents/` plus the built-in subagent types; adding an agent to
 * the catalog requires a matching row here (doc-sync pair — see README).
 */
export const PROTECTED_NAMES: readonly string[] = [
  // built-in / orchestration types
  "general-purpose",
  "research-specialist",
  // agent/agents/ wrappers (complete as of ADR-0128)
  "ansible-expert",
  "aws-expert",
  "azure-devops-expert",
  "azure-infra-expert",
  "checkmarx-expert",
  "code-review-expert",
  "docker-expert",
  "docs-expert",
  "dotnet-expert",
  "gh-cli-expert",
  "gitflow-expert",
  "helm-expert",
  "hyperv-expert",
  "linter",
  "pi-agent-expert",
  "security-review-expert",
  "shell-expert",
  "tauri-expert",
  "vcluster-expert",
  "work-item-management-expert",
  "wsl2-expert",
];

function fold(name: string): string {
  return name.toLowerCase();
}

/**
 * Verify `proposal` does not collide with protected names, other discovered
 * proposals, or existing draft names/aliases. Throws CollisionError.
 *
 * @param proposal        the proposal under review
 * @param allProposals    every proposal discovered in this pass
 * @param existingAliases aliases already recorded in drafts (qualifiedId -> alias)
 * @param proposedAlias   operator-proposed alias for this review, or null
 */
export function checkCollisions(
  proposal: DiscoveredProposal,
  allProposals: readonly DiscoveredProposal[],
  existingAliases: ReadonlyMap<string, string>,
  proposedAlias: string | null,
): void {
  const name = proposal.descriptor.name;

  if (PROTECTED_NAMES.some((p) => fold(p) === fold(name))) {
    throw new CollisionError(`agent name collides with protected name: ${name}`);
  }

  for (const other of allProposals) {
    if (other.qualifiedId === proposal.qualifiedId) continue;
    if (fold(other.descriptor.name) === fold(name)) {
      throw new CollisionError(
        `agent name collides across packages: ${name} (also in ${other.packageIdentity.source})`,
      );
    }
  }

  if (proposedAlias !== null) {
    if (!isPrintableAscii(proposedAlias) || !ALIAS_RE.test(proposedAlias)) {
      throw new CollisionError("proposed alias is not a valid alias");
    }
    if (PROTECTED_NAMES.some((p) => fold(p) === fold(proposedAlias))) {
      throw new CollisionError(`alias collides with protected name: ${proposedAlias}`);
    }
    for (const other of allProposals) {
      if (other.qualifiedId === proposal.qualifiedId) continue;
      if (fold(other.descriptor.name) === fold(proposedAlias)) {
        throw new CollisionError(`alias collides with another proposal's agent name: ${proposedAlias}`);
      }
    }
    for (const [otherId, alias] of existingAliases) {
      if (otherId === proposal.qualifiedId) continue;
      if (fold(alias) === fold(proposedAlias)) {
        throw new CollisionError(`alias collides with an existing draft alias: ${proposedAlias}`);
      }
    }
  }
}

/** The identity of an agent that currently holds an active grant (#928). */
export interface GrantIdentity {
  qualifiedId: string;
  host: string;
  path: string;
  ref: string;
  agentName: string;
}

/**
 * Return the held grant that collides with `candidate` on package identity,
 * or null.
 *
 * A collision is: same package, same agent, DIFFERENT pinned ref. Re-approving
 * the SAME qualified identity is not a collision — that is the re-approval
 * path, which atomically retires the prior grant so the two are never
 * simultaneously resolvable (ADR-0129, "Re-approval while a grant is live").
 * Only a ref change produces two coexisting grants, and that is what this
 * refuses.
 *
 * Host, path, and agent name are all compared case-folded. Path case matters:
 * repository paths are case-insensitive on the platforms these packages come
 * from, so `psmfd/Pi-Client` and `psmfd/pi-client` are the same package, and
 * an exact comparison would let a re-cased path slip past the very refusal
 * this function exists to make total.
 */
export function packageIdentityConflict(
  candidate: GrantIdentity,
  held: readonly GrantIdentity[],
): GrantIdentity | null {
  for (const grant of held) {
    if (grant.qualifiedId === candidate.qualifiedId) continue;
    if (
      fold(grant.host) === fold(candidate.host) &&
      fold(grant.path) === fold(candidate.path) &&
      fold(grant.agentName) === fold(candidate.agentName)
    ) {
      return grant;
    }
  }
  return null;
}

/**
 * Throwing form of `packageIdentityConflict` for a discovered proposal.
 *
 * This is the early, operator-facing check. It is NOT the enforcement point:
 * `GrantRegistry.install` re-checks the same condition at the moment authority
 * is created, so a caller that forgets this cannot create a colliding grant.
 */
export function checkPackageIdentityCollision(
  proposal: DiscoveredProposal,
  activeGrants: readonly GrantIdentity[],
): void {
  const conflict = packageIdentityConflict(
    {
      qualifiedId: proposal.qualifiedId,
      host: proposal.packageIdentity.host,
      path: proposal.packageIdentity.path,
      ref: proposal.packageIdentity.ref,
      agentName: proposal.descriptor.name,
    },
    activeGrants,
  );
  if (conflict !== null) {
    throw new CollisionError(
      `an active grant already exists for this package agent at ref ${conflict.ref}; ` +
        `revoke it before approving ref ${proposal.packageIdentity.ref}`,
    );
  }
}
