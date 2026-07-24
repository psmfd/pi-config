/**
 * worktree/lib/config.ts — settings layer for the worktree extension.
 *
 * User layer: `~/.pi/agent/settings.json` → `extensionSettings.worktree.*`
 * (ADR-0019 namespace convention). Project layer: `<cwd>/.pi/settings.json`,
 * same key, restricted to PROJECT_KEYS and applied ONLY when the project is
 * trusted (`ctx.isProjectTrusted()`).
 *
 * Trust boundary (ADR-0019 § Threat Model): the project layer is
 * attacker-controlled the moment a user cds into a cloned repository.
 * `postCreate` executes an arbitrary command and `linkFiles` creates symlinks
 * into the fresh worktree — both are gated on project trust, and `linkFiles`
 * entries are additionally constrained to relative paths inside the repo.
 * `enabled` / `reportOnly` / `snapshotIntervalMs` are user-layer only: a
 * hostile repo must not be able to switch isolation or durability off.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface WorktreeSettings {
  /** Master switch. Default true — deterministic-when-installed (ADR-0120). */
  enabled: boolean;
  /** Log-only mode: never deny, never mutate; notify what would have happened. */
  reportOnly: boolean;
  /** Explicit base ref for new worktree branches; null → auto-detect. */
  baseRef: string | null;
  /** WIP-snapshot timer fallback cadence (ms). */
  snapshotIntervalMs: number;
  /** Globs (lib/glob.ts semantics) where primary-checkout writes stay allowed. */
  writeExemptions: string[];
  /** Command run in the fresh worktree after creation (project layer, trust-gated). */
  postCreate: string | null;
  /** Repo-relative files symlinked primary → worktree (project layer, trust-gated). */
  linkFiles: string[];
}

export const DEFAULT_SETTINGS: WorktreeSettings = {
  enabled: true,
  reportOnly: false,
  baseRef: null,
  snapshotIntervalMs: 5 * 60 * 1000,
  writeExemptions: ["NEXT_SESSION*.md", ".review/**"],
  postCreate: null,
  linkFiles: [],
};

/** Keys the project layer may set (applied only when the project is trusted). */
const PROJECT_KEYS = ["baseRef", "postCreate", "linkFiles", "writeExemptions"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readWorktreeBlock(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const ext = parsed["extensionSettings"];
  if (!isRecord(ext)) return null;
  const block = ext["worktree"];
  return isRecord(block) ? block : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

function applyBlock(
  target: WorktreeSettings,
  block: Record<string, unknown>,
  allowedKeys: readonly string[] | null,
): void {
  const allowed = (key: string): boolean => allowedKeys === null || allowedKeys.includes(key);
  if (allowed("enabled") && typeof block["enabled"] === "boolean") target.enabled = block["enabled"];
  if (allowed("reportOnly") && typeof block["reportOnly"] === "boolean") {
    target.reportOnly = block["reportOnly"];
  }
  if (allowed("baseRef")) {
    if (typeof block["baseRef"] === "string" && block["baseRef"].length > 0) {
      target.baseRef = block["baseRef"];
    } else if (block["baseRef"] === null) {
      target.baseRef = null;
    }
  }
  if (
    allowed("snapshotIntervalMs") &&
    typeof block["snapshotIntervalMs"] === "number" &&
    Number.isFinite(block["snapshotIntervalMs"]) &&
    block["snapshotIntervalMs"] >= 15_000
  ) {
    target.snapshotIntervalMs = block["snapshotIntervalMs"];
  }
  if (allowed("writeExemptions")) {
    const arr = stringArray(block["writeExemptions"]);
    if (arr !== null) target.writeExemptions = arr;
  }
  if (allowed("postCreate") && typeof block["postCreate"] === "string" && block["postCreate"].length > 0) {
    target.postCreate = block["postCreate"];
  }
  if (allowed("linkFiles")) {
    const arr = stringArray(block["linkFiles"]);
    if (arr !== null) {
      // Constrain to relative, inside-repo paths — a hostile (but trusted)
      // config must not be able to point linkFiles at ~/.ssh or an absolute
      // path outside the checkout.
      target.linkFiles = arr.filter((p) => !isAbsolute(p) && !p.split("/").includes(".."));
    }
  }
}

export interface LoadSettingsOptions {
  /** Injectable for tests; default `~/.pi/agent`. */
  agentDir?: string;
  /** Result of `ctx.isProjectTrusted()`; gates the whole project layer. */
  projectTrusted: boolean;
}

export async function loadSettings(cwd: string, opts: LoadSettingsOptions): Promise<WorktreeSettings> {
  const settings: WorktreeSettings = {
    ...DEFAULT_SETTINGS,
    writeExemptions: [...DEFAULT_SETTINGS.writeExemptions],
    linkFiles: [...DEFAULT_SETTINGS.linkFiles],
  };
  const agentDir = opts.agentDir ?? join(homedir(), ".pi", "agent");
  const userBlock = await readWorktreeBlock(join(agentDir, "settings.json"));
  if (userBlock) applyBlock(settings, userBlock, null);
  if (opts.projectTrusted) {
    const projectBlock = await readWorktreeBlock(join(cwd, ".pi", "settings.json"));
    if (projectBlock) applyBlock(settings, projectBlock, PROJECT_KEYS);
  }
  return settings;
}
