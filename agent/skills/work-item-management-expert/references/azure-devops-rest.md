# Azure DevOps Boards — REST and Schema Reference

## Process model and type sets

The four built-in process templates differ in available work item types and default fields:

| Type | Basic | Agile | Scrum | CMMI | Hierarchy parent | Effort field |
|---|---|---|---|---|---|---|
| Epic | Yes | Yes | Yes | Yes | (top) | derived |
| Feature | No | Yes | Yes | Yes | Epic | derived |
| User Story | No | Yes | No | No | Feature | `Microsoft.VSTS.Scheduling.StoryPoints` |
| Product Backlog Item (PBI) | No | No | Yes | No | Feature | `Microsoft.VSTS.Scheduling.Effort` |
| Requirement | No | No | No | Yes | Feature | `Microsoft.VSTS.Scheduling.Size` |
| Issue | Yes | No | No | Yes | Epic (Basic) | n/a |
| Task | Yes | Yes | Yes | Yes | Story / PBI / Requirement | `Microsoft.VSTS.Scheduling.OriginalEstimate` / `RemainingWork` |
| Bug | No | Yes | Yes | Yes | varies — see below | varies |
| Impediment | No | No | Yes | No | (standalone) | n/a |
| Risk | No | No | No | Yes | (standalone) | n/a |
| Change Request | No | No | No | Yes | Requirement | varies |

Process-specific differences to encode:

- **Basic** is available only on Azure DevOps Services and Server 2020+. Earlier on-premises must use Agile, Scrum, or CMMI.
- **Bug placement is process-configurable.** In Scrum, Bug is a peer of PBI on the product backlog and can appear on the sprint taskboard. In Agile, Bug is a task-level item by default but teams can configure it as a backlog item. In Basic, there is no Bug type — Issues fill that role. Configured via **Team Settings → Working with bugs**. Most common source of cross-process confusion.
- **Effort field varies by process.** Always use the reference name (`Microsoft.VSTS.Scheduling.StoryPoints` etc.), never the friendly name, in CLI `--fields` and REST JSON Patch operations.

## Type selection guide

| Use this type | When |
|---|---|
| Epic | Quarter / PI scope; product manager owned |
| Feature | PI / release scope; product owner owned |
| User Story / PBI / Requirement | Sprint scope; dev team owned; written from user perspective |
| Task | Hours within a sprint; dev individual owned; implementation work |
| Bug | Defect against existing functionality |
| Issue | Basic process catch-all; CMMI deviation tracking |
| Impediment | Scrum blocker; scrum master owned |
| Risk | CMMI risk register entry |
| Change Request | CMMI controlled change to a Requirement |

## Field schema

Field reference names follow namespace conventions:

- `System.*` — core system fields on every type (Title, AreaPath, IterationPath, State, Tags, AssignedTo, Description, etc.)
- `Microsoft.VSTS.Common.*` — shared common fields (Priority, Severity, AcceptanceCriteria, Activity, BusinessValue, TimeCriticality, Risk, ValueArea)
- `Microsoft.VSTS.Scheduling.*` — scheduling fields (StoryPoints, Effort, Size, OriginalEstimate, RemainingWork, CompletedWork, StartDate, FinishDate)
- `Microsoft.VSTS.TCM.*` — test/bug fields (ReproSteps, SystemInfo, Steps)
- `Microsoft.VSTS.Build.*` — build integration fields (FoundIn, IntegrationBuild)
- `Custom.*` — custom fields added via Inheritance process (e.g., `Custom.DevOpsTriage`)

### Required and recommended fields per type

**Always required:** `System.Title` (string, ≤ 255 chars). Type is determined by the URL `$type` segment, not the body.

**System-populated automatically (do NOT set at creation):** `System.Id`, `System.Rev`, `System.CreatedDate`, `System.CreatedBy`, `System.ChangedDate`, `System.ChangedBy`, `System.State` (defaults to first state in workflow), `System.Reason`, `System.TeamProject`. `System.AreaPath` and `System.IterationPath` default to project root if not supplied; should always be set explicitly.

**Recommended at creation:**

