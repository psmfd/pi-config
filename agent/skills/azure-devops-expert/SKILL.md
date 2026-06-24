---
name: azure-devops-expert
description: 'Azure DevOps reference for the azure-devops-expert subagent — Repos, YAML pipelines, environments, approvals, Boards/WIQL, REST API, service connections, az devops CLI.'
disable-model-invocation: true
---

# Azure DevOps Expert

Read-only reference for Azure DevOps guidance — git repository operations, YAML and classic pipelines, work item management, REST API patterns, and CLI usage.

## Source Authority Hierarchy

When providing guidance, rank sources in this order:

1. **First-party** — Microsoft Learn (`learn.microsoft.com/azure/devops/`), ADO REST API reference, ADO release notes
2. **Semi-official** — Microsoft DevBlogs, Azure DevOps Lab, Microsoft Q&A
3. **Community** — Stack Overflow, blog posts, GitHub discussions — supplement only, never sole authority
4. **Internal context** — expertise store (`azure` domain) and project-specific configuration

When first-party docs conflict with community sources, follow first-party and flag the discrepancy.

## Azure Repos

### Branch Policies

Branch policies are configured per-branch or per-branch-pattern via the Azure DevOps UI or REST API.

| Policy | Purpose | Key setting |
|---|---|---|
| Minimum reviewers | Require N approvals before merge | `minimumApproverCount`, `creatorVoteCounts` |
| Build validation | Require a pipeline to pass before merge | `buildDefinitionId`, `isBlocking` |
| Comment resolution | All comments must be resolved | `isBlocking: true` |
| Merge strategy | Restrict allowed merge types | `allowSquash`, `allowRebase`, `allowNoFastForward` |
| Work item linking | Require linked work items | `isBlocking: true` |
| Path filters | Apply policies only to specific paths | `pathFilters: ["/src/*"]` |

### Merge Strategies

| Strategy | ADO name | Result |
|---|---|---|
| Merge (no fast-forward) | `NoFastForward` | Merge commit, preserves branch topology |
| Squash | `Squash` | Single commit, linear history |
| Rebase | `Rebase` | Replays commits, linear history |
| Rebase + merge | `RebaseMerge` | Rebase then merge commit |

### Security Namespaces

Git permissions use the `Git Repositories` security namespace. Key permissions: `GenericRead`, `GenericContribute`, `ForcePush`, `CreateBranch`, `CreateTag`, `ManagePermissions`. Set via `az devops security permission` or REST API.

## YAML Pipelines

### Structure

```yaml
trigger:
  branches:
    include: [main, dev]
  paths:
    exclude: [docs/*, README.md]

pool:
  vmImage: 'ubuntu-latest'

variables:
  - group: my-variable-group
  - name: buildConfiguration
    value: 'Release'

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - task: DotNetCoreCLI@2
            inputs:
              command: 'build'
              projects: '**/*.csproj'

  - stage: Deploy
    dependsOn: Build
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
    jobs:
      - deployment: DeployProd
        environment: 'production'
        strategy:
          runOnce:
            deploy:
              steps:
                - script: echo Deploying
```

### Templates

**Step template** (`templates/build-steps.yml`):

```yaml
parameters:
  - name: buildConfiguration
    type: string
    default: 'Release'

steps:
  - task: DotNetCoreCLI@2
    inputs:
      command: 'build'
      arguments: '--configuration ${{ parameters.buildConfiguration }}'
```

**Stage template** (`templates/deploy-stage.yml`):

```yaml
parameters:
  - name: environment
    type: string

stages:
  - stage: Deploy_${{ parameters.environment }}
    jobs:
      - deployment: Deploy
        environment: ${{ parameters.environment }}
```

**Extends template** (enforces pipeline structure):

```yaml
# pipeline.yml
extends:
  template: templates/pipeline-template.yml
  parameters:
    buildConfiguration: 'Release'
```

### Expressions

| Syntax | Evaluation | Use |
|---|---|---|
| `${{ }}` | Compile-time | Template parameters, conditional insertion |
| `$[ ]` | Runtime | Variable assignment in `variables:` block |
| `$()` | Macro | Variable substitution in task inputs |

### Triggers

| Type | Key | Notes |
|---|---|---|
| CI trigger | `trigger:` | Branch/path include/exclude |
| PR trigger | `pr:` | Branch/path include/exclude, auto-cancel |
| Scheduled | `schedules:` | Cron syntax, `always: true` to run even without changes |
| Pipeline resource | `resources: pipelines:` | Trigger on completion of another pipeline |
| Repository resource | `resources: repositories:` | Reference external repos for templates |

### Service Connections

Service connections provide authenticated access to external services. Created in Project Settings > Service Connections.

| Type | Use |
|---|---|
| Azure Resource Manager | Azure resource deployments |
| Docker Registry | Container image push/pull |
| Kubernetes | Cluster deployments |
| Generic | Custom service endpoint |
| GitHub | Cross-platform repo access |

Reference in YAML: `azureSubscription: 'my-service-connection'` or `dockerRegistryServiceConnection: 'my-registry'`.

### Environments and Approvals

Environments define deployment targets with approval and check gates:

- **Approvals** — require named users/groups to approve before deployment proceeds
- **Branch control** — restrict which branches can deploy to an environment
- **Business hours** — limit deployments to specific time windows
- **Exclusive lock** — prevent concurrent deployments to the same environment
- **Template check** — require pipelines to extend from an approved template

### Caching and Artifacts

