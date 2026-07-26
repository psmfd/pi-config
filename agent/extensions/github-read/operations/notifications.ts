import type { FieldSpec, GithubReadParams, OperationPlan } from "../types.ts";
import { apiPath, requireFirstPage, resultLimit, resultPage, validateText } from "../validation.ts";

const NOTIFICATION_FIELDS: FieldSpec = ["id", "unread", "reason", "updated_at", "last_read_at", "url", "subscription_url", ["subject", ["title", "url", "latest_comment_url", "type"]], ["repository", ["id", "name", "full_name", "private", "html_url", ["owner", ["login", "id", "html_url"]]]]];

export const NOTIFICATION_OPERATIONS = ["list", "thread"] as const;

export function buildNotificationPlan(params: GithubReadParams): OperationPlan {
  const limit = resultLimit(params, 50);
  const page = resultPage(params);
  switch (params.operation) {
    case "list":
      return {
        args: ["api", "--hostname", "github.com", "--method", "GET", apiPath("notifications", { per_page: limit, page, all: "true" })],
        format: "json",
        fields: NOTIFICATION_FIELDS,
        containsUntrustedContent: true,
      };
    case "thread": {
      requireFirstPage(params, "notification thread");
      const threadId = validateText(params.threadId, "threadId", 32, true);
      if (!/^\d+$/.test(threadId ?? "")) throw new Error("threadId must contain digits only");
      return {
        args: ["api", "--hostname", "github.com", "--method", "GET", `notifications/threads/${threadId}`],
        format: "json",
        fields: NOTIFICATION_FIELDS,
        containsUntrustedContent: true,
      };
    }
    default:
      throw new Error(`unsupported notification operation: ${params.operation}`);
  }
}
