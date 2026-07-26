import type { FieldSpec, GithubReadParams, OperationPlan } from "../types.ts";
import { repositoryOwner, requireFirstPage, requireProjectNumber, resultLimit, validateRepository } from "../validation.ts";

const PROJECT_LIST_FIELDS: FieldSpec = ["totalCount", ["projects", ["id", "number", "title", "shortDescription", "public", "closed", "url", ["owner", ["login", "type"]], ["fields", ["totalCount"]], ["items", ["totalCount"]]]]];
const PROJECT_VIEW_FIELDS: FieldSpec = ["id", "number", "title", "shortDescription", "readme", "public", "closed", "url", ["owner", ["login", "type"]], ["fields", ["totalCount"]], ["items", ["totalCount"]]];
const PROJECT_FIELD_FIELDS: FieldSpec = ["totalCount", ["fields", ["id", "name", "type"]]];
const PROJECT_ITEM_FIELDS: FieldSpec = ["totalCount", ["items", ["id", "title", "type", "repository", "number", "url", "status", "labels", "assignees", "milestone", "linked pull requests"]]];

export const PROJECT_OPERATIONS = ["list", "view", "fields", "items"] as const;

export function buildProjectPlan(params: GithubReadParams): OperationPlan {
  const repository = validateRepository(params.repository);
  const owner = repositoryOwner(repository);
  const limit = resultLimit(params, 100);
  requireFirstPage(params, `Projects ${params.operation}`);
  switch (params.operation) {
    case "list":
      return projectPlan(["project", "list", "--owner", owner, "--limit", String(limit), "--format", "json"], PROJECT_LIST_FIELDS);
    case "view":
      return projectPlan(["project", "view", String(requireProjectNumber(params)), "--owner", owner, "--format", "json"], PROJECT_VIEW_FIELDS);
    case "fields":
      return projectPlan(["project", "field-list", String(requireProjectNumber(params)), "--owner", owner, "--limit", String(limit), "--format", "json"], PROJECT_FIELD_FIELDS);
    case "items":
      return projectPlan(["project", "item-list", String(requireProjectNumber(params)), "--owner", owner, "--limit", String(limit), "--format", "json"], PROJECT_ITEM_FIELDS);
    default:
      throw new Error(`unsupported Projects operation: ${params.operation}`);
  }
}

function projectPlan(args: readonly string[], fields: FieldSpec): OperationPlan {
  return {
    args,
    format: "json",
    fields,
    containsUntrustedContent: true,
  };
}