```yaml
- task: Cache@2
  inputs:
    key: 'nuget | "$(Agent.OS)" | **/packages.lock.json'
    restoreKeys: |
      nuget | "$(Agent.OS)"
    path: $(UserProfile)/.nuget/packages

- task: PublishBuildArtifacts@1
  inputs:
    pathToPublish: '$(Build.ArtifactStagingDirectory)'
    artifactName: 'drop'
```

### Task Versioning

Tasks use `TaskName@Version` syntax (e.g., `DotNetCoreCLI@2`). Major version bumps may introduce breaking changes. Pin to major version, monitor deprecation notices in pipeline logs.

## Classic Release Pipelines

Classic release pipelines are the legacy deployment model. They are still supported but Microsoft recommends migrating to YAML multi-stage pipelines.

### Structure

- **Release definition** — contains artifacts, stages, and variables
- **Artifacts** — build outputs, Git repos, or external sources that trigger releases
- **Stages** — sequential or parallel deployment targets, each with agent jobs and tasks
- **Pre/post-deployment conditions** — approvals, gates (Azure Monitor, REST API health checks), and schedules

### Migration to YAML

Key differences when migrating:

| Classic concept | YAML equivalent |
|---|---|
| Release definition | Multi-stage pipeline |
| Artifact trigger | Pipeline resource trigger |
| Stage | `stage:` with `deployment` job |
| Environment gates | Environment checks and approvals |
| Variable scoping (per-stage) | Stage-level `variables:` |
| Approval workflow | Environment approvals |

## Work Item Management

### Work Item Types by Process

| Process | Types |
|---|---|
| Agile | Epic, Feature, User Story, Task, Bug |
| Scrum | Epic, Feature, Product Backlog Item, Task, Bug, Impediment |
| CMMI | Epic, Feature, Requirement, Task, Bug, Change Request, Issue, Review, Risk |

### WIQL (Work Item Query Language)

```sql
SELECT [System.Id], [System.Title], [System.State]
FROM workitems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] = 'Bug'
  AND [System.State] <> 'Closed'
  AND [System.AssignedTo] = @me
ORDER BY [Microsoft.VSTS.Common.Priority] ASC
```

WIQL uses SQL-like syntax but only supports `SELECT` and `FROM workitems` / `FROM workitemLinks`. No `JOIN`, `GROUP BY`, or subqueries.

### REST API Patterns

Base URL: `https://dev.azure.com/{organization}/{project}/_apis/`

| Operation | Method | Endpoint |
|---|---|---|
| Get work item | GET | `wit/workitems/{id}?api-version=7.1` |
| Create work item | POST | `wit/workitems/$Bug?api-version=7.1` (JSON Patch body) |
| Update work item | PATCH | `wit/workitems/{id}?api-version=7.1` (JSON Patch body) |
| List work items by query | POST | `wit/wiql?api-version=7.1` |
| Bulk get | POST | `wit/workitemsbatch?api-version=7.1` |

Authentication: PAT via `Authorization: Basic base64(:PAT)` header. Continuation tokens via `x-ms-continuationtoken` header for paginated results.

### Board Configuration

- **Columns** map to work item states. Column WIP limits enforce flow constraints.
- **Swimlanes** provide horizontal categorization (e.g., Expedite, Standard).
- **Card rules** add visual indicators based on field values (color, icons).
- **Cumulative flow diagrams** track work-in-progress over time.

## az devops CLI

The `az devops` extension provides CLI access to Azure DevOps services.

### Setup

```bash
az extension add --name azure-devops
az devops configure --defaults organization=https://dev.azure.com/myorg project=myproject
az login  # or az devops login --token <PAT>
```

### Common Commands

| Command | Purpose |
|---|---|
| `az repos list` | List repositories |
| `az repos policy list` | List branch policies |
| `az repos pr create` | Create a pull request |
| `az repos pr list` | List pull requests |
| `az pipelines list` | List pipelines |
| `az pipelines run --id <id>` | Queue a pipeline run |
| `az pipelines variable-group list` | List variable groups |
| `az boards work-item create --type Bug` | Create a work item |
| `az boards work-item update --id <id>` | Update a work item |
| `az boards query --wiql "<WIQL>"` | Run a WIQL query |
| `az devops service-endpoint list` | List service connections |

### PAT Authentication

```bash
# Environment variable (preferred for CI)
export AZURE_DEVOPS_EXT_PAT=<PAT>

# Interactive login
echo <PAT> | az devops login
```

PAT scopes should follow least privilege. Common scopes: `vso.code` (repos read), `vso.code_write` (repos write), `vso.build_execute` (pipeline runs), `vso.work_write` (work items write).

## Cross-Cutting Concerns

### API Versioning

ADO REST API uses explicit version strings: `api-version=7.1`. Always specify the version. Preview APIs use `api-version=7.1-preview.1`. Preview APIs may change without notice.

### Predefined Variables

Key pipeline variables:

| Variable | Value |
|---|---|
| `$(Build.SourceBranch)` | Full ref (e.g., `refs/heads/main`) |
| `$(Build.SourceBranchName)` | Short name (e.g., `main`) |
| `$(Build.Repository.Name)` | Repository name |
| `$(Build.BuildId)` | Numeric build ID |
| `$(System.DefaultWorkingDirectory)` | Agent working directory |
| `$(Pipeline.Workspace)` | Pipeline workspace root |
| `$(Agent.OS)` | `Linux`, `Darwin`, or `Windows_NT` |

### Security Best Practices

- Store secrets in variable groups or pipeline variables marked as secret — never in YAML
- Use service connections instead of embedding credentials in pipeline steps
- Restrict pipeline access to service connections via pipeline permissions
- Use environment approvals for production deployments
- Enable audit logging for compliance tracking
