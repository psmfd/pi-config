/**
 * package-agent-canonical.ts — deterministic, domain-separated canonical
 * encoding for package-agent records (#916, ADR-0128).
 *
 * Design requirements (from the reviewed #916 plan):
 *   - versioned, length-delimited domain prefix (digest domain separation);
 *   - exact UTF-8 behavior (unpaired surrogates are refused, never replaced);
 *   - strict ASCII identities are validated by callers, not here;
 *   - duplicate and unknown keys are structurally impossible (maps encode
 *     sorted, duplicate keys are refused);
 *   - null/absence semantics: null is an explicit tagged value; absent keys
 *     are simply not encoded (callers decide which fields exist);
 *   - integers: safe integers only, decimal ASCII, no floats;
 *   - deterministic array ordering is the caller's contract; maps sort by
 *     key bytes here;
 *   - length-delimited raw bytes;
 *   - strict depth/size bounds.
 *
 * The encoding is injective on the value domain it accepts: every tag is
 * length- or count-delimited, so no two distinct values share an encoding.
 *
 * Shared so #917 can reuse the primitive under its own (distinct) digest
 * domain; the domain string is part of the digest input, so records from
 * different domains can never collide.
 */

import { createHash } from "node:crypto";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export const CANONICAL_MAX_DEPTH = 16;
export const CANONICAL_MAX_BYTES = 16 * 1024 * 1024;

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

function utf8Strict(s: string): Buffer {
  // Refuse unpaired surrogates: Buffer.from would emit U+FFFD replacements,
  // which silently merges distinct inputs — a canonicalization hazard.
  // (Manual scan: String.prototype.isWellFormed needs lib ES2024; the
  // extension tsconfigs target ES2022.)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalError("string is not well-formed UTF-16 (unpaired surrogate)");
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonicalError("string is not well-formed UTF-16 (unpaired surrogate)");
    }
  }
  return Buffer.from(s, "utf8");
}

function encodeInto(chunks: Buffer[], value: CanonicalValue, depth: number, budget: { left: number }): void {
  if (depth > CANONICAL_MAX_DEPTH) {
    throw new CanonicalError(`nesting depth exceeds ${CANONICAL_MAX_DEPTH}`);
  }
  const push = (b: Buffer): void => {
    budget.left -= b.length;
    if (budget.left < 0) {
      throw new CanonicalError(`encoded size exceeds ${CANONICAL_MAX_BYTES} bytes`);
    }
    chunks.push(b);
  };

  if (value === null) {
    push(Buffer.from("N"));
    return;
  }
  if (typeof value === "boolean") {
    push(Buffer.from(value ? "T" : "F"));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalError("only safe integers are encodable (no floats)");
    }
    // Normalize negative zero so 0 and -0 share one encoding.
    const n = value === 0 ? 0 : value;
    push(Buffer.from(`I${n};`));
    return;
  }
  if (typeof value === "string") {
    const b = utf8Strict(value);
    push(Buffer.from(`S${b.length}:`));
    push(b);
    return;
  }
  if (value instanceof Uint8Array) {
    const b = Buffer.from(value);
    push(Buffer.from(`B${b.length}:`));
    push(b);
    return;
  }
  if (Array.isArray(value)) {
    push(Buffer.from(`A${value.length}:`));
    for (const item of value) {
      encodeInto(chunks, item, depth + 1, budget);
    }
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const keyBufs = keys.map((k) => ({ key: k, bytes: utf8Strict(k) }));
    keyBufs.sort((a, b) => Buffer.compare(a.bytes, b.bytes));
    for (let i = 1; i < keyBufs.length; i++) {
      if (Buffer.compare(keyBufs[i - 1].bytes, keyBufs[i].bytes) === 0) {
        throw new CanonicalError("duplicate map key");
      }
    }
    push(Buffer.from(`M${keyBufs.length}:`));
    for (const { key, bytes } of keyBufs) {
      push(Buffer.from(`S${bytes.length}:`));
      push(bytes);
      encodeInto(chunks, (value as { [key: string]: CanonicalValue })[key], depth + 1, budget);
    }
    return;
  }
  throw new CanonicalError(`unencodable value type: ${typeof value}`);
}

/**
 * Encode `value` under `domain`. The domain is length-delimited into the
 * output first, so encodings under different domains never collide.
 */
export function canonicalEncode(domain: string, value: CanonicalValue): Buffer {
  if (domain.length === 0) {
    throw new CanonicalError("digest domain must be non-empty");
  }
  const chunks: Buffer[] = [];
  const budget = { left: CANONICAL_MAX_BYTES };
  const domainBytes = utf8Strict(domain);
  chunks.push(Buffer.from(`D${domainBytes.length}:`));
  chunks.push(domainBytes);
  budget.left -= chunks[0].length + domainBytes.length;
  encodeInto(chunks, value, 0, budget);
  return Buffer.concat(chunks);
}

/** sha256 hex over the canonical encoding of `value` under `domain`. */
export function canonicalDigest(domain: string, value: CanonicalValue): string {
  return createHash("sha256").update(canonicalEncode(domain, value)).digest("hex");
}
