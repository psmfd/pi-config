/**
 * review-snapshot.ts — immutable review snapshot + proposal digest (#916).
 *
 * The snapshot is derived from package bytes and trusted broker policy,
 * never from unverified package provenance claims. Its digest (under the
 * review-draft domain) is REVIEW EVIDENCE, not authorization: the snapshot
 * enumerates the provenance it explicitly does not resolve, and the digest
 * domain is distinct from any active-grant domain (#917).
 */

import {
  REVIEW_DRAFT_DIGEST_DOMAIN,
  REVIEW_DRAFT_SCHEMA_VERSION,
  UNRESOLVED_PROVENANCE_FIELDS,
  type ReviewSnapshot,
} from "../../shared/package-agent-review-contract.ts";
import {
  canonicalDigest,
  type CanonicalValue,
} from "../../shared/package-agent-canonical.ts";
import type { DiscoveredProposal } from "./discovery.ts";

/** Build the immutable snapshot for one proposal + operator alias choice. */
export function buildReviewSnapshot(
  proposal: DiscoveredProposal,
  proposedAlias: string | null,
): ReviewSnapshot {
  const d = proposal.descriptor;
  return Object.freeze({
    schemaVersion: REVIEW_DRAFT_SCHEMA_VERSION,
    digestDomain: REVIEW_DRAFT_DIGEST_DOMAIN,
    qualifiedId: proposal.qualifiedId,
    packageIdentity: { ...proposal.packageIdentity },
    agentName: d.name,
    proposedAlias,
    descriptorText: proposal.descriptorText,
    descriptorEvidence: { ...proposal.descriptorEvidence },
    wrapperText: proposal.wrapperText,
    wrapperEvidence: proposal.wrapperEvidence ? { ...proposal.wrapperEvidence } : null,
    promptText: d.prompt,
    requestedTools: [...d.tools],
    environmentPolicy: { ...d.environment },
    modelPolicy: d.model,
    guardPolicy: d.guardProfile,
    contextPolicy: d.contextPolicy,
    unresolvedProvenance: UNRESOLVED_PROVENANCE_FIELDS,
  });
}

/**
 * Canonical value for the snapshot. Every field is explicitly mapped — a new
 * snapshot field must be added here (and to the tests asserting that every
 * field mutation changes the digest) or canonicalization fails loudly.
 */
export function snapshotCanonicalValue(s: ReviewSnapshot): CanonicalValue {
  return {
    schemaVersion: s.schemaVersion,
    digestDomain: s.digestDomain,
    qualifiedId: s.qualifiedId,
    packageIdentity: {
      source: s.packageIdentity.source,
      host: s.packageIdentity.host,
      path: s.packageIdentity.path,
      ref: s.packageIdentity.ref,
      observedCommit: s.packageIdentity.observedCommit,
    },
    agentName: s.agentName,
    proposedAlias: s.proposedAlias,
    descriptorText: s.descriptorText,
    descriptorEvidence: {
      relPath: s.descriptorEvidence.relPath,
      byteLength: s.descriptorEvidence.byteLength,
      sha256: s.descriptorEvidence.sha256,
    },
    wrapperText: s.wrapperText,
    wrapperEvidence: s.wrapperEvidence
      ? {
          relPath: s.wrapperEvidence.relPath,
          byteLength: s.wrapperEvidence.byteLength,
          sha256: s.wrapperEvidence.sha256,
        }
      : null,
    promptText: s.promptText,
    requestedTools: [...s.requestedTools],
    environmentPolicy: { ...s.environmentPolicy },
    modelPolicy: s.modelPolicy,
    guardPolicy: s.guardPolicy,
    contextPolicy: s.contextPolicy,
    unresolvedProvenance: [...s.unresolvedProvenance],
  };
}

/** sha256 hex proposal digest under the review-draft domain. */
export function computeProposalDigest(s: ReviewSnapshot): string {
  return canonicalDigest(REVIEW_DRAFT_DIGEST_DOMAIN, snapshotCanonicalValue(s));
}

/**
 * Byte-exact equality of two snapshots (used by the display-to-commit CAS:
 * sources are re-read and re-snapshotted; any changed byte aborts).
 */
export function snapshotsEqual(a: ReviewSnapshot, b: ReviewSnapshot): boolean {
  return computeProposalDigest(a) === computeProposalDigest(b);
}
