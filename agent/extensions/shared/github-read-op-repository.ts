import type { FieldSpec, GithubReadParams, OperationPlan } from "./github-read-types.ts";
import { apiPath, requireFirstPage, resultLimit, resultPage, validateRef, validateRepository } from "./github-read-validation.ts";

const REPO_FIELDS = "nameWithOwner,description,homepageUrl,url,visibility,isArchived,isFork,defaultBranchRef,createdAt,updatedAt,owner,licenseInfo,repositoryTopics";
const RELEASE_FIELDS = "tagName,name,isDraft,isPrerelease,publishedAt,createdAt,targetCommitish,url";

const API_SPECS: Record<string, FieldSpec> = {
  branches: ["name", "protected", ["commit", ["sha", "url"]], ["protection", ["enabled", "required_status_checks"]]],
  commits: ["sha", "html_url", ["commit", ["message", ["author", ["name", "email", "date"]], ["committer", ["name", "email", "date"]]]], ["author", ["login", "id", "html_url"]], ["committer", ["login", "id", "html_url"]], ["parents", ["sha", "html_url"]]],
  tags: ["name", "zipball_url", "tarball_url", ["commit", ["sha", "url"]]],
  rulesets: ["id", "name", "target", "source_type", "source", "enforcement", "node_id", "created_at", "updated_at", "_links", "conditions", "rules", "bypass_actors"],
};

export const REPOSITORY_OPERATIONS = ["view", "branches", "commits", "tags", "releases", "rulesets"] as const;

export function buildRepositoryPlan(params: GithubReadParams): OperationPlan {
  const repository = validateRepository(params.repository);
  const limit = resultLimit(params);
  const page = resultPage(params);
  switch (params.operation) {
    case "view":
      requireFirstPage(params, "repository view");
      return {
        args: ["repo", "view", repository, "--json", REPO_FIELDS],
        format: "json",
        fields: REPO_FIELDS.split(","),
        containsUntrustedContent: true,
      };
    case "branches":
    case "tags":
    case "rulesets":
      return {
        args: ["api", "--hostname", "github.com", "--method", "GET", apiPath(`repos/${repository}/${params.operation}`, { per_page: limit, page })],
        format: "json",
        fields: API_SPECS[params.operation],
        containsUntrustedContent: true,
      };
    case "commits": {
      const ref = validateRef(params.ref);
      return {
        args: ["api", "--hostname", "github.com", "--method", "GET", apiPath(`repos/${repository}/commits`, { per_page: limit, page, sha: ref })],
        format: "json",
        fields: API_SPECS.commits,
        containsUntrustedContent: true,
      };
    }
    case "releases":
      requireFirstPage(params, "release list");
      return {
        args: ["release", "list", "--repo", repository, "--limit", String(limit), "--json", RELEASE_FIELDS],
        format: "json",
        fields: RELEASE_FIELDS.split(","),
        containsUntrustedContent: true,
      };
    default:
      throw new Error(`unsupported repository operation: ${params.operation}`);
  }
}
