import { buildActionsPlan, ACTIONS_OPERATIONS } from "./github-read-op-actions.ts";
import { buildIssuePlan, ISSUE_OPERATIONS } from "./github-read-op-issues.ts";
import { buildNotificationPlan, NOTIFICATION_OPERATIONS } from "./github-read-op-notifications.ts";
import { buildProjectPlan, PROJECT_OPERATIONS } from "./github-read-op-projects.ts";
import { buildPullRequestPlan, PULL_REQUEST_OPERATIONS } from "./github-read-op-pull-requests.ts";
import { buildRepositoryPlan, REPOSITORY_OPERATIONS } from "./github-read-op-repository.ts";
import { buildSecurityPlan, SECURITY_OPERATIONS } from "./github-read-op-security.ts";
import type { GithubDomain, GithubReadParams, OperationPlan } from "./github-read-types.ts";

export const DOMAIN_TOOL_NAMES: Readonly<Record<GithubDomain, string>> = {
  repository: "github_repo_read",
  issues: "github_issue_read",
  pull_requests: "github_pr_read",
  actions: "github_actions_read",
  projects: "github_project_read",
  security: "github_security_read",
  notifications: "github_notification_read",
};

export const DOMAIN_OPERATIONS: Readonly<Record<GithubDomain, readonly string[]>> = {
  repository: REPOSITORY_OPERATIONS,
  issues: ISSUE_OPERATIONS,
  pull_requests: PULL_REQUEST_OPERATIONS,
  actions: ACTIONS_OPERATIONS,
  projects: PROJECT_OPERATIONS,
  security: SECURITY_OPERATIONS,
  notifications: NOTIFICATION_OPERATIONS,
};

export function buildOperationPlan(domain: GithubDomain, params: GithubReadParams): OperationPlan {
  switch (domain) {
    case "repository": return buildRepositoryPlan(params);
    case "issues": return buildIssuePlan(params);
    case "pull_requests": return buildPullRequestPlan(params);
    case "actions": return buildActionsPlan(params);
    case "projects": return buildProjectPlan(params);
    case "security": return buildSecurityPlan(params);
    case "notifications": return buildNotificationPlan(params);
  }
}

const API_BODY_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

const SAFE_PREFIXES: readonly (readonly string[])[] = [
  ["api", "--hostname", "github.com", "--method", "GET"],
  ["repo", "view"],
  ["release", "list"],
  ["issue", "list"],
  ["issue", "view"],
  ["pr", "list"],
  ["pr", "view"],
  ["pr", "diff"],
  ["pr", "checks"],
  ["project", "list"],
  ["project", "view"],
  ["project", "field-list"],
  ["project", "item-list"],
];

export function assertReadOnlyPlan(plan: OperationPlan): void {
  if (!SAFE_PREFIXES.some((prefix) => prefix.every((part, index) => plan.args[index] === part))) {
    throw new Error("github-read refused an unrecognized gh command shape");
  }
  for (const arg of plan.args) {
    if (arg.includes("\u0000")) throw new Error("github-read refused a NUL byte");
  }
  if (plan.args[0] === "api") {
    if (plan.args[4] !== "GET" || plan.args.filter((arg) => arg === "--method").length !== 1) {
      throw new Error("github-read API plans must explicitly use exactly one GET method");
    }
    if (plan.args.some((arg) => API_BODY_FLAGS.has(arg))) {
      throw new Error("github-read API plans cannot contain request-body flags");
    }
  }
}
