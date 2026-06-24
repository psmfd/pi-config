# Azure DevOps Boards — `az` CLI Reference

## Create a work item (az CLI)

```bash
# Setup
az extension add --name azure-devops
az devops configure --defaults organization=https://dev.azure.com/myorg project=MyProject
export AZURE_DEVOPS_EXT_PAT=<PAT>

# Minimal
az boards work-item create --title "Add rate limiting" --type "User Story"

# With area, iteration, common fields
az boards work-item create \
  --title "Add rate limiting" \
  --type "User Story" \
  --area "Contoso\Backend" \
  --iteration "Contoso\Sprint 4" \
  --assigned-to "jamal@contoso.com" \
  --description "<p>As an API consumer...</p>" \
  --fields "Microsoft.VSTS.Scheduling.StoryPoints=5" \
           "Microsoft.VSTS.Common.Priority=2" \
           "System.Tags=api; ratelimit"

# Bug with severity
az boards work-item create \
  --title "Login fails on Safari" \
  --type "Bug" \
  --fields "Microsoft.VSTS.Common.Severity=2 - High" \
           "Microsoft.VSTS.TCM.ReproSteps=<ol><li>Open Safari</li></ol>"
```

CLI gotchas:

- `--fields` takes space-separated `"Field=Value"` pairs. Always use REFERENCE NAMES — `Story Points=5` (friendly name) is unreliable across CLI versions.
- `--area` / `--iteration` use short form (no project prefix); REST requires full path (with project prefix).
- `--type` is case-sensitive and must match exact display name including spaces: `"Product Backlog Item"`, not `"PBI"`.
- No native batch-create — loop in shell or use REST `POST /_apis/wit/workitemsbatch`.

## Update fields (az CLI)

```bash
az boards work-item update \
  --id 4872 \
  --state "Active" \
  --fields "Microsoft.VSTS.Scheduling.RemainingWork=3"
```

## Add a parent relation

`az boards work-item create` does NOT support relation creation via flags. Use the `relation` subcommand:

```bash
az boards work-item relation add \
  --id 4872 \
  --relation-type parent \
  --target-id 1023

# Discover supported relation types
az boards work-item relation list-type
```

## WIQL queries

```sql
SELECT [System.Id], [System.Title], [System.State], [System.Tags]
FROM workitems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] = 'Bug'
  AND [System.State] <> 'Closed'
  AND [System.Tags] CONTAINS 'blocker'
ORDER BY [System.ChangedDate] DESC
```

```bash
az boards query --wiql "SELECT [System.Id], [System.Title] FROM workitems WHERE [System.State] = 'Active'"
```

## Tags

Flat, organization-wide vocabulary. No hierarchy, no enforcement.

- Format in `System.Tags`: semicolon-separated string
- Casing: case-insensitive matching, first-used casing preserved in display
- Convention: lowercase hyphenated (`api-gateway`, `sprint-22`, `needs-review`)
- WIQL filter: `[System.Tags] CONTAINS 'blocked'`
