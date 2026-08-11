/**
 * shared/secret-scan.ts — canonical TS secret-detection pattern set + a raw
 * string scanner, shared across extensions (ADR-0071, ADR-0088, #635).
 *
 * This is one of the three lockstep copies of the secret-detection pattern set
 * (ADR-0071): keep in lockstep with agent/extensions/secrets-guard/index.ts and
 * hooks/secrets-guard.sh. `scripts/validate.sh` §6b-bis enforces parity across
 * the three. It lives in `shared/` (not inside expertise-client) so that BOTH
 * expertise-client (`scanForSecrets`, create-body gate) and the config-mirror-
 * shipped expertise-indexer (`scanRawString`, canonicalizer pre-write gate) can
 * consume it via `../shared/` — the standalone extension mirrors inline this
 * module per ADR-0065, and the config mirror ships `shared/` intact. Moving it
 * here (ADR-0088) resolved #635, where expertise-indexer imported the pattern
 * set from the mirror-excluded expertise-client and failed to load on every
 * distributed install.
 *
 * The scan returns CATEGORY NAMES only — never the matched secret text — so a
 * refusal message cannot itself leak the value. Pure, no side effects.
 */

// Keep this in lockstep with agent/extensions/secrets-guard/index.ts and
// hooks/secrets-guard.sh (ADR-0071; framework ADR-095 for the JWT/Bearer
// detectors). validate.sh check_secret_pattern_lockstep (§6b-bis) enforces parity.
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "pem-private-key",
    // Includes the ENCRYPTED (PKCS#8) header form, in lockstep with secrets-guard.
    re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED |)PRIVATE KEY/,
  },
  {
    name: "aws-access-key",
    re: /(^|[^A-Z0-9])(AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}([^A-Z0-9]|$)/,
  },
  // All five documented GitHub token prefixes (gho/ghp/ghr/ghs/ghu), open-ended
  // body to match the longer ghs_ format — in lockstep with secrets-guard.
  { name: "github-token", re: /gh[oprsu]_[A-Za-z0-9]{36,}/ },
  { name: "github-pat-fine-grained", re: /github_pat_[A-Za-z0-9_]{82,}/ },
  // Signed JWT — header.payload.signature, each segment length-bounded (`eyJ` is
  // base64url `{"`). Signed tokens only; unsigned/alg:none is out of scope
  // (framework ADR-095 / #64). The pattern text does not match its own regex.
  {
    name: "signed-jwt",
    // Segments upper-bounded ({10,4000}) so the chained `{n,}\.` shape cannot
    // drive O(n²) backtracking on adversarial ~512KB non-dot input in the V8
    // engine; a real JWT segment is far under 4000 chars (ADR-0071).
    re: /eyJ[A-Za-z0-9_-]{10,4000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,4000}(?![A-Za-z0-9_-])/,
  },
  // Authorization: Bearer <20+ token chars>. Case-insensitive on both words; the
  // length bound keeps placeholders (`Bearer %s`, `Bearer <key>`, `Bearer $VAR`)
  // below the threshold (framework ADR-095).
  {
    name: "authorization-bearer",
    re: /[Aa]uthorization: [Bb]earer [A-Za-z0-9._~+/=-]{20,}/,
  },
];

/**
 * Scan a raw string for credential patterns. Runs the `SECRET_PATTERNS` set
 * against the entire string; returns the deduplicated category names of any
 * matches. Never returns the matched secret text — so a caller's refusal
 * message can safely echo the result. An empty array means the string is clean.
 *
 * Used by expertise-client (create-body strings) and expertise-indexer (the
 * canonicalizer pre-write gate, #598/#608).
 */
export function scanRawString(text: string): string[] {
  const matched = new Set<string>();
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) matched.add(name);
  }
  return [...matched];
}