- All types: `System.AreaPath`, `System.IterationPath`, `System.Description` (HTML), `System.Tags`, `Microsoft.VSTS.Common.Priority` (1-4)
- Backlog items (Story / PBI / Requirement): `Microsoft.VSTS.Common.AcceptanceCriteria` (HTML), effort field per process (StoryPoints / Effort / Size), `System.AssignedTo`
- Bug: `Microsoft.VSTS.Common.Severity` (1-Critical, 2-High, 3-Medium, 4-Low), `Microsoft.VSTS.TCM.ReproSteps` (HTML), `Microsoft.VSTS.TCM.SystemInfo` (HTML), `Microsoft.VSTS.Build.FoundIn`
- Task: `System.AssignedTo`, `Microsoft.VSTS.Common.Activity` (Deployment / Design / Development / Documentation / Requirements / Testing), scheduling fields per process

## Field formatting rules

**HTML fields** — must contain well-formed HTML, no validation enforced by API:

- `System.Description`
- `Microsoft.VSTS.Common.AcceptanceCriteria`
- `Microsoft.VSTS.TCM.ReproSteps`
- `Microsoft.VSTS.TCM.SystemInfo`
- `System.History` (discussion comments)

The Analytics Service does not support reporting on HTML fields.

**Plain text:** Title, FoundIn, IntegrationBuild, Activity.

**Identity fields** (AssignedTo, ChangedBy, etc.):

- Display name: `Jamal Hartnett`
- UPN: `jamal@contoso.com`
- `@me` literal — works under OAuth, NOT under PAT auth

**Path fields** (AreaPath, IterationPath):

- Backslash-delimited, project name as root: `ProjectName\Area\SubArea`
- Project prefix is required for REST API
- Linux/Mac shell quoting: single-quote or double-backslash: `"ProjectName\\Sprint 1"`
- **CLI gotcha:** `az boards work-item create --area`/`--iteration` use the SHORT form WITHOUT the project prefix (the CLI prepends it). REST API requires the FULL path. This is the most common confusion when porting between CLI and REST.

**Tags** (`System.Tags`): semicolon-separated string `"frontend; performance; sprint-22"`. Casing preserved but matching is case-insensitive.

## State enum values per process

| State | Basic | Agile | Scrum | CMMI |
|---|---|---|---|---|
| Initial | To Do | New | New | Proposed |
| In progress | Doing | Active | Approved / Committed | Active |
| Resolved | — | Resolved | — | Resolved |
| Closed | Done | Closed | Done | Closed |
| Removed | — | Removed | Removed | — |

## Link types (relation reference names)

| Relation | `rel` value |
|---|---|
| Parent | `System.LinkTypes.Hierarchy-Reverse` |
| Child | `System.LinkTypes.Hierarchy-Forward` |
| Related | `System.LinkTypes.Related` |
| Tested By | `Microsoft.VSTS.Common.TestedBy-Forward` |
| Duplicate Of | `System.LinkTypes.Duplicate-Forward` |
| Successor | `System.LinkTypes.Dependency-Forward` |
| Predecessor | `System.LinkTypes.Dependency-Reverse` |

## Create a work item (REST)

```text
POST https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/${type}?api-version=7.1
Content-Type: application/json-patch+json
```

The `$` before `{type}` is a literal dollar sign in the URL — part of the routing syntax. Multi-word types are URL-encoded: `$User%20Story`, `$Product%20Backlog%20Item`, `$Bug`.

JSON Patch body — operations are `add` for creation or first-time field set, `replace` for updating an existing value:

```json
[
  { "op": "add", "path": "/fields/System.Title", "value": "Implement login endpoint" },
  { "op": "add", "path": "/fields/System.AreaPath", "value": "Contoso\\Backend" },
  { "op": "add", "path": "/fields/System.IterationPath", "value": "Contoso\\Sprint 4" },
  { "op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": 2 },
  { "op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.StoryPoints", "value": 5 },
  { "op": "add", "path": "/fields/System.Description", "value": "<p>As a user I want...</p>" },
  { "op": "add", "path": "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", "value": "<ul><li>Given...</li></ul>" }
]
```

Adding a parent relation at creation:

```json
{
  "op": "add",
  "path": "/relations/-",
  "value": {
    "rel": "System.LinkTypes.Hierarchy-Reverse",
    "url": "https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{parentId}",
    "attributes": { "comment": "" }
  }
}
```
