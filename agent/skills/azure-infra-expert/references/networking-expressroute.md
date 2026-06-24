# Networking — ExpressRoute and Private Link

## ExpressRoute Peering Types

| Peering | Traffic |
|---|---|
| **Private Peering** | To/from your Azure VNets — the most common enterprise case |
| **Microsoft Peering** | To Azure PaaS services over their public IPs (Storage public endpoints, etc.) |
| Public Peering (deprecated) | Legacy equivalent of Microsoft Peering |

## Reaching Private Endpoints from On-Prem via ExpressRoute

A Private Endpoint is accessible from on-prem only when:

1. ExpressRoute Private Peering (or site-to-site VPN) is connected to the VNet that contains (or is peered to) the Private Endpoint
2. On-prem DNS resolves the service's public FQDN to the Private Endpoint's **private IP** — requires a DNS forwarder in Azure (Private DNS Resolver inbound endpoint, or a DNS VM) that on-prem servers can conditional-forward to

Private Endpoints do **not** advertise their private IPs over Microsoft Peering — traffic lands on the private IP via Private Peering only.

## ExpressRoute FastPath

FastPath bypasses the ExpressRoute Gateway data path for higher throughput and lower latency. Constraints:

- Requires Ultra Performance or ErGw3AZ gateway SKU
- FastPath + VNet Peering was initially unsupported, then added (verify current status on Microsoft Learn for your deployment)
- Private Endpoints + FastPath have historically had support caveats — always verify against current docs before designing around FastPath

## Private Link Service (reverse of Private Endpoint)

A **Private Link Service** is how you expose **your own service** (behind a Standard Load Balancer) to consumers via their Private Endpoints. Used by SaaS vendors or internal platform teams to offer private connectivity without VNet peering.

## First-party entry points

- ExpressRoute overview: `learn.microsoft.com/azure/expressroute/expressroute-introduction`
- Private Link for ExpressRoute: `learn.microsoft.com/azure/private-link/private-link-faq` (resolution patterns)
- FastPath: `learn.microsoft.com/azure/expressroute/about-fastpath`
