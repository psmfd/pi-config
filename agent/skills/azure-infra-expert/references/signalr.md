# Azure Managed SignalR

## Mode Selection

| Mode | Client connection | Server-side | Best for |
|---|---|---|---|
| **Default** | Direct to SignalR Service via hub SDK; server app connects as well | ASP.NET Core SignalR application mediates | Traditional hub-based apps, low-latency bidirectional messaging |
| **Serverless** | Direct to SignalR Service; upstream webhook invoked for events | No persistent server; upstream HTTP endpoint (e.g., Azure Function) handles events | Event-driven architectures, consumption pricing alignment |

**Pitfall:** mode change (Default ↔ Serverless) requires either reconfiguration or resource recreation depending on SDK usage. Confirm against current Microsoft Learn guidance before migrating a production workload.

## Scaling

- **Units**: 1-100 units per instance; each unit supports ~1,000 concurrent connections and ~1,000 messages/sec baseline. Actual throughput varies with message size and pattern.
- **Premium tier** supports zone redundancy and auto-scale; Standard tier is manually scaled; Free tier has hard caps for development only.

## Private Endpoint

- Private DNS zone: `privatelink.service.signalr.net`
- Public network access can be disabled entirely on Premium SKU
- Upstream URLs (for Serverless) called from SignalR to your backend still go over the public internet unless the backend itself is behind Private Link and SignalR is configured via a managed private endpoint

## First-party entry points

- Managed SignalR: `learn.microsoft.com/azure/azure-signalr`
- Service modes: `learn.microsoft.com/azure/azure-signalr/concept-service-mode`
- Private endpoint: `learn.microsoft.com/azure/azure-signalr/howto-private-endpoints`
