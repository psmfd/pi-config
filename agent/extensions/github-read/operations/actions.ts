import type { FieldSpec, GithubReadParams, OperationPlan } from "../types.ts";
import { apiPath, requireFirstPage, requireNumber, resultLimit, resultPage, validateRef, validateRepository } from "../validation.ts";

const WORKFLOW_FIELDS: FieldSpec = ["total_count", ["workflows", ["id", "node_id", "name", "path", "state", "created_at", "updated_at", "url", "html_url", "badge_url"]]];
const RUN_FIELDS: FieldSpec = ["total_count", ["workflow_runs", ["id", "name", "display_title", "event", "status", "conclusion", "workflow_id", "run_number", "run_attempt", "created_at", "updated_at", "run_started_at", "html_url", "head_branch", "head_sha", ["actor", ["login", "id", "html_url"]], "jobs_url", "artifacts_url", "cancel_url", "rerun_url"]]];
const SINGLE_RUN_FIELDS: FieldSpec = ["id", "name", "display_title", "event", "status", "conclusion", "workflow_id", "run_number", "run_attempt", "created_at", "updated_at", "run_started_at", "html_url", "head_branch", "head_sha", ["actor", ["login", "id", "html_url"]], "jobs_url", "artifacts_url"];
const JOB_FIELDS: FieldSpec = ["total_count", ["jobs", ["id", "run_id", "workflow_name", "head_branch", "head_sha", "status", "conclusion", "started_at", "completed_at", "name", "html_url", ["runner_group_name", []], ["steps", ["name", "status", "conclusion", "number", "started_at", "completed_at"]]]]];
const ARTIFACT_FIELDS: FieldSpec = ["total_count", ["artifacts", ["id", "node_id", "name", "size_in_bytes", "url", "archive_download_url", "expired", "created_at", "expires_at", "updated_at", ["workflow_run", ["id", "repository_id", "head_repository_id", "head_branch", "head_sha"]]]]];
const CHECK_FIELDS: FieldSpec = ["total_count", ["check_runs", ["id", "name", "head_sha", "status", "conclusion", "started_at", "completed_at", "html_url", "details_url", ["app", ["id", "slug", "name"]], ["output", ["annotations_count"]]]]];

export const ACTIONS_OPERATIONS = ["workflows", "runs", "run", "jobs", "artifacts", "checks"] as const;

export function buildActionsPlan(params: GithubReadParams): OperationPlan {
  const repository = validateRepository(params.repository);
  const limit = resultLimit(params);
  const page = resultPage(params);
  switch (params.operation) {
    case "workflows":
      return apiPlan(repository, "actions/workflows", limit, page, WORKFLOW_FIELDS);
    case "runs": {
      const ref = validateRef(params.ref);
      return apiPlan(repository, "actions/runs", limit, page, RUN_FIELDS, ref ? { branch: ref } : {});
    }
    case "run":
      requireFirstPage(params, "Actions run view");
      return apiPlan(repository, `actions/runs/${requireNumber(params)}`, limit, page, SINGLE_RUN_FIELDS, {}, false);
    case "jobs":
      return apiPlan(repository, `actions/runs/${requireNumber(params)}/jobs`, limit, page, JOB_FIELDS);
    case "artifacts":
      return apiPlan(repository, `actions/runs/${requireNumber(params)}/artifacts`, limit, page, ARTIFACT_FIELDS);
    case "checks": {
      const ref = validateRef(params.ref);
      if (!ref) throw new Error("checks requires ref");
      return apiPlan(repository, `commits/${ref}/check-runs`, limit, page, CHECK_FIELDS);
    }
    default:
      throw new Error(`unsupported Actions operation: ${params.operation}`);
  }
}

function apiPlan(
  repository: string,
  suffix: string,
  limit: number,
  page: number,
  fields: FieldSpec,
  extra: Record<string, string | number | undefined> = {},
  paginate = true,
): OperationPlan {
  return {
    args: ["api", "--hostname", "github.com", "--method", "GET", apiPath(`repos/${repository}/${suffix}`, paginate ? { per_page: limit, page, ...extra } : extra)],
    format: "json",
    fields,
    containsUntrustedContent: true,
  };
}
