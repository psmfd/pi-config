import type { GithubReadParams } from "./github-read-types.ts";

const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]*$/;

export function validateRepository(value: unknown): string {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) {
    throw new Error("repository must be an explicit owner/name on github.com");
  }
  const [, name = ""] = value.split("/", 2);
  if (name === "." || name === ".." || value.startsWith("-") || name.startsWith("-")) {
    throw new Error("repository contains a prohibited component");
  }
  return value;
}

export function repositoryOwner(repository: string): string {
  return repository.split("/", 1)[0] ?? "";
}

export function validatePositiveInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

export function resultLimit(params: GithubReadParams, maximum = 100): number {
  return params.limit === undefined
    ? Math.min(30, maximum)
    : validatePositiveInteger(params.limit, "limit", maximum);
}

export function resultPage(params: GithubReadParams): number {
  return params.page === undefined
    ? 1
    : validatePositiveInteger(params.page, "page", 1000);
}

export function requireFirstPage(params: GithubReadParams, operation: string): void {
  const page = resultPage(params);
  if (page !== 1) throw new Error(`${operation} supports page 1 only; narrow the query or use a paginated fixed operation`);
}

export function validateText(
  value: unknown,
  field: string,
  maximum: number,
  required = false,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  if (!SAFE_TEXT_RE.test(value)) {
    throw new Error(`${field} contains prohibited control characters`);
  }
  return value;
}

export function validateRef(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !REF_RE.test(value) || value.startsWith("-")) {
    throw new Error("ref contains unsupported characters");
  }
  return value;
}

export function apiPath(path: string, query: Record<string, string | number | undefined> = {}): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.includes("..")) {
    throw new Error("internal GitHub API path failed validation");
  }
  const entries = Object.entries(query).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  if (entries.length === 0) return path;
  const encoded = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${path}?${encoded}`;
}

export function validateState(
  value: GithubReadParams["state"],
  allowed: readonly string[],
  operation: string,
  fallback: string,
): string {
  const state = value ?? fallback;
  if (!allowed.includes(state)) {
    throw new Error(`${operation} state must be one of: ${allowed.join(", ")}`);
  }
  return state;
}

export function requireNumber(params: GithubReadParams): number {
  return validatePositiveInteger(params.number, "number");
}

export function requireProjectNumber(params: GithubReadParams): number {
  return validatePositiveInteger(params.projectNumber, "projectNumber");
}
