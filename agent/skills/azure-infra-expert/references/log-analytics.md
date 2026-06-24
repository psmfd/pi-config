# Azure Monitor / Log Analytics Workspaces

## Workspace Design

| Strategy | When |
|---|---|
| **Single centralized workspace** | Unified query surface, single cost center, strong RBAC story via workspace-level roles |
| **Workspace per environment** (dev/test/prod) | Retention/cost differentiation, blast-radius reduction |
| **Workspace per business unit** | Ownership clarity, chargeback |
| **Workspace per region** | Data sovereignty/residency, avoidance of cross-region egress |

Cross-workspace queries are supported in KQL (`workspace("name").Table`), but RBAC must explicitly allow cross-workspace reads.

## Data Collection Rules (DCRs)

DCRs are the modern, recommended ingestion mechanism. They replace the legacy MMA (Microsoft Monitoring Agent) patterns:

| Pipeline | Status |
|---|---|
| Azure Monitor Agent (AMA) + DCRs | Current, preferred |
| MMA (Log Analytics Agent) | Retired August 2024; any remaining usage is unsupported |

A DCR defines **what** to collect (Windows Event Logs, syslog, performance counters, custom logs), **where from** (resource scope via Data Collection Rule Associations — DCRAs), and **where to send** (one or more Log Analytics workspaces, or other destinations like Azure Storage).

## Common Ingestion Paths

| Source | How it reaches the workspace |
|---|---|
| Azure resources (diagnostic settings) | Direct from Azure Resource Manager to workspace; no agent |
| VMs / Arc-connected servers | AMA + DCR |
| Application Insights (workspace-based) | Stored in the workspace; old "classic" App Insights is retired as of February 2024 |
| Custom logs | DCR with custom table definition; Logs Ingestion API for external sources |
| Microsoft Sentinel | Sentinel is a solution layered on a workspace; workspace must have Sentinel enabled |

## Retention and Archive

- **Interactive retention**: default 30 days, configurable per table, up to 730 days
- **Archive**: up to 12 years, lower cost, queries via async jobs (`search job`)
- Per-table retention is controlled via the workspace table settings (modern workspaces) — overrides workspace-level defaults

## Private Endpoints for Azure Monitor

Azure Monitor Private Link Scope (AMPLS) is the construct for routing Azure Monitor traffic over Private Link. A single AMPLS can be linked to multiple workspaces and App Insights components. Private endpoints are created against the AMPLS, not the workspace directly.

Private DNS zones required:

- `privatelink.monitor.azure.com`
- `privatelink.oms.opinsights.azure.com`
- `privatelink.ods.opinsights.azure.com`
- `privatelink.agentsvc.azure-automation.net`
- `privatelink.blob.core.windows.net` (for ingestion via blob)

## First-party entry points

- Log Analytics workspace design: `learn.microsoft.com/azure/azure-monitor/logs/workspace-design`
- Data Collection Rules: `learn.microsoft.com/azure/azure-monitor/essentials/data-collection-rule-overview`
- AMPLS: `learn.microsoft.com/azure/azure-monitor/logs/private-link-security`
