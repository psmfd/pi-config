import assert from "node:assert/strict";
import { test } from "node:test";

import { registerGithubRead } from "../index.ts";

interface Tool {
  name: string;
  execute: (id: string, params: { domains: ("repository" | "security")[] }) => Promise<unknown>;
}

function harness(initial: string[]) {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, () => void>();
  let active = [...initial];
  const pi = {
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    on(name: string, handler: () => void) { handlers.set(name, handler); },
    getActiveTools() { return [...active]; },
    setActiveTools(next: string[]) { active = [...next]; },
  };
  registerGithubRead(pi as never, () => Promise.resolve({ security: false, notifications: false }));
  return { tools, handlers, active: () => active };
}

test("registers loader and all seven domain tools", () => {
  const h = harness(["github_read"]);
  assert.deepEqual([...h.tools.keys()].sort(), [
    "github_actions_read", "github_issue_read", "github_notification_read",
    "github_pr_read", "github_project_read", "github_read", "github_repo_read",
    "github_security_read",
  ]);
});

test("session startup hides domain tools without granting omitted loader", () => {
  const h = harness(["read", "github_issue_read"]);
  h.handlers.get("session_start")?.();
  assert.deepEqual(h.active(), ["read"]);
});

test("loader additively activates requested default domains", async () => {
  const h = harness(["read", "github_read"]);
  const loader = h.tools.get("github_read");
  assert.ok(loader);
  await loader.execute("1", { domains: ["repository"] });
  assert.deepEqual(h.active(), ["read", "github_read", "github_repo_read"]);
});

test("loader refuses sensitive domains without user opt-in", async () => {
  const h = harness(["github_read"]);
  const loader = h.tools.get("github_read");
  assert.ok(loader);
  await assert.rejects(loader.execute("2", { domains: ["security"] }), /disabled domain/);
  assert.deepEqual(h.active(), ["github_read"]);
});
