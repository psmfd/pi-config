---
description: Require an approved implementation plan before any code changes are made
---

# Plan Before Code

Before writing, editing, or deleting any code or configuration:

- **Create an implementation plan** and present it to the user for review.
- The plan must include: what files will be changed, what the changes are, and why.
- **Wait for explicit user approval** before making any modifications.
- If the user requests changes to the plan, revise and re-present for approval.
- Trivial clarifications or questions do not require a plan — only actions that modify files.
- Reading, searching, and exploring code to inform the plan is always permitted without approval.
- **Sub-agent exception:** when an orchestrator parent has already received plan approval and delegates implementation to a subagent via the `subagent` tool, the subagent should proceed directly with implementation. Do not re-present the plan for approval — the parent's approval covers delegated work.
