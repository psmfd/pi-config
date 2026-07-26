import type { FieldSpec, GithubReadParams, OperationPlan } from "../types.ts";
import { apiPath, requireFirstPage, requireNumber, resultLimit, resultPage, validateRepository, validateState, validateText } from "../validation.ts";

const LIST_FIELDS = "number,title,state,isDraft,author,assignees,labels,headRefName,baseRefName,createdAt,updatedAt,closedAt,mergedAt,url,reviewDecision,statusCheckRollup";
const VIEW_BASE_FIELDS = "number,title,state,isDraft,author,assignees,labels,headRefName,baseRefName,createdAt,updatedAt,closedAt,mergedAt,url,reviewDecision,statusCheckRollup,mergeable,commits";
const FILE_FIELDS: FieldSpec = ["sha", "filename", "status", "additions", "deletions", "changes", "blob_url", "raw_url", "contents_url", "patch"];
const REVIEW_METADATA_FIELDS: FieldSpec = ["id", "state", "html_url", "pull_request_url", "submitted_at", "commit_id", ["user", ["login", "id", "html_url"]]];
const COMMENT_METADATA_FIELDS: FieldSpec = ["id", "created_at", "updated_at", "html_url", "path", "line", "side", "commit_id", ["user", ["login", "id", "html_url"]]];
const CHECK_FIELDS = "name,state,bucket,link,startedAt,completedAt,workflow";

export const PULL_REQUEST_OPERATIONS = ["list", "view", "files", "diff", "reviews", "comments", "checks"] as const;

export function buildPullRequestPlan(params: GithubReadParams): OperationPlan {
  const repository = validateRepository(params.repository);
  const limit = resultLimit(params);
  const page = resultPage(params);
  switch (params.operation) {
    case "list": {
      requireFirstPage(params, "pull-request list");
      const state = validateState(params.state, ["open", "closed", "all"], "pull-request list", "open");
      const args = ["pr", "list", "--repo", repository, "--state", state, "--limit", String(limit), "--json", LIST_FIELDS];
      const query = validateText(params.query, "query", 256);
      if (query) args.push("--search", query);
      return { args, format: "json", fields: LIST_FIELDS.split(","), containsUntrustedContent: true };
    }
    case "view": {
      requireFirstPage(params, "pull-request view");
      const number = requireNumber(params);
      const fields = params.includeBody ? `${VIEW_BASE_FIELDS},body,comments,reviews` : VIEW_BASE_FIELDS;
      return {
        args: ["pr", "view", String(number), "--repo", repository, "--json", fields],
        format: "json",
        fields: fields.split(","),
        containsUntrustedContent: true,
      };
    }
    case "diff":
      requireFirstPage(params, "pull-request diff");
      return {
        args: ["pr", "diff", String(requireNumber(params)), "--repo", repository],
        format: "text",
        containsUntrustedContent: true,
      };
    case "checks":
      requireFirstPage(params, "pull-request checks");
      return {
        args: ["pr", "checks", String(requireNumber(params)), "--repo", repository, "--json", CHECK_FIELDS],
        format: "json",
        fields: CHECK_FIELDS.split(","),
        containsUntrustedContent: true,
      };
    case "files":
    case "reviews":
    case "comments": {
      const number = requireNumber(params);
      const suffix = params.operation === "comments" ? "comments" : params.operation;
      const metadataFields = params.operation === "reviews" ? REVIEW_METADATA_FIELDS : COMMENT_METADATA_FIELDS;
      const fields = params.operation === "files"
        ? FILE_FIELDS
        : params.includeBody
          ? [...metadataFields, "body"]
          : metadataFields;
      return {
        args: ["api", "--hostname", "github.com", "--method", "GET", apiPath(`repos/${repository}/pulls/${number}/${suffix}`, { per_page: limit, page })],
        format: "json",
        fields,
        containsUntrustedContent: true,
      };
    }
    default:
      throw new Error(`unsupported pull-request operation: ${params.operation}`);
  }
}
