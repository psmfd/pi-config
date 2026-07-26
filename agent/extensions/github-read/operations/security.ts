import type { FieldSpec, GithubReadParams, OperationPlan } from "../types.ts";
import { apiPath, resultLimit, resultPage, validateRepository, validateState } from "../validation.ts";

const CODE_SCANNING_FIELDS: FieldSpec = ["number", "created_at", "updated_at", "fixed_at", "dismissed_at", "dismissed_reason", "dismissed_comment", "state", "html_url", "most_recent_instance", ["rule", ["id", "severity", "description", "name", "security_severity_level", "tags"]], ["tool", ["name", "version", "guid"]]];
const DEPENDABOT_FIELDS: FieldSpec = ["number", "state", "dependency", "security_advisory", "security_vulnerability", "url", "html_url", "created_at", "updated_at", "dismissed_at", "dismissed_reason", "dismissed_comment", "fixed_at", "auto_dismissed_at"];
const SECRET_SCANNING_FIELDS: FieldSpec = ["number", "created_at", "updated_at", "url", "html_url", "locations_url", "state", "resolution", "resolved_at", "resolution_comment", "push_protection_bypassed", "push_protection_bypassed_at", "validity", "publicly_leaked", "multi_repo", "is_base64_encoded"];

export const SECURITY_OPERATIONS = ["code_scanning", "dependabot", "secret_scanning"] as const;

export function buildSecurityPlan(params: GithubReadParams): OperationPlan {
  const repository = validateRepository(params.repository);
  const limit = resultLimit(params, 50);
  const page = resultPage(params);
  let endpoint: string;
  let fields: FieldSpec;
  let allowedStates: readonly string[];
  switch (params.operation) {
    case "code_scanning":
      endpoint = "code-scanning/alerts";
      fields = CODE_SCANNING_FIELDS;
      allowedStates = ["open", "dismissed", "fixed", "all"];
      break;
    case "dependabot":
      endpoint = "dependabot/alerts";
      fields = DEPENDABOT_FIELDS;
      allowedStates = ["open", "dismissed", "fixed", "auto_dismissed", "all"];
      break;
    case "secret_scanning":
      endpoint = "secret-scanning/alerts";
      fields = SECRET_SCANNING_FIELDS;
      allowedStates = ["open", "resolved", "all"];
      break;
    default:
      throw new Error(`unsupported security operation: ${params.operation}`);
  }
  const state = validateState(params.state, allowedStates, `${params.operation} alerts`, "open");
  return {
    args: ["api", "--hostname", "github.com", "--method", "GET", apiPath(`repos/${repository}/${endpoint}`, { per_page: limit, page, state: state === "all" ? undefined : state })],
    format: "json",
    fields,
    containsUntrustedContent: true,
  };
}
