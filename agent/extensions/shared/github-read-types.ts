export type GithubDomain =
  | "repository"
  | "issues"
  | "pull_requests"
  | "actions"
  | "projects"
  | "security"
  | "notifications";

export interface GithubReadParams {
  readonly operation: string;
  readonly repository?: string;
  readonly number?: number;
  readonly projectNumber?: number;
  readonly state?: "open" | "closed" | "all" | "dismissed" | "fixed" | "auto_dismissed" | "resolved";
  readonly query?: string;
  readonly ref?: string;
  readonly limit?: number;
  readonly page?: number;
  readonly includeBody?: boolean;
  readonly threadId?: string;
}

export type FieldSpec = readonly (string | readonly [string, FieldSpec])[];

export interface OperationPlan {
  readonly args: readonly string[];
  readonly format: "json" | "text";
  readonly fields?: FieldSpec;
  readonly containsUntrustedContent: boolean;
  readonly timeoutMs?: number;
}

export interface GhRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly authSource: "GH_TOKEN" | "GITHUB_TOKEN" | "gh-config";
}

export interface GithubResultMetadata {
  readonly operation: string;
  readonly domain: GithubDomain;
  readonly authenticatedAs: string;
  readonly host: "github.com";
  readonly repository?: string;
  readonly authSource: GhRunResult["authSource"];
  readonly truncated: boolean;
}
