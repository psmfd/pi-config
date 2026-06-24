# Networking — Private Endpoints and DNS

## Private Endpoint Mechanics

A Private Endpoint is a NIC in your VNet with a private IP allocated from a subnet, mapped to a **Private Link resource** (a specific sub-resource of an Azure PaaS service — e.g., `blob`, `dfs`, `vault`). Traffic from within the VNet (and any peered or on-prem-connected networks) reaches the service over Microsoft backbone via the private IP.

Critical points:

- A single Azure service may require **multiple private endpoints** for full coverage (e.g., Storage account with ADLS Gen2 needs `blob` + `dfs`; SignalR Premium Standalone Replica needs separate endpoint per replica).
- Private endpoints are **regional** — the NIC lives in a specific region/VNet, but the target Private Link resource can be in a different region.
- Network Security Groups on the private endpoint subnet apply to private endpoint traffic only when `privateEndpointNetworkPolicies` is enabled on the subnet (default changed from disabled to enabled in recent API versions — verify for your deployment).

## Private DNS Zones per Azure Service

The fundamental requirement: client apps resolve the public FQDN (e.g., `mystorage.blob.core.windows.net`) to the **private IP** of the Private Endpoint. Azure Private DNS zones with the `privatelink.` prefix handle this via CNAME chaining.

| Service | Private DNS Zone |
|---|---|
| Blob storage | `privatelink.blob.core.windows.net` |
| File storage | `privatelink.file.core.windows.net` |
| ADLS Gen2 (DFS) | `privatelink.dfs.core.windows.net` |
| Table storage | `privatelink.table.core.windows.net` |
| Queue storage | `privatelink.queue.core.windows.net` |
| Static website | `privatelink.web.core.windows.net` |
| Key Vault | `privatelink.vaultcore.azure.net` |
| Azure SQL Database | `privatelink.database.windows.net` |
| Cosmos DB (SQL API) | `privatelink.documents.azure.com` |
| Managed SignalR | `privatelink.service.signalr.net` |
| App Service / Function | `privatelink.azurewebsites.net` |
| Azure Monitor | `privatelink.monitor.azure.com`, `privatelink.oms.opinsights.azure.com`, `privatelink.ods.opinsights.azure.com`, `privatelink.agentsvc.azure-automation.net`, `privatelink.blob.core.windows.net` |
| Container Registry | `privatelink.azurecr.io` |
| Service Bus | `privatelink.servicebus.windows.net` |
| Event Hubs | `privatelink.servicebus.windows.net` |

Always verify the current zone name against Microsoft Learn — zone names have been renamed for individual services (e.g., Cognitive Services consolidations).

## Linking a Private DNS Zone

Two distinct operations on a Private DNS zone:

| Operation | Effect |
|---|---|
| **Virtual network link** | VNet can resolve against this zone |
| **Registration enabled** (on VNet link) | VMs in the VNet auto-register A records (for `.internal.cloudapp.net` typically; almost never enabled for `privatelink.*` zones) |

A common misconfiguration: linking the zone to the wrong VNet in a hub-and-spoke, or forgetting to link to spokes that need resolution.

## Hub-and-Spoke DNS Patterns

Two dominant patterns:

| Pattern | How it works | Trade-offs |
|---|---|---|
| **Private DNS zones linked to hub + spokes** | Every VNet that needs resolution is linked to every zone | Simple; operationally heavy with many zones and many spokes |
| **Azure Private DNS Resolver in hub** | Centralized DNS resolution; spokes use custom DNS pointing at Resolver inbound IPs | Scales better; handles on-prem → Azure private endpoint name resolution via outbound endpoint |

For on-prem → Azure Private Endpoint resolution, Private DNS Resolver (inbound endpoint) or a DNS forwarder VM in the hub is required — **on-premises DNS servers cannot directly query Azure Private DNS zones**.

## Common DNS Pitfalls

- **Custom DNS override on VNet**: if the VNet has custom DNS servers configured, the Private DNS zone auto-resolution does not apply. The custom DNS must forward `privatelink.*` queries to 168.63.129.16 (Azure DNS) or to a Private DNS Resolver.
- **Private endpoint created before DNS zone linked**: the A record in the private DNS zone is created only if a `privateDnsZoneGroup` is configured on the private endpoint — otherwise you must create the A record manually.
- **Same FQDN in public and private DNS**: split-horizon DNS is not supported natively; the `privatelink.` prefix pattern is the workaround.
- **NSG on PE subnet blocking resolution**: outbound DNS (UDP/53 to 168.63.129.16) must be allowed.

## First-party entry points

- Private Endpoints overview: `learn.microsoft.com/azure/private-link/private-endpoint-overview`
- Private Endpoint DNS config: `learn.microsoft.com/azure/private-link/private-endpoint-dns`
- Private DNS Resolver: `learn.microsoft.com/azure/dns/dns-private-resolver-overview`
