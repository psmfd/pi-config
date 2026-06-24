# Platform Translation Reference

The two platforms have different schema models. Use this table to translate user intent across them.

| GitHub concept | Azure DevOps equivalent | Notes |
|---|---|---|
| Issue | Work item (User Story / Bug / Task / etc.) | GitHub has no enforced type — choose ADO type by intent |
| `enhancement` label | User Story / PBI / Requirement | Approximate — label is informal; ADO type is schema-enforced |
| `bug` label | Bug | Direct match in Agile / Scrum / CMMI; in Basic, Bug → Issue |
| Tasklist (`- [ ] #N`) | Parent / Child link (`Hierarchy-Forward`) | GitHub renders as checkbox; ADO links are first-class with relation types |
| Projects v2 `Parent issue` field | Hierarchy-Reverse link | Native parent in both, different representations |
| Milestone | Sprint / Iteration Path | ADO Iteration Paths are hierarchical, dated |
| Project v2 single-select field | Custom field (picklist) | ADO custom fields are organization-scoped; Project fields are project-scoped |
| Project v2 board view | Board (Kanban) | ADO boards are team-scoped with WIP limits and swimlanes |
| `p:now` / `p:soon` / `p:later` | `Microsoft.VSTS.Common.Priority` (1-4) | Conventional vs schema-enforced |
| `Closes #N` (PR body) | `AB#N` (commit message) | GitHub's auto-close keyword vs ADO's commit-to-work-item link |
| Repository | Project (in ADO terminology) | Different scoping models |
