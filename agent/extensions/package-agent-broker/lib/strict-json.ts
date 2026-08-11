/**
 * strict-json.ts — strict JSON parsing for package-agent descriptors (#916).
 *
 * Stricter than JSON.parse where strictness closes review hazards:
 *   - duplicate object keys are refused (JSON.parse keeps the last one,
 *     which lets a displayed value differ from a consumed value);
 *   - depth, entry-count, and string-length bounds are enforced;
 *   - numbers must be safe integers (no floats, no exponents) — descriptor
 *     schemas have no fractional fields, and float canonicalization is a
 *     known equivocation hazard;
 *   - results use null-prototype objects (no prototype pollution channel).
 *
 * Grammar otherwise follows RFC 8259 (whitespace, escapes, unicode escapes).
 * Input is a string the caller already byte-bounded.
 */

export type StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | StrictJsonValue[]
  | { [key: string]: StrictJsonValue };

export interface StrictJsonBounds {
  maxDepth: number;
  maxEntries: number;
  maxStringLength: number;
}

export class StrictJsonError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message} (at offset ${position})`);
    this.name = "StrictJsonError";
  }
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

export function parseStrictJson(text: string, bounds: StrictJsonBounds): StrictJsonValue {
  let pos = 0;

  const fail = (msg: string): never => {
    throw new StrictJsonError(msg, pos);
  };

  const skipWs = (): void => {
    while (pos < text.length && WS.has(text.charCodeAt(pos))) pos++;
  };

  const expect = (ch: string): void => {
    if (text[pos] !== ch) fail(`expected '${ch}'`);
    pos++;
  };

  const parseString = (): string => {
    expect('"');
    let out = "";
    for (;;) {
      if (pos >= text.length) fail("unterminated string");
      if (out.length > bounds.maxStringLength) fail("string exceeds length bound");
      const c = text[pos];
      const code = text.charCodeAt(pos);
      if (c === '"') {
        pos++;
        return out;
      }
      if (c === "\\") {
        pos++;
        const e = text[pos];
        pos++;
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = text.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape");
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            fail("invalid escape");
        }
        continue;
      }
      if (code < 0x20) fail("unescaped control character in string");
      out += c;
      pos++;
    }
  };

  const parseNumber = (): number => {
    const start = pos;
    if (text[pos] === "-") pos++;
    if (!/[0-9]/.test(text[pos] ?? "")) fail("invalid number");
    if (text[pos] === "0" && /[0-9]/.test(text[pos + 1] ?? "")) fail("leading zero");
    while (/[0-9]/.test(text[pos] ?? "")) pos++;
    if (text[pos] === "." || text[pos] === "e" || text[pos] === "E") {
      fail("non-integer numbers are not accepted");
    }
    const n = Number(text.slice(start, pos));
    if (!Number.isSafeInteger(n)) fail("integer outside safe range");
    return n;
  };

  const parseValue = (depth: number): StrictJsonValue => {
    if (depth > bounds.maxDepth) fail("nesting depth exceeds bound");
    skipWs();
    const c = text[pos];
    if (c === undefined) fail("unexpected end of input");
    if (c === "{") {
      pos++;
      const obj: { [key: string]: StrictJsonValue } = Object.create(null);
      const seen = new Set<string>();
      skipWs();
      if (text[pos] === "}") {
        pos++;
        return obj;
      }
      for (;;) {
        skipWs();
        const key = parseString();
        if (seen.has(key)) fail(`duplicate object key: ${JSON.stringify(key)}`);
        seen.add(key);
        if (seen.size > bounds.maxEntries) fail("object entry count exceeds bound");
        skipWs();
        expect(":");
        obj[key] = parseValue(depth + 1);
        skipWs();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        expect("}");
        return obj;
      }
    }
    if (c === "[") {
      pos++;
      const arr: StrictJsonValue[] = [];
      skipWs();
      if (text[pos] === "]") {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(depth + 1));
        if (arr.length > bounds.maxEntries) fail("array entry count exceeds bound");
        skipWs();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        expect("]");
        return arr;
      }
    }
    if (c === '"') return parseString();
    if (c === "-" || /[0-9]/.test(c)) return parseNumber();
    if (text.startsWith("true", pos)) { pos += 4; return true; }
    if (text.startsWith("false", pos)) { pos += 5; return false; }
    if (text.startsWith("null", pos)) { pos += 4; return null; }
    return fail("unexpected token");
  };

  const value = parseValue(0);
  skipWs();
  if (pos !== text.length) fail("trailing content after JSON value");
  return value;
}
