/**
 * worktree/lib/manifest.ts — per-session manifest index.
 *
 * One JSON file per session under
 * `~/.pi/agent/extensions/worktree/sessions/<sid>.json` — per-session files
 * rather than one shared `state.json` blob because multiple pi sessions run
 * concurrently by design here, and a shared read-modify-write blob is exactly
 * the collision this extension exists to remove (token-meter's per-session
 * JSONL precedent, ADR-0073). Writes are atomic (temp file + rename).
 *
 * The manifest is an INDEX, not the source of truth: git itself (worktree
 * list, lock reasons, refs/pi-wip/*) is authoritative, and the reconciler
 * (lib/reconcile.ts) cross-checks both.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const MANIFEST_SCHEMA_VERSION = 1;

export interface SessionManifest {
  v: number;
  sessionId: string;
  repo: string;
  worktreePath: string;
  branch: string;
  pid: number;
  host: string;
  createdAt: string;
  updatedAt: string;
  lastSnapshotSha: string | null;
}

/** Path-traversal-safe key (token-meter precedent: basename + charset clamp). */
export function safeKey(sid: string): string {
  const cleaned = basename(sid).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return cleaned.length > 0 ? cleaned : "unknown-session";
}

export function sessionsDir(agentDir?: string): string {
  const base = agentDir ?? join(homedir(), ".pi", "agent");
  return join(base, "extensions", "worktree", "sessions");
}

function manifestFile(sid: string, agentDir?: string): string {
  return join(sessionsDir(agentDir), `${safeKey(sid)}.json`);
}

export async function saveManifest(manifest: SessionManifest, agentDir?: string): Promise<void> {
  const dir = sessionsDir(agentDir);
  await fs.mkdir(dir, { recursive: true });
  const file = manifestFile(manifest.sessionId, agentDir);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

function isManifest(value: unknown): value is SessionManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["v"] === MANIFEST_SCHEMA_VERSION &&
    typeof v["sessionId"] === "string" &&
    typeof v["repo"] === "string" &&
    typeof v["worktreePath"] === "string" &&
    typeof v["branch"] === "string" &&
    typeof v["pid"] === "number"
  );
}

export async function loadManifest(sid: string, agentDir?: string): Promise<SessionManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestFile(sid, agentDir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function listManifests(agentDir?: string): Promise<SessionManifest[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir(agentDir));
  } catch {
    return [];
  }
  const manifests: SessionManifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const loaded = await loadManifest(entry.slice(0, -".json".length), agentDir);
    if (loaded) manifests.push(loaded);
  }
  return manifests;
}

export async function removeManifest(sid: string, agentDir?: string): Promise<void> {
  await fs.rm(manifestFile(sid, agentDir), { force: true }).catch(() => undefined);
}
