/**
 * descriptor.ts — versioned, strict validation of package agent descriptors
 * (#916). A descriptor is inert data (`agents/<name>.json` in an installed
 * package); nothing here imports, executes, or registers anything.
 *
 * Strictness: unknown keys are refused, every field is bounded, identities
 * are strict ASCII, and the descriptor's inner `name` must match the file
 * basename (no aliasing between what a file claims and where it lives).
 */

import {
  AGENT_NAME_RE,
  BOUNDS,
  ENV_KEY_RE,
  TOOL_NAME_RE,
  isPrintableAscii,
} from "../../shared/package-agent-review-contract.ts";
import { parseStrictJson, type StrictJsonValue } from "./strict-json.ts";

export const DESCRIPTOR_SCHEMA_VERSION = 1;

export interface AgentDescriptor {
  schemaVersion: typeof DESCRIPTOR_SCHEMA_VERSION;
  name: string;
  description: string;
  /** Complete system prompt, verbatim. */
  prompt: string;
  /** Finite requested tool names, deduplicated and sorted. */
  tools: string[];
  /** Model policy string, or null. */
  model: string | null;
  /** Guard-profile string, or null. */
  guardProfile: string | null;
  /** Context policy string, or null. */
  contextPolicy: string | null;
  /** Environment policy (sorted keys). */
  environment: Record<string, string>;
}

export class DescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescriptorError";
  }
}

const KNOWN_KEYS = new Set([
  "schemaVersion",
  "name",
  "description",
  "prompt",
  "tools",
  "model",
  "guardProfile",
  "contextPolicy",
  "environment",
]);

const REQUIRED_KEYS = ["schemaVersion", "name", "description", "prompt", "tools"];

function requireString(value: StrictJsonValue, field: string, maxLen: number): string {
  if (typeof value !== "string") throw new DescriptorError(`${field} must be a string`);
  if (value.length === 0) throw new DescriptorError(`${field} must be non-empty`);
  if (value.length > maxLen) throw new DescriptorError(`${field} exceeds length bound`);
  return value;
}

function optionalBoundedString(
  obj: { [key: string]: StrictJsonValue },
  field: string,
  maxLen: number,
): string | null {
  if (!(field in obj)) return null;
  const v = obj[field];
  if (v === null) return null;
  const s = requireString(v, field, maxLen);
  if (!isPrintableAscii(s)) throw new DescriptorError(`${field} must be printable ASCII`);
  return s;
}

/**
 * Validate raw descriptor text into a typed descriptor.
 *
 * @param text          exact file contents (UTF-8 decoded)
 * @param expectedName  the file basename without `.json`; the descriptor's
 *                      `name` must equal it exactly.
 */
export function validateDescriptor(text: string, expectedName: string): AgentDescriptor {
  const parsed = parseStrictJson(text, {
    maxDepth: BOUNDS.maxJsonDepth,
    maxEntries: BOUNDS.maxJsonEntries,
    maxStringLength: BOUNDS.maxJsonStringLength,
  });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DescriptorError("descriptor must be a JSON object");
  }
  const obj = parsed;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) throw new DescriptorError(`unknown key: ${JSON.stringify(key)}`);
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) throw new DescriptorError(`missing required key: ${key}`);
  }

  if (obj.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION) {
    throw new DescriptorError("unsupported descriptor schemaVersion");
  }

  const name = requireString(obj.name, "name", 64);
  if (!AGENT_NAME_RE.test(name)) throw new DescriptorError("name is not a valid agent name");
  if (name !== expectedName) {
    throw new DescriptorError("descriptor name does not match its file basename");
  }

  const description = requireString(obj.description, "description", 1024);

  const prompt = requireString(obj.prompt, "prompt", BOUNDS.maxJsonStringLength);

  if (!Array.isArray(obj.tools)) throw new DescriptorError("tools must be an array");
  if (obj.tools.length === 0) {
    throw new DescriptorError("tools must be a non-empty finite allowlist");
  }
  if (obj.tools.length > BOUNDS.maxTools) throw new DescriptorError("tools exceeds count bound");
  const tools: string[] = [];
  const seenTools = new Set<string>();
  for (const t of obj.tools) {
    const tool = requireString(t, "tools[]", 64);
    if (!TOOL_NAME_RE.test(tool)) throw new DescriptorError(`invalid tool name: ${JSON.stringify(tool)}`);
    if (seenTools.has(tool)) throw new DescriptorError(`duplicate tool name: ${tool}`);
    seenTools.add(tool);
    tools.push(tool);
  }
  tools.sort();

  const model = optionalBoundedString(obj, "model", 128);
  const guardProfile = optionalBoundedString(obj, "guardProfile", 128);
  const contextPolicy = optionalBoundedString(obj, "contextPolicy", 128);

  const environment: Record<string, string> = {};
  if ("environment" in obj && obj.environment !== null) {
    const env = obj.environment;
    if (typeof env !== "object" || Array.isArray(env)) {
      throw new DescriptorError("environment must be an object");
    }
    const keys = Object.keys(env);
    if (keys.length > BOUNDS.maxEnvironmentEntries) {
      throw new DescriptorError("environment exceeds entry bound");
    }
    for (const key of keys.sort()) {
      if (!ENV_KEY_RE.test(key)) throw new DescriptorError(`invalid environment key: ${JSON.stringify(key)}`);
      const v = requireString(env[key], `environment.${key}`, 1024);
      if (!isPrintableAscii(v)) {
        throw new DescriptorError(`environment.${key} must be printable ASCII`);
      }
      environment[key] = v;
    }
  }

  return {
    schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
    name,
    description,
    prompt,
    tools,
    model,
    guardProfile,
    contextPolicy,
    environment,
  };
}
