/**
 * expertise-client — lightweight create-body secret guard (ADR-0028, #318).
 *
 * `secrets-guard` (the global pi extension) intercepts only
 * `write`/`edit`/`artifact_review`/`bash` tool calls and is scoped to
 * disk/commit persistence; it never sees `expertise_create`. To keep an
 * accidental credential from being published into an expertise entry, this
 * module scans the create body field-by-field BEFORE any network call.
 *
 * The pattern set mirrors `secrets-guard`'s shared source of truth exactly
 * (keep in lockstep with agent/extensions/secrets-guard/index.ts and
 * hooks/secrets-guard.sh). The scan returns CATEGORY NAMES only — never the
 * matched secret text — so a refusal message cannot itself leak the value.
 *
 * Pure, no side effects.
 */

import type { CreateParams } from "./create.ts";

// Keep this in lockstep with agent/extensions/secrets-guard/index.ts.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "pem-private-key",
    re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |)PRIVATE KEY/,
  },
  {
    name: "aws-access-key",
    re: /(^|[^A-Z0-9])(AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}([^A-Z0-9]|$)/,
  },
  { name: "github-pat-classic", re: /ghp_[A-Za-z0-9]{36}/ },
  { name: "github-pat-fine-grained", re: /github_pat_[A-Za-z0-9_]{82}/ },
];

/** Collect each string field/element of the create body for scanning. */
function collectStrings(body: CreateParams): string[] {
  const out: string[] = [];
  if (typeof body.title === "string") out.push(body.title);
  if (typeof body.content === "string") out.push(body.content);
  if (typeof body.source === "string") out.push(body.source);
  if (Array.isArray(body.tags)) {
    for (const tag of body.tags) {
      if (typeof tag === "string") out.push(tag);
    }
  }
  return out;
}

/**
 * Scan a create body for credential patterns. Returns the deduplicated
 * category names of any matches (never the matched secret text). An empty
 * array means the body is clean.
 */
export function scanForSecrets(body: CreateParams): string[] {
  const fields = collectStrings(body);
  const matched = new Set<string>();
  for (const value of fields) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(value)) matched.add(name);
    }
  }
  return [...matched];
}
