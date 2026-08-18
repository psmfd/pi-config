/**
 * plain-english/config.ts — user-layer settings + path eligibility.
 *
 * Settings come from the USER layer only (~/.pi/agent/settings.json →
 * extensionSettings.plainEnglish). The project layer is deliberately ignored:
 * a cloned repository must not be able to enable LLM rewriting of the
 * operator's files, steer which model receives their content, or widen the
 * include globs (same user-layer-only trust posture as token-meter/ADR-0073
 * and repo-dash/ADR-0140; recorded in ADR-0142).
 *
 * Pure except loadConfig() (fs read) — everything else unit-tests without IO.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PlainEnglishConfig {
  readonly enabled: boolean;
  /**
   * Ordered fallback chain of "provider/model-id" entries (settings key
   * `model`, accepting a string or an array, normalized here; capped at
   * MAX_MODEL_CHAIN). Empty → the session's active model. Chain order is a
   * trust/cost decision: file content egresses to each provider tried.
   */
  readonly models: readonly string[];
  readonly timeoutMs: number;
  /** Minimum masked-prose size (non-whitespace chars) before a rewrite is attempted. */
  readonly minChars: number;
  /** Documents larger than this pass through untouched (single-shot completion, no chunking). */
  readonly maxChars: number;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export const DEFAULT_INCLUDE: readonly string[] = ["**/*.md"];

/**
 * Default exclusions. `agent/**` keeps the pass away from skill/rule/prompt
 * text — instruction files are deliberate prompt content, not documentation
 * (the same scope line docs-expert SKILL.md §Plain-English Pass draws).
 * `adrs/**` because decided records are superseded, never edited.
 */
export const DEFAULT_EXCLUDE: readonly string[] = [
  "adrs/**",
  ".review/**",
  "NEXT_SESSION*",
  "agent/**",
  ".worktrees/**",
  ".wt_tmp/**",
  "node_modules/**",
];

/** Fallback-chain length cap — bounds worst-case added latency at N × timeoutMs. */
export const MAX_MODEL_CHAIN = 3;

export const DEFAULTS: PlainEnglishConfig = {
  enabled: false,
  models: [],
  timeoutMs: 30_000,
  minChars: 200,
  maxChars: 60_000,
  include: DEFAULT_INCLUDE,
  exclude: DEFAULT_EXCLUDE,
};

function asBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asBoundedInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  return n < min || n > max ? fallback : n;
}

function asStringArray(v: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((s): s is string => typeof s === "string" && s.length > 0);
  return out.length > 0 ? out : fallback;
}

const MODEL_ID_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9 ._:-]+$/;

/** Normalize the `model` setting (string | string[] | null) into a bounded chain. */
function asModelChain(v: unknown): readonly string[] {
  const raw = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
  return raw
    .filter((m): m is string => typeof m === "string" && MODEL_ID_RE.test(m))
    .slice(0, MAX_MODEL_CHAIN);
}

/** Parse the extensionSettings.plainEnglish subtree; anything malformed falls to the default. */
export function parseConfig(raw: unknown): PlainEnglishConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULTS;
  const rec = raw as Record<string, unknown>;
  return {
    enabled: asBoolean(rec.enabled, DEFAULTS.enabled),
    models: asModelChain(rec.model),
    timeoutMs: asBoundedInt(rec.timeoutMs, DEFAULTS.timeoutMs, 1_000, 300_000),
    minChars: asBoundedInt(rec.minChars, DEFAULTS.minChars, 0, 100_000),
    maxChars: asBoundedInt(rec.maxChars, DEFAULTS.maxChars, 1_000, 1_000_000),
    include: asStringArray(rec.include, DEFAULTS.include),
    exclude: asStringArray(rec.exclude, DEFAULTS.exclude),
  };
}

/** Read the USER-layer settings toggle only. Any read/parse failure → inert defaults. */
export async function loadConfig(): Promise<PlainEnglishConfig> {
  try {
    const p = join(homedir(), ".pi", "agent", "settings.json");
    const j = JSON.parse(await fs.readFile(p, "utf8")) as {
      extensionSettings?: { plainEnglish?: unknown };
    };
    return parseConfig(j?.extensionSettings?.plainEnglish);
  } catch {
    return DEFAULTS;
  }
}

/**
 * Minimal glob → RegExp. Supports `**` (any depth, including none when
 * followed by `/`), `*` (within a segment), `?` (one char in a segment).
 * Everything else is literal. Enough for the include/exclude vocabulary this
 * extension documents; not a general glob engine.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob.startsWith("**/", i)) {
        re += "(?:.*/)?";
        i += 3;
        continue;
      }
      if (glob.startsWith("**", i)) {
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(relPath: string, basename: string, globs: readonly string[]): boolean {
  return globs.some((g) => {
    const re = globToRegExp(g);
    // Basename matching lets a bare pattern like `NEXT_SESSION*` catch the
    // file at any depth without requiring authors to write `**/NEXT_SESSION*`.
    return re.test(relPath) || (!g.includes("/") && re.test(basename));
  });
}

/**
 * Eligibility: a `.md` file resolved INSIDE cwd whose cwd-relative path
 * matches an include glob and no exclude glob. Writes outside the working
 * tree are never rewritten.
 */
export function isEligiblePath(path: string, cwd: string, cfg: PlainEnglishConfig): boolean {
  if (!/\.md$/i.test(path)) return false;
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(resolve(cwd), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const posix = rel.split(sep).join("/");
  const base = posix.split("/").pop() ?? posix;
  if (!matchesAny(posix, base, cfg.include)) return false;
  if (matchesAny(posix, base, cfg.exclude)) return false;
  return true;
}
