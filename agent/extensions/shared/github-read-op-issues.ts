import type { FieldSpec, GithubReadParams, OperationPlan } from "./github-read-types.ts";
import { apiPath, requireFirstPage, requireNumber, resultLimit, resultPage, validateRepository, validateState, validateText } from "./github-read-validation.ts";

const LIST_FIELDS = "number,title,state,stateReason,labels,assignees,milestone,author,createdAt,updatedAt,closedAt,url,projectItems";
const VIEW_BASE_FIELDS = "number,title,state,stateReason,labels,assignees,milestone,author,createdAt,updatedAt,closedAt,url,projectItems";
const LABEL_FIELDS: FieldSpec = ["id", "name", "color", "description", "url"];
const MILESTONE_FIELDS: FieldSpec = ["id", "number", "title", "description", "state", "open_issues", "closed_issues", "created_at", "updated_at", "due_on", "closed_at", "html_url"];
const ASSIGNEE_FIELDS: FieldSpec = ["login", "id", "avatar_url", "html_url"];
const TIMELINE_FIELDS: FieldSpec = ["id", "event", "created_at", "commit_id", "commit_url", "url", "html_url", ["actor", ["login", "id", "html_url"]], "label", "assignee", "assigner", "review_requester", "requested_reviewer", "milestone", "source", "rename", "lock_reason"];

export const ISSUE_OPERATIONS = ["list", "view", "timeline", "labels", "milestones", "assignees"] as const;

export function buildIssuePlan(params: GithubReadParams): OperationPlan {
  const repository = validateRepository(params.repository);
  const limit = resultLimit(params);
  const page = resultPage(params);
  switch (params.operation) {
    case "list": {
      requireFirstPage(params, "issue list");
      const state = validateState(params.state, ["open", "closed", "all"], "issue list", "open");
      const args = ["issue", "list", "--repo", repository, "--state", state, "--limit", String(limit), "--json", LIST_FIELDS];
      const query = validateText(params.query, "query", 256);
      if (query) args.push("--search", query);
      return { args, format: "json", fields: LIST_FIELDS.split(","), containsUntrustedContent: true };
    }
    case "view": {
      requireFirstPage(params, "issue view");
      const number = requireNumber(params);
      const fields = params.includeBody ? `${VIEW_BASE_FIELDS},body,comments` : VIEW_BASE_FIELDS;
      return {
        args: ["issue", "view", String(number), "--repo", repository, "--json", fields],
        format: "json",
        fields: fields.split(","),
        containsUntrustedContent: true,
      };
    }
    case "timeline": {
      const number = requireNumber(params);
      return {
        args: ["api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github+json", apiPath(`repos/${repository}/issues/${number}/timeline`, { per_page: limit, page })],
        format: "json",
        fields: TIMELINE_FIELDS,
        containsUntrustedContent: true,
      };
    }
    case "labels":
    case "milestones":
    case "assignees": {
      const state = params.operation === "milestones"
        ? validateState(params.state, ["open", "closed", "all"], "milestones", "open")
        : undefined;
      return {
        args: ["api", "--hostname", "github.com", "--method", "GET", apiPath(`repos/${repository}/${params.operation}`, { per_page: limit, page, state })],
        format: "json",
        fields: params.operation === "labels" ? LABEL_FIELDS : params.operation === "milestones" ? MILESTONE_FIELDS : ASSIGNEE_FIELDS,
        containsUntrustedContent: true,
      };
    }
    default:
      throw new Error(`unsupported issue operation: ${params.operation}`);
  }
}
